import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { getDriver } from '../session/attach.js';
import { normalizeCommand } from '../flows/seedExec.js';
import { loadStateProfile, prepareStateProfile, teardownStateProfile, verifyStateProfile, type StateLedger, type StateProfile } from '../state/profile.js';
import type { FixtureSeed, FixtureSeedAction, Session, SessionStore } from '../session/store.js';

const schema = {
  sessionId: z.string(),
  profile: z.string().describe('State profile name under .swipium/state/<name>.yaml, or inline YAML.'),
};

const mutatingSchema = {
  ...schema,
  consentId: z.string().optional(),
  approve: z.boolean().optional(),
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function seedActionPreview(seed: FixtureSeedAction | undefined): Record<string, unknown> | null {
  if (!seed) return null;
  if (seed.type === 'script') {
    const normalized = normalizeCommand(seed.command);
    return {
      type: 'script',
      command: normalized.argv,
      deprecatedStringCommand: normalized.deprecated || undefined,
      parseError: normalized.parseError,
    };
  }
  if (seed.type === 'api') return { type: 'api', method: seed.method ?? 'POST', url: seed.url ?? null, bodyHash: seed.body ? hash(seed.body).slice(0, 16) : null, headerKeys: Object.keys(seed.headers ?? {}).sort() };
  return { type: 'deeplink', url: seed.url ?? null };
}

function seedPreview(seed: FixtureSeed | undefined): Record<string, unknown> | null {
  const preview = seedActionPreview(seed);
  if (!preview) return null;
  return { ...preview, idempotent: seed?.idempotent ?? false, cleanup: seedActionPreview(seed?.cleanup) };
}

function cleanupFixtures(session: Session | undefined, profile: StateProfile): string[] {
  if (!session) return [];
  return (profile.seed ?? [])
    .map((s) => s.fixture)
    .filter((name) => !!session.fixtures.find((f) => f.name === name)?.seed?.cleanup);
}

export function teardownMutations(profile: StateProfile, session?: Session): string[] {
  const explicit = (profile.teardown ?? [])
    .filter((t) => t === 'networkOnline' || (typeof t === 'object' && t.networkOnline))
    .map(() => 'networkOnline');
  return [...explicit, ...cleanupFixtures(session, profile).map((name) => `seedCleanup:${name}`)];
}

export function stateProfileAffects(session: Session, action: 'prepare' | 'verify' | 'teardown', profile: StateProfile, path?: string): Record<string, unknown> {
  const appId = profile.appId ?? session.appId ?? null;
  const seedFixtures = (profile.seed ?? []).map((s) => s.fixture);
  return {
    action,
    sessionId: session.id,
    profileName: profile.name,
    profilePath: path ?? null,
    profileHash: hash(profile),
    appId,
    reset: profile.reset ?? null,
    launch: profile.launch ?? null,
    seedFixtures,
    seedDetails: seedFixtures.map((name) => ({ fixture: name, seed: seedPreview(session.fixtures.find((f) => f.name === name)?.seed) })),
    teardownMutations: teardownMutations(profile, session),
  };
}

export function hasStateProfileMutation(action: 'prepare' | 'verify' | 'teardown', profile: StateProfile, session?: Session): boolean {
  if (action === 'verify') return false;
  if (action === 'teardown') return teardownMutations(profile, session).length > 0;
  return !!(
    (profile.reset?.android && profile.reset.android !== 'none') ||
    (profile.reset?.ios && profile.reset.ios !== 'none') ||
    profile.launch ||
    (profile.seed?.length ?? 0) > 0
  );
}

export function stateRisk(action: 'prepare' | 'verify' | 'teardown', profile: StateProfile, session: Session): 'low' | 'medium' | 'high' {
  if (profile.reset?.android === 'clearData' || profile.reset?.ios === 'reinstallApp' || profile.launch?.clearState) return 'high';
  const seedTypes = (profile.seed ?? []).map((s) => session.fixtures.find((f) => f.name === s.fixture)?.seed?.type);
  const cleanupTypes = action === 'teardown' ? (profile.seed ?? []).map((s) => session.fixtures.find((f) => f.name === s.fixture)?.seed?.cleanup?.type) : [];
  if (seedTypes.includes('script') || cleanupTypes.includes('script')) return 'high';
  if (seedTypes.includes('api') || cleanupTypes.includes('api') || profile.launch?.permissions || action === 'teardown') return 'medium';
  return 'low';
}

function stateFailureCode(status: StateLedger['status']): string {
  return status === 'state_refused' ? 'UNSAFE_ACTION_REFUSED' : 'SEED_FAILED';
}

export function registerState(server: McpServer, sessions: SessionStore): void {
  const handler = (action: 'prepare' | 'verify' | 'teardown') => async ({ sessionId, profile, consentId, approve }: { sessionId: string; profile: string; consentId?: string; approve?: boolean }) => {
    const session = sessions.get(sessionId);
    if (!session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
    const { driver } = await getDriver(session);
    if (!driver) return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Prepare a target first.'] });
    const loaded = loadStateProfile(session.root, profile);
    if (!loaded.profile) return qaError({ what: loaded.error ?? 'Could not load state profile', changedState: false, retrySafe: true, failureCode: 'INVALID_FLOW', nextSteps: ['Create .swipium/state/<name>.yaml or pass inline YAML.'] });

    const affects = stateProfileAffects(session, action, loaded.profile, loaded.path);
    const mutationPayloadHash = hash(affects);
    const mutating = hasStateProfileMutation(action, loaded.profile, session);
    const risk = stateRisk(action, loaded.profile, session);
    if (mutating) {
      const gate = consumeConsent(consentId, approve, { action: 'state_profile_mutation', affects });
      if (!gate.approved) {
        sessions.recordMutation(session, { tool: `qa_state_${action}`, action: 'state_profile_mutation', risk, target: affects, consent: { required: true, approved: false, payloadHash: mutationPayloadHash }, status: 'requested' });
        return requireConsent({
          action: 'state_profile_mutation',
          risk,
          exactCommand: `swipium state ${action} ${loaded.profile.name}`,
          affects,
          explain: `Apply state profile "${loaded.profile.name}" (${action})? This can mutate app/device state through reset, launch, permissions, seed, or teardown operations.`,
        });
      }
      sessions.recordMutation(session, { tool: `qa_state_${action}`, action: 'state_profile_mutation', risk, target: affects, consent: { required: true, consentId, approved: true, payloadHash: mutationPayloadHash }, status: 'approved' });
    }
    const ledger =
      action === 'prepare'
        ? await prepareStateProfile(sessions, session, driver, loaded.profile)
        : action === 'verify'
          ? await verifyStateProfile(driver, loaded.profile)
          : await teardownStateProfile(sessions, session, driver, loaded.profile);
    ledger.mutationPayloadHash = mutationPayloadHash;
    const uri = sessions.saveArtifact(session, 'state', `state-${action}-${loaded.profile.name}-${Date.now()}.json`, JSON.stringify(ledger, null, 2), 'application/json', `state ${action} ledger`);
    const ok = ledger.status !== 'state_refused' && ledger.status !== 'state_blocked';
    if (mutating) sessions.recordMutation(session, { tool: `qa_state_${action}`, action: 'state_profile_mutation', risk, target: affects, consent: { required: true, consentId, approved: true, payloadHash: mutationPayloadHash }, status: ok ? 'executed' : ledger.status === 'state_refused' ? 'refused' : 'blocked', ledgerUri: uri, detail: ledger.status });
    if (!ok) {
      return qaError(
        {
          what: `state ${action} ${loaded.profile.name}: ${ledger.status}`,
          changedState: mutating,
          retrySafe: ledger.status !== 'state_refused',
          failureCode: stateFailureCode(ledger.status),
          nextSteps: ['Open the state ledger artifact, fix the profile/reset/seed/device blocker, then retry.'],
        },
        { action, profile: loaded.profile.name, path: loaded.path ?? null, ledger, ledgerUri: uri, ok },
      );
    }
    return qaOk({ action, profile: loaded.profile.name, path: loaded.path ?? null, ledger, ledgerUri: uri, ok }, `state ${action} ${loaded.profile.name}: ${ledger.status}\nledger: ${uri}`);
  };

  server.registerTool('qa_state_prepare', {
    title: 'Prepare a reproducible state profile',
    description: 'Apply a .swipium/state/*.yaml profile as one transaction: reset policy, launch, seed fixtures, and ledger artifact. Refuses debug-bundle-loss resets unless explicitly acknowledged.',
    inputSchema: mutatingSchema,
  }, handler('prepare'));

  server.registerTool('qa_state_verify', {
    title: 'Verify a state profile',
    description: 'Verify a state profile using declared checks such as assertVisible. Failures are setup/state blockers, not app test failures.',
    inputSchema: schema,
  }, handler('verify'));

  server.registerTool('qa_state_teardown', {
    title: 'Teardown a state profile',
    description: 'Run state-profile teardown steps such as restoring networkOnline and write a transaction ledger.',
    inputSchema: mutatingSchema,
  }, handler('teardown'));
}
