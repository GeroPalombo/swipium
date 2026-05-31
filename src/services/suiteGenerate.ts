// Suite generation service (Phase 3.2 Milestone C) — generate POM files + test cases from a
// session's recorded actions, write them under .swipium/, and (optionally) compile them to runnable
// Flow V2. Shared by qa_suite_generate and qa_test_this execute so the autopilot
// produces REAL files (not a note). Honest: when there are no recorded actions it returns a typed
// `skipped` result rather than pretending a suite was created.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generatePom, type GeneratedFile, type PomResult } from '../suite/pom.js';
import { generateTestCases } from '../suite/testcase.js';
import { compileSuite } from '../suite/compile.js';
import { parseFlow } from '../flows/schema.js';
import { loadProjectConfig } from '../cli/scan.js';
import { readinessForSession, type ReadinessLabel } from '../report/readiness.js';
import type { RecordedAction, Session, SessionStore } from '../session/store.js';

export interface CompiledFlowInfo {
  name: string;
  slug: string;
  ok: boolean;
  flowPath?: string;
  compiledPath?: string;
  errors: string[];
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
}

export function appIdOf(session: Session): string | undefined {
  return session.appId ?? ((loadProjectConfig(session.root)?.appId as string | undefined) ?? undefined);
}

/** Write generated files under .swipium/, returning absolute paths written. */
export function writeSuiteFiles(session: Session, files: GeneratedFile[]): string[] {
  const base = join(session.root, '.swipium');
  const written: string[] = [];
  for (const f of files) {
    const abs = join(base, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(abs);
  }
  return written;
}

/** Build the POM (+ flowName) for a session's recorded actions. */
export function pomForSession(session: Session, name?: string, actions: RecordedAction[] = session.recordedActions): { pom: PomResult; flowName: string } {
  const appId = appIdOf(session);
  const flowName = (name ?? `${(appId ?? 'app').split('.').pop()}-smoke`).replace(/[^\w.-]+/g, '-');
  const pom = generatePom(actions, { name: flowName, appId, budgetProfile: session.budgetProfile });
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
  const actions = opts.actions ?? session.recordedActions;
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
  const tc = generateTestCases(pom, { appId: appIdOf(session), fixtures: session.fixtures, notes: session.notes, budgetProfile: session.budgetProfile });

  const files: GeneratedFile[] = [
    ...pom.files,
    { path: `testcases/${flowName}.cases.yaml`, content: tc.yaml },
    { path: `testcases/${flowName}.cases.md`, content: tc.markdown },
  ];
  const written = save ? writeSuiteFiles(session, files) : [];

  // Compile to runnable Flow V2 (needs the page objects on disk).
  const compiledFlows: CompiledFlowInfo[] = [];
  if (save && compile) {
    const result = compileSuite(session.root, 'suites/smoke.yaml');
    const flowsDir = join(session.root, '.swipium', 'flows');
    const compiledDir = join(session.root, '.swipium', 'compiled');
    mkdirSync(flowsDir, { recursive: true });
    mkdirSync(compiledDir, { recursive: true });
    for (const f of result.flows) {
      const slug = f.name.replace(/[^\w.-]+/g, '-');
      const parse = f.yaml ? parseFlow(f.yaml) : { errors: ['empty'] as string[] };
      const ok = !!f.yaml && parse.errors.length === 0 && f.errors.length === 0;
      let flowPath: string | undefined;
      let compiledPath: string | undefined;
      if (ok) {
        flowPath = join(flowsDir, `${slug}.yaml`);
        compiledPath = join(compiledDir, `${slug}.flow.yaml`);
        writeFileSync(flowPath, f.yaml);
        writeFileSync(compiledPath, f.yaml);
        written.push(flowPath, compiledPath);
      }
      compiledFlows.push({ name: f.name, slug, ok, flowPath, compiledPath, errors: [...f.errors, ...parse.errors] });
    }
  }

  const suiteRunnable = compiledFlows.length > 0 && compiledFlows.every((c) => c.ok);
  const readinessLabels = readinessForSession(session, { suiteRunnable });
  if (!readinessLabels.includes('generated')) readinessLabels.push('generated');
  if (suiteRunnable && !readinessLabels.includes('compiled')) readinessLabels.push('compiled');
  let manifestPath: string | undefined;
  if (save) {
    manifestPath = join(session.root, '.swipium', 'suites', 'smoke.manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      schema: 'swipium.suite.manifest.v1',
      generatedAt: new Date(session.createdAt).toISOString(),
      name: flowName,
      suiteFile: 'suites/smoke.yaml',
      readinessLabels,
      suiteRunnable,
      compiledFlows: compiledFlows.map((f) => ({ name: f.name, slug: f.slug, ok: f.ok, errors: f.errors, flowPath: f.flowPath ?? null, compiledPath: f.compiledPath ?? null })),
      audit: pom.audit,
      variables: pom.variables,
    }, null, 2));
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
