// Suite generation service (Phase 3.2 Milestone C): generate POM files + test cases from a
// session's recorded actions, write them under .swipium/, and (optionally) compile them to runnable
// Flow V2. Shared by qa_generate target:"suite" and qa_test_this execute so the autopilot
// produces REAL files (not a note). Honest: when there are no recorded actions it returns a typed
// `skipped` result rather than pretending a suite was created.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generatePom, mergePomFile, type GeneratedFile, type PomResult } from '../suite/pom.js';
import { generateTestCases } from '../suite/testcase.js';
import { compileSuite, flowSlug, writeCompiledFlow } from '../suite/compile.js';
import { parseFlow } from '../flows/schema.js';
import { loadProjectConfig } from '../cli/scan.js';
import { readinessForSession, type ReadinessLabel } from '../report/readiness.js';
import type { RecordedAction, Session, SessionStore } from '../session/store.js';
import { recordedPlatform } from '../testSuite/generator.js';
import { assertNoSecretLeaks, findSecretLeaks, inputBindings, secretSafeNotes, structuralLiterals } from '../suite/secretGuard.js';

export interface CompiledFlowInfo {
  name: string;
  slug: string;
  ok: boolean;
  flowPath?: string;
  compiledPath?: string;
  errors: string[];
  /** The flows/ copy had hand edits and was kept; the new output is at newOutputPath. */
  keptEditedFlow?: boolean;
  newOutputPath?: string;
}

export interface SuiteGenerationResult {
  skipped: boolean;
  skippedReason?: string;
  recommendation?: string;
  name?: string;
  pages?: string[];
  written: string[];
  compiledFlows: CompiledFlowInfo[];
  suiteRunnable: boolean;
  readinessLabels: ReadinessLabel[];
  manifestPath?: string;
  audit?: PomResult['audit'];
  variables?: string[];
  testCases?: ReturnType<typeof generateTestCases>['cases'];
  /** Set when generation was refused (e.g. SECRET_IN_GENERATED_OUTPUT). Nothing was written. */
  failureCode?: string;
}

export function appIdOf(session: Session): string | undefined {
  return session.appId ?? (loadProjectConfig(session.root)?.appId as string | undefined) ?? undefined;
}

/** Write generated files under .swipium/, returning absolute paths written. */
export function writeSuiteFiles(session: Session, files: GeneratedFile[]): string[] {
  // Backstop: refuse to write ANY file that still carries a registered secret value.
  assertNoSecretLeaks(files, session.secrets, 'suite generation', { structural: structuralLiterals(session.recordedActions) });
  const base = join(session.root, '.swipium');
  const written: string[] = [];
  for (const f of files) {
    const abs = join(base, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    // merge into existing page objects / suite files instead of dropping what earlier suites use
    writeFileSync(abs, mergePomFile(f.path, existsSync(abs) ? readFileSync(abs, 'utf8') : undefined, f.content));
    written.push(abs);
  }
  return written;
}

/** The explorer's "back did not leave X; relaunching <appId> …" note (src/explore/runner.ts). */
const EXPLORER_RELAUNCH = /\brelaunching \S+ to continue from its first screen/;

/**
 * The session's recorded actions with the explorer's mid-run relaunches put back in as
 * `restart_app` steps (GOAL NEW-R5-3). The explorer relaunches the app when back does not leave a
 * screen and records only its taps, so a generated flow ran the next tap against the wrong screen.
 * A relaunch before the first action (the flow starts with a launch anyway) or after the last one
 * adds nothing and is dropped.
 */
export function actionsWithRelaunches(session: Pick<Session, 'recordedActions' | 'notes'>): RecordedAction[] {
  const actions = session.recordedActions;
  if (!actions.length) return actions;
  const relaunches = session.notes
    .filter((n) => n.workflow === 'guided_exploration' && EXPLORER_RELAUNCH.test(n.reason ?? ''))
    .map((n) => n.at);
  if (!relaunches.length) return actions;
  const out: RecordedAction[] = [];
  for (const a of actions) {
    const prev = out.at(-1);
    if (prev && prev.action !== 'restart_app' && relaunches.some((t) => t >= prev.at && t <= a.at))
      out.push({ at: a.at, action: 'restart_app', exportability: 'semantic' });
    out.push(a);
  }
  return out;
}

/** Build the POM (+ flowName) for a session's recorded actions. */
export function pomForSession(
  session: Session,
  name?: string,
  actions: RecordedAction[] = actionsWithRelaunches(session),
): { pom: PomResult; flowName: string } {
  const appId = appIdOf(session);
  const flowName = flowSlug(name ?? `${(appId ?? 'app').split('.').pop()}-smoke`);
  const pom = generatePom(actions, {
    name: flowName,
    appId,
    budgetProfile: session.budgetProfile,
    secrets: session.secrets,
    inputs: inputBindings(session), // typed text equal to a stored input maps to its ${SWIPIUM_TEST_*} placeholder
    platform: recordedPlatform(session),
  });
  return { pom, flowName };
}

export interface GenerateSuiteOptions {
  name?: string;
  actions?: RecordedAction[];
  save?: boolean; // write files (default true)
  compile?: boolean; // also compile to Flow V2 (default true)
}

/**
 * Generate (and optionally compile) a full suite from the session's recorded actions.
 * Returns `skipped:true` honestly when there is nothing to record.
 */
export function generateAndCompileSuite(sessions: SessionStore, session: Session, opts: GenerateSuiteOptions = {}): SuiteGenerationResult {
  const actions = opts.actions ?? actionsWithRelaunches(session);
  if (!actions.length) {
    return {
      skipped: true,
      skippedReason: 'no recorded actions',
      recommendation: 'Drive the app with qa_act, qa_smoke, or qa_explore so a suite can be recorded.',
      written: [],
      compiledFlows: [],
      suiteRunnable: false,
      readinessLabels: [],
    };
  }

  const save = opts.save ?? true;
  const compile = opts.compile ?? true;
  const { pom, flowName } = pomForSession(session, opts.name, actions);
  const tc = generateTestCases(pom, {
    appId: appIdOf(session),
    fixtures: session.fixtures,
    notes: secretSafeNotes(session.notes, session.secrets),
    budgetProfile: session.budgetProfile,
    platform: recordedPlatform(session),
  });

  const files: GeneratedFile[] = [
    ...pom.files,
    { path: `testcases/${flowName}.cases.yaml`, content: tc.yaml },
    { path: `testcases/${flowName}.cases.md`, content: tc.markdown },
  ];
  const leaks = findSecretLeaks(files, session.secrets, { structural: structuralLiterals(actions) });
  if (leaks.length) {
    return {
      skipped: true,
      failureCode: 'SECRET_IN_GENERATED_OUTPUT',
      skippedReason: `SECRET_IN_GENERATED_OUTPUT: a registered secret value would be written in plaintext (${leaks
        .slice(0, 5)
        .map((l) => `${l.path}:${l.line}`)
        .join(', ')}). Nothing was written`,
      recommendation: 'Re-record the credential step so it is captured as a ${VAR}, then regenerate.',
      written: [],
      compiledFlows: [],
      suiteRunnable: false,
      readinessLabels: [],
    };
  }
  const written = save ? writeSuiteFiles(session, files) : [];

  // Compile to runnable Flow V2 (needs the page objects on disk).
  const compiledFlows: CompiledFlowInfo[] = [];
  if (save && compile) {
    const result = compileSuite(session.root, 'suites/smoke.yaml');
    for (const f of result.flows) {
      const slug = flowSlug(f.name);
      const parse = f.yaml ? parseFlow(f.yaml) : { errors: ['empty'] as string[] };
      const ok = !!f.yaml && parse.errors.length === 0 && f.errors.length === 0;
      let flowPath: string | undefined;
      let compiledPath: string | undefined;
      let kept: string | undefined;
      if (ok) {
        // A hand-edited .swipium/flows/<slug>.yaml is kept; the new output goes to <slug>.yaml.new (SET-15).
        const w = writeCompiledFlow(session.root, slug, f.yaml);
        flowPath = w.flowPath;
        compiledPath = w.compiledPath;
        if (w.kept && w.newPath) kept = w.newPath;
        written.push(w.kept && w.newPath ? w.newPath : flowPath, compiledPath);
      }
      compiledFlows.push({
        name: f.name,
        slug,
        ok,
        flowPath,
        compiledPath,
        errors: [...f.errors, ...parse.errors],
        ...(kept ? { keptEditedFlow: true, newOutputPath: kept } : {}),
      });
    }
  }

  const suiteRunnable = compiledFlows.length > 0 && compiledFlows.every((c) => c.ok);
  const readinessLabels = readinessForSession(session, { suiteRunnable });
  if (!readinessLabels.includes('generated')) readinessLabels.push('generated');
  if (suiteRunnable && !readinessLabels.includes('compiled')) readinessLabels.push('compiled');
  let manifestPath: string | undefined;
  if (save) {
    manifestPath = join(session.root, '.swipium', 'suites', 'smoke.manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema: 'swipium.suite.manifest.v1',
          generatedAt: new Date(session.createdAt).toISOString(),
          name: flowName,
          suiteFile: 'suites/smoke.yaml',
          readinessLabels,
          suiteRunnable,
          compiledFlows: compiledFlows.map((f) => ({
            name: f.name,
            slug: f.slug,
            ok: f.ok,
            errors: f.errors,
            flowPath: f.flowPath ?? null,
            compiledPath: f.compiledPath ?? null,
          })),
          audit: pom.audit,
          variables: pom.variables,
        },
        null,
        2,
      ),
    );
    written.push(manifestPath);
  }
  return {
    skipped: false,
    name: flowName,
    pages: pom.pages.map((p) => p.name),
    written,
    compiledFlows,
    suiteRunnable,
    readinessLabels,
    manifestPath,
    audit: pom.audit,
    variables: pom.variables,
    testCases: tc.cases,
  };
}
