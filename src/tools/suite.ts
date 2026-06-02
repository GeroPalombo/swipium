// qa_pom_generate / qa_suite_generate / qa_testcase_generate / qa_suite_lint (roadmap §6 / §7 / §12).
//
// These turn the actions recorded during a session (qa_act) into a MAINTAINABLE POM suite under
// .swipium/ — page objects (selectors), tests (reference elements by name), a suite, a test-case
// catalog, and a locator audit — and lint the result for brittle/coordinate-only locators.

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { generatePom, type GeneratedFile, type PomResult } from '../suite/pom.js';
import { generateTestCases } from '../suite/testcase.js';
import { lintSuitePages } from '../suite/lint.js';
import { compileSuite } from '../suite/compile.js';
import { parseFlow } from '../flows/schema.js';
import { runFlow } from '../flows/run.js';
import { loadProjectConfig } from '../cli/scan.js';
import { generateAndCompileSuite } from '../services/suiteGenerate.js';
import { getDriver } from '../session/attach.js';
import { readinessForSession } from '../report/readiness.js';
import { loadStateProfile, prepareStateProfile, teardownStateProfile, verifyStateProfile } from '../state/profile.js';
import { hasStateProfileMutation, stateProfileAffects, stateRisk } from './state.js';
import type { Session, SessionStore } from '../session/store.js';

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

function hashFile(path: string | undefined | null): string | null {
  if (!path) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function compiledFlowIdentity(c: { name: string; ok: boolean; flowPath?: string; compiledPath?: string; errors: string[] }): Record<string, unknown> {
  return {
    name: c.name,
    ok: c.ok,
    flowPath: c.flowPath ?? null,
    compiledPath: c.compiledPath ?? null,
    flowHash: hashFile(c.flowPath),
    compiledHash: hashFile(c.compiledPath),
    errors: c.errors,
  };
}

function appIdOf(session: Session): string | undefined {
  return session.appId ?? ((loadProjectConfig(session.root)?.appId as string | undefined) ?? undefined);
}

/** Map the replay outcome to the test-case catalog's replay status (Deliverable 4 — honest plumbing). */
function catalogReplayStatus(
  mode: string,
  results: Array<{ status: string }>,
  passed: boolean,
): 'not_replayed' | 'dry_run' | 'same_session' | 'fresh_state' | 'failed' | 'blocked' {
  if (mode === 'none' || results.length === 0) return 'not_replayed';
  if (results.some((r) => r.status === 'blocked')) return 'blocked';
  if (results.some((r) => r.status === 'failed')) return 'failed';
  if (!passed) return 'not_replayed';
  if (mode === 'dry_run') return 'dry_run';
  if (mode === 'same_session') return 'same_session';
  if (mode === 'fresh_state') return 'fresh_state';
  return 'not_replayed';
}

function suiteDir(session: Session): string {
  return join(session.root, '.swipium');
}

/** Write generated files under .swipium/, returning absolute paths written. */
function writeFiles(session: Session, files: GeneratedFile[]): string[] {
  const base = suiteDir(session);
  const written: string[] = [];
  for (const f of files) {
    const abs = join(base, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(abs);
  }
  return written;
}

function requireActions(session: Session): ReturnType<typeof qaError> | null {
  if (!session.recordedActions.length) {
    return qaError({
      what: 'No actions recorded in this session yet',
      changedState: false,
      retrySafe: true,
      nextSteps: ['Drive the app with qa_act first (each action is recorded), then regenerate the suite.'],
    });
  }
  return null;
}

function pomFor(session: Session, name?: string): { pom: PomResult; flowName: string } {
  const appId = appIdOf(session);
  const flowName = (name ?? `${(appId ?? 'app').split('.').pop()}-smoke`).replace(/[^\w.-]+/g, '-');
  const pom = generatePom(session.recordedActions, { name: flowName, appId, budgetProfile: session.budgetProfile });
  return { pom, flowName };
}

export function registerSuite(server: McpServer, sessions: SessionStore): void {
  // ---- qa_pom_generate ----
  server.registerTool(
    'qa_pom_generate',
    {
      title: 'Generate page objects',
      description:
        'Generate Screen/Page Object Model files from the actions recorded this session: one page object per screen with named elements (selectors hoisted out of tests), plus a locator audit (durable vs brittle, with app-code remediation). Pass save:true to write under .swipium/pages + .swipium/locators. Use qa_suite_generate for the full suite (pages + tests + suite + test cases).',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional(),
        save: z.boolean().optional(),
      },
    },
    async ({ sessionId, name, save }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      const noActions = requireActions(session);
      if (noActions) return noActions;

      const { pom } = pomFor(session, name);
      const pageFiles = pom.files.filter((f) => f.path.startsWith('pages/') || f.path.startsWith('locators/'));
      const written = save ? writeFiles(session, pageFiles) : [];
      const summary =
        `Generated ${pom.pages.length} page object(s): ${pom.pages.map((p) => p.name).join(', ')}\n` +
        `locator audit: ${pom.audit.durable} durable / ${pom.audit.semi} semi / ${pom.audit.brittle} brittle (${pom.audit.brittlePct}% brittle)` +
        (save ? `\nsaved ${written.length} files under .swipium/` : `\n(not saved — pass save:true)`);
      return qaOk({ pages: pom.pages, audit: pom.audit, files: pageFiles, written }, summary);
    },
  );

  // ---- qa_suite_generate ----
  server.registerTool(
    'qa_suite_generate',
    {
      title: 'Generate an automation suite',
      description:
        'Generate a full, committed-ready automation suite under .swipium/ from this session\'s recorded actions: page objects (pages/), a POM test (tests/), a suite (suites/), a test case catalog (testcases/), a locator audit (locators/), AND — unless compile:false — runnable Flow V2 compiled into flows/ + compiled/. Reports durability, brittle locators, and whether the suite is runnable. Pass save:false to preview without writing.',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional(),
        save: z.boolean().optional().describe('Write files under .swipium/ (default true).'),
        compile: z.boolean().optional().describe('Also compile to runnable Flow V2 (default true).'),
        replay: z.enum(['none', 'dry_run', 'same_session', 'fresh_state']).optional().describe('Replay gate: dry_run validates compiled flows; same_session executes compiled flows now; fresh_state requires a state profile and is reported as blocked when absent. Default dry_run.'),
        stateProfile: z.string().optional().describe('Required for replay:"fresh_state" so CI-ready means replay from declared state.'),
        consentId: z.string().optional().describe('Required when replay:"fresh_state" applies a mutating state profile.'),
        approve: z.boolean().optional().describe('Approve the exact fresh-state replay consent request.'),
      },
    },
    async ({ sessionId, name, save, compile, replay, stateProfile, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      const noActions = requireActions(session);
      if (noActions) return noActions;

      const res = generateAndCompileSuite(sessions, session, { name, save: save !== false, compile: compile !== false });
      const audit = res.audit!;
      const ranOk = res.compiledFlows.filter((c) => c.ok).length;
      const replayMode = replay ?? 'dry_run';
      const replayResults: Array<{ name: string; mode: string; status: 'passed' | 'failed' | 'blocked' | 'validated'; reason?: string }> = [];
      const replayEvidence: { stateProfile?: string; stateProfilePath?: string | null; stateLedgerUris: string[]; consentRequired: boolean; consentApproved: boolean } = {
        stateLedgerUris: [],
        consentRequired: false,
        consentApproved: false,
      };
      if (replayMode === 'dry_run') {
        for (const c of res.compiledFlows) replayResults.push({ name: c.name, mode: replayMode, status: c.ok ? 'validated' : 'failed', reason: c.errors.join('; ') || undefined });
      } else if (replayMode === 'same_session') {
        const { driver } = await getDriver(session);
        if (!driver) replayResults.push({ name: res.name ?? 'suite', mode: replayMode, status: 'blocked', reason: 'no driver attached for same-session replay' });
        else {
          for (const c of res.compiledFlows.filter((f) => f.ok && f.flowPath)) {
            const parsed = parseFlow(readFileSync(c.flowPath!, 'utf8'));
            if (!parsed.flow) {
              replayResults.push({ name: c.name, mode: replayMode, status: 'failed', reason: parsed.errors.join('; ') });
              continue;
            }
            const r = await runFlow(sessions, session, driver, parsed.flow, { variables: sessions.inputVariables(session) });
            replayResults.push({ name: c.name, mode: replayMode, status: r.passed ? 'passed' : 'failed', reason: r.reason });
          }
        }
      } else if (replayMode === 'fresh_state') {
        const { driver } = await getDriver(session);
        if (!stateProfile) replayResults.push({ name: res.name ?? 'suite', mode: replayMode, status: 'blocked', reason: 'stateProfile is required for fresh_state replay' });
        else if (!driver) replayResults.push({ name: res.name ?? 'suite', mode: replayMode, status: 'blocked', reason: 'no driver attached for fresh-state replay' });
        else {
          const loaded = loadStateProfile(session.root, stateProfile);
          if (!loaded.profile) replayResults.push({ name: res.name ?? 'suite', mode: replayMode, status: 'blocked', reason: loaded.error ?? 'could not load state profile' });
          else {
            replayEvidence.stateProfile = loaded.profile.name;
            replayEvidence.stateProfilePath = loaded.path ?? null;
            const mutatingProfile = hasStateProfileMutation('prepare', loaded.profile, session) || hasStateProfileMutation('teardown', loaded.profile, session);
            replayEvidence.consentRequired = mutatingProfile;
            let mutationPayloadHash: string | undefined;
            if (mutatingProfile) {
              const prepareAffects = stateProfileAffects(session, 'prepare', loaded.profile, loaded.path);
              const teardownAffects = stateProfileAffects(session, 'teardown', loaded.profile, loaded.path);
              const affects = {
                suite: res.name ?? 'suite',
                replayMode,
                compiledFlows: res.compiledFlows.map(compiledFlowIdentity),
                suiteManifestPath: res.manifestPath ?? null,
                suiteManifestHash: hashFile(res.manifestPath),
                statePrepare: prepareAffects,
                stateTeardown: teardownAffects,
              };
              mutationPayloadHash = hash(affects);
              const risk = stateRisk('prepare', loaded.profile, session) === 'high' || stateRisk('teardown', loaded.profile, session) === 'high'
                ? 'high'
                : stateRisk('prepare', loaded.profile, session) === 'medium' || stateRisk('teardown', loaded.profile, session) === 'medium'
                  ? 'medium'
                  : 'low';
              const gate = consumeConsent(consentId, approve, { action: 'suite_fresh_state_replay', affects });
              if (!gate.approved) {
                sessions.recordMutation(session, {
                  tool: 'qa_suite_generate',
                  action: 'suite_fresh_state_replay',
                  risk,
                  target: affects,
                  consent: { required: true, approved: false, payloadHash: mutationPayloadHash },
                  status: 'requested',
                });
                return requireConsent({
                  action: 'suite_fresh_state_replay',
                  risk,
                  exactCommand: `qa_suite_generate replay=fresh_state stateProfile=${loaded.profile.name}`,
                  affects,
                  explain: `Replay generated suite "${res.name ?? 'suite'}" from state profile "${loaded.profile.name}"? This can mutate app/device state through prepare/teardown before proving CI readiness.`,
                });
              }
              replayEvidence.consentApproved = true;
              sessions.recordMutation(session, {
                tool: 'qa_suite_generate',
                action: 'suite_fresh_state_replay',
                risk,
                target: affects,
                consent: { required: true, consentId, approved: true, payloadHash: mutationPayloadHash },
                status: 'approved',
              });
            }
            const ledgers: string[] = [];
            const saveLedger = (action: string, ledger: unknown) => {
              const uri = sessions.saveArtifact(session, 'state', `suite-${action}-${loaded.profile!.name}-${Date.now()}.json`, JSON.stringify(ledger, null, 2), 'application/json', `suite fresh-state ${action} ledger`);
              ledgers.push(uri);
              replayEvidence.stateLedgerUris.push(uri);
            };
            const prepared = await prepareStateProfile(sessions, session, driver, loaded.profile);
            saveLedger('prepare', prepared);
            if (prepared.status === 'state_refused' || prepared.status === 'state_blocked') {
              replayResults.push({ name: res.name ?? 'suite', mode: replayMode, status: 'blocked', reason: `state prepare ${prepared.status}; ledgers=${ledgers.join(',')}` });
            } else {
              const verified = await verifyStateProfile(driver, loaded.profile);
              saveLedger('verify', verified);
              if (verified.status === 'state_blocked') {
                replayResults.push({ name: res.name ?? 'suite', mode: replayMode, status: 'blocked', reason: `state verify blocked; ledgers=${ledgers.join(',')}` });
              } else {
                for (const c of res.compiledFlows.filter((f) => f.ok && f.flowPath)) {
                  const parsed = parseFlow(readFileSync(c.flowPath!, 'utf8'));
                  if (!parsed.flow) {
                    replayResults.push({ name: c.name, mode: replayMode, status: 'failed', reason: parsed.errors.join('; ') });
                    continue;
                  }
                  const r = await runFlow(sessions, session, driver, parsed.flow, { variables: sessions.inputVariables(session) });
                  replayResults.push({ name: c.name, mode: replayMode, status: r.passed ? 'passed' : 'failed', reason: r.reason });
                }
              }
            }
            const tornDown = await teardownStateProfile(sessions, session, driver, loaded.profile);
            saveLedger('teardown', tornDown);
            if (mutatingProfile) {
              const ok = replayResults.length > 0 && replayResults.every((r) => r.status === 'passed');
              sessions.recordMutation(session, {
                tool: 'qa_suite_generate',
                action: 'suite_fresh_state_replay',
                risk: stateRisk('prepare', loaded.profile, session),
                target: { stateProfile: loaded.profile.name, suite: res.name ?? 'suite', ledgerUris: ledgers },
                consent: { required: true, consentId, approved: true, payloadHash: mutationPayloadHash },
                status: ok ? 'executed' : 'blocked',
                ledgerUri: ledgers[0],
                detail: ok ? 'fresh_state replay passed' : 'fresh_state replay did not pass',
              });
            }
          }
        }
      }
      const replayPassed = replayResults.length > 0 && replayResults.every((r) => r.status === 'passed' || r.status === 'validated');
      const ciReadyGate = {
        compiled: res.suiteRunnable,
        freshStateReplay: replayMode === 'fresh_state' && replayResults.length > 0 && replayResults.every((r) => r.status === 'passed'),
        declaredStateProfile: replayMode === 'fresh_state' && !!stateProfile,
        stateEvidence: replayMode === 'fresh_state' && replayEvidence.stateLedgerUris.length >= 2,
        stableEvidence: replayMode === 'fresh_state' && replayResults.length > 0 && replayResults.every((r) => r.status === 'passed') && replayEvidence.stateLedgerUris.length >= 2,
      };
      const ciReady = Object.values(ciReadyGate).every(Boolean);
      const suiteReplayed = (replayMode === 'same_session' || replayMode === 'fresh_state') && replayPassed;
      const readinessLabels = readinessForSession(session, { suiteRunnable: res.suiteRunnable, suiteReplayed, ciReady });
      if (!readinessLabels.includes('generated')) readinessLabels.push('generated');
      if (res.suiteRunnable && !readinessLabels.includes('compiled')) readinessLabels.push('compiled');
      if (suiteReplayed && !readinessLabels.includes('replayed')) readinessLabels.push('replayed');
      if (ciReady && !readinessLabels.includes('ci_ready')) readinessLabels.push('ci_ready');
      const readiness = readinessLabels.at(-1) ?? 'generated';
      const written = res.manifestPath ? [...res.written] : res.written;
      if (res.manifestPath) {
        writeFileSync(res.manifestPath, JSON.stringify({
          schema: 'swipium.suite.manifest.v1',
          generatedAt: new Date(session.createdAt).toISOString(),
          name: res.name,
          suiteFile: 'suites/smoke.yaml',
          readinessLabels,
          readiness,
          suiteRunnable: res.suiteRunnable,
          replay: { mode: replayMode, results: replayResults, passed: replayPassed, evidence: replayEvidence },
          ciReady,
          ciReadyGate,
          compiledFlows: res.compiledFlows.map((f) => ({ name: f.name, slug: f.slug, ok: f.ok, errors: f.errors, flowPath: f.flowPath ?? null, compiledPath: f.compiledPath ?? null })),
          audit,
          variables: res.variables ?? [],
        }, null, 2));
      }
      // Plumb the ACTUAL replay outcome back into the written catalog (review item #5): the suite
      // service writes the catalog before replay (honest `not_replayed`); once we have a real replay
      // result, rewrite the YAML/MD so the committed test cases reflect proven replay status.
      let finalTestCases = res.testCases;
      if (res.manifestPath) {
        const replayStatus = catalogReplayStatus(replayMode, replayResults, replayPassed);
        if (replayStatus !== 'not_replayed') {
          const { pom, flowName } = pomFor(session, name);
          const tc = generateTestCases(pom, {
            appId: appIdOf(session),
            fixtures: session.fixtures,
            notes: session.notes,
            budgetProfile: session.budgetProfile,
            replayStatus,
          });
          writeFiles(session, [
            { path: `testcases/${flowName}.cases.yaml`, content: tc.yaml },
            { path: `testcases/${flowName}.cases.md`, content: tc.markdown },
          ]);
          finalTestCases = tc.cases;
        }
      }
      const summary =
        `✅ Suite "${res.name}" generated (${res.pages?.length ?? 0} pages, ${res.testCases?.length ?? 0} test case, suite + audit).\n` +
        `durability: ${audit.durable} durable / ${audit.semi} semi / ${audit.brittle} brittle (${audit.brittlePct}% brittle)` +
        (res.variables?.length ? `\nvariables: ${res.variables.join(', ')}` : '') +
        (audit.brittle ? `\n⚠ ${audit.brittle} brittle locator(s) — see locators/locator-audit.json for app-code fixes.` : '') +
        (written.length ? `\nwrote ${written.length} files under ${suiteDir(session)}` : `\n(preview — pass save:true to write)`) +
        (res.compiledFlows.length ? `\ncompiled ${ranOk}/${res.compiledFlows.length} runnable flow(s) → run: swipium suite run (or qa_flow_run).` : `\nNext: qa_suite_compile to produce runnable Flow V2.`) +
        `\nreplay gate (${replayMode}): ${replayPassed ? 'passed' : replayResults.length ? 'not proven' : 'not run'}; readiness=${readiness}; labels=${readinessLabels.join(' → ')}` +
        (ciReady ? '\nci_ready: compiled + fresh-state replay + state evidence proved' : replayMode === 'fresh_state' ? `\nci_ready missing: ${Object.entries(ciReadyGate).filter(([, ok]) => !ok).map(([k]) => k).join(', ') || 'none'}` : '');
      return qaOk(
        { name: res.name, pages: res.pages, audit, variables: res.variables, testCases: finalTestCases, written, manifestPath: res.manifestPath ?? null, compiledFlows: res.compiledFlows, suiteRunnable: res.suiteRunnable, replay: { mode: replayMode, results: replayResults, passed: replayPassed, evidence: replayEvidence }, readiness, readinessLabels, ciReady, ciReadyGate },
        summary,
      );
    },
  );

  // ---- qa_testcase_generate ----
  server.registerTool(
    'qa_testcase_generate',
    {
      title: 'Generate test case docs',
      description:
        'Generate an industry-style test case catalog (TC-xxx: purpose, priority, preconditions, steps, expected, automation status, known blockers, evidence) from this session\'s recorded actions + observed outcomes. Returns YAML + Markdown. Pass save:true to write under .swipium/testcases.',
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional(),
        format: z.enum(['yaml', 'markdown', 'both']).optional(),
        save: z.boolean().optional(),
      },
    },
    async ({ sessionId, name, format, save }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      const noActions = requireActions(session);
      if (noActions) return noActions;

      const { pom, flowName } = pomFor(session, name);
      const tc = generateTestCases(pom, { appId: appIdOf(session), fixtures: session.fixtures, notes: session.notes, budgetProfile: session.budgetProfile });
      const fmt = format ?? 'both';
      const files: GeneratedFile[] = [];
      if (fmt !== 'markdown') files.push({ path: `testcases/${flowName}.cases.yaml`, content: tc.yaml });
      if (fmt !== 'yaml') files.push({ path: `testcases/${flowName}.cases.md`, content: tc.markdown });
      const written = save ? writeFiles(session, files) : [];
      const summary = `Generated ${tc.cases.length} test case(s): ${tc.cases.map((c) => `${c.id} ${c.title}`).join('; ')}` + (written.length ? `\nsaved under .swipium/testcases` : '');
      return qaOk({ cases: tc.cases, yaml: fmt !== 'markdown' ? tc.yaml : undefined, markdown: fmt !== 'yaml' ? tc.markdown : undefined, written }, summary);
    },
  );

  // ---- qa_suite_compile ----
  server.registerTool(
    'qa_suite_compile',
    {
      title: 'Compile a POM suite to runnable flows',
      description:
        'Compile the generated POM suite (.swipium/suites/<suite>.yaml → its POM tests) into Flow V2 YAML that qa_flow_run and `swipium ci` can execute. Resolves page-object element refs to selectors, carries variables/secrets, and writes runnable flows to .swipium/flows/ (+ a readable copy under .swipium/compiled/). Validates each compiled flow through parseFlow and reports any errors. This is the step that makes a generated suite runnable, not just documentation.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        suite: z.string().optional().describe('Suite file relative to .swipium/ (default suites/smoke.yaml).'),
      },
    },
    async ({ sessionId, projectRoot, suite }) => {
      let root: string | undefined;
      if (sessionId) root = sessions.get(sessionId)?.root;
      root = root ?? projectRoot;
      if (!root) return qaError({ what: 'No project root', changedState: false, retrySafe: true, nextSteps: ['Pass sessionId or projectRoot.'] });

      const result = compileSuite(root, suite ?? 'suites/smoke.yaml');
      if (result.errors.length && result.flows.length === 0) {
        return qaError({ what: `Could not compile suite: ${result.errors.join('; ')}`, changedState: false, retrySafe: true, nextSteps: ['Generate a suite first: qa_suite_generate, then qa_suite_compile.'] });
      }

      const flowsDir = join(root, '.swipium', 'flows');
      const compiledDir = join(root, '.swipium', 'compiled');
      mkdirSync(flowsDir, { recursive: true });
      mkdirSync(compiledDir, { recursive: true });

      const compiled = result.flows.map((f) => {
        const slug = f.name.replace(/[^\w.-]+/g, '-');
        const parse = f.yaml ? parseFlow(f.yaml) : { errors: ['empty'] as string[] };
        const ok = !!f.yaml && parse.errors.length === 0 && f.errors.length === 0;
        let flowPath: string | undefined;
        let compiledPath: string | undefined;
        if (ok) {
          flowPath = join(flowsDir, `${slug}.yaml`); // discoverable by `swipium ci --flow <slug>`
          compiledPath = join(compiledDir, `${slug}.flow.yaml`);
          writeFileSync(flowPath, f.yaml);
          writeFileSync(compiledPath, f.yaml);
        }
        return { name: f.name, slug, ok, variables: f.variables, errors: [...f.errors, ...parse.errors], flowPath, compiledPath };
      });

      const okCount = compiled.filter((c) => c.ok).length;
      const summary =
        `Compiled ${okCount}/${compiled.length} flow(s) from ${result.suite}.\n` +
        compiled.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? ` → flows/${c.slug}.yaml (run: swipium ci --flow ${c.slug})` : `: ${c.errors.join('; ')}`}`).join('\n');
      return qaOk({ suite: result.suite, flows: compiled, okCount }, summary);
    },
  );

  // ---- qa_suite_lint ----
  server.registerTool(
    'qa_suite_lint',
    {
      title: 'Lint the generated suite',
      description:
        'Lint the page objects under .swipium/pages for durability problems: missing durable locators (coordinate-only), copy/locale-fragile text selectors, and dynamic-looking selectors. Reports each with the page/element and the app-code fix. Use after qa_suite_generate, before committing or wiring CI.',
      inputSchema: { sessionId: z.string().optional(), projectRoot: z.string().optional() },
    },
    async ({ sessionId, projectRoot }) => {
      let root: string | undefined;
      if (sessionId) root = sessions.get(sessionId)?.root;
      root = root ?? projectRoot;
      if (!root) return qaError({ what: 'No project root', changedState: false, retrySafe: true, nextSteps: ['Pass sessionId or projectRoot.'] });

      const findings = lintSuitePages(root);
      if (!findings.exists) {
        return qaError({ what: 'No .swipium/pages to lint', changedState: false, retrySafe: true, nextSteps: ['Generate a suite first: qa_suite_generate.'] });
      }
      const errors = findings.items.filter((f) => f.severity === 'error');
      const summary =
        `Linted ${findings.pageCount} page object(s): ${findings.items.length} issue(s) (${errors.length} brittle).\n` +
        (findings.items.length
          ? findings.items.slice(0, 20).map((i) => `  ${i.severity === 'error' ? '✗' : '⚠'} ${i.page}.${i.element}: ${i.message}`).join('\n')
          : '  ✓ all locators are durable.');
      return qaOk({ pageCount: findings.pageCount, items: findings.items }, summary);
    },
  );
}
