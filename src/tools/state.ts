import { createHash } from 'node:crypto';
import { normalizeCommand } from '../flows/seedExec.js';
import type { StateProfile } from '../state/profile.js';
import type { FixtureSeed, FixtureSeedAction, Session } from '../session/store.js';

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
