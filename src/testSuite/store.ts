// Persistent-suite store (SWIPIUM-REQ-06 "Suite Store Requirements"). The ONLY module here that does
// IO: it owns `.swipium/test-suite.json`, the per-functionality `.swipium/test-suite/<func>/<id>.yaml`
// mirror, and the `.swipium/test-runs/<runId>.json` ledger. Everything it persists is produced by the
// pure modules (schema/merge/generator/history) so the on-disk format is deterministic and testable.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  type TestSuiteFile,
  type CanonicalTestCase,
  emptySuite,
  functionalitySlug,
  validateSuite,
  TEST_SUITE_SCHEMA_VERSION,
} from './schema.js';
import { mergeCases, type MergeOptions, type MergeResult } from './merge.js';
import { buildRunLedger, type RunLedger } from './history.js';

export function suiteRoot(root: string): string {
  return join(root, '.swipium');
}
export function suiteJsonPath(root: string): string {
  return join(suiteRoot(root), 'test-suite.json');
}
export function suiteCasesDir(root: string): string {
  return join(suiteRoot(root), 'test-suite');
}
export function testRunsDir(root: string): string {
  return join(suiteRoot(root), 'test-runs');
}

/** Resource URI for the canonical suite of a session (mirrors the swipium:// artifact scheme). */
export function suiteResourceUri(sessionId: string): string {
  return `swipium://session/${sessionId}/test-suite/test-suite.json`;
}

/** A filesystem-safe run id from an ISO timestamp (no clock read here — caller passes `now`). */
export function runIdFromNow(now: string): string {
  return now.replace(/[:.]/g, '-');
}

/** Load the persistent suite, returning an empty suite when none exists yet. */
export function loadSuite(root: string, appId?: string): TestSuiteFile {
  const path = suiteJsonPath(root);
  if (!existsSync(path)) return emptySuite(appId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TestSuiteFile>;
    return {
      schemaVersion: TEST_SUITE_SCHEMA_VERSION,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      appId: parsed.appId ?? appId,
      cases: Array.isArray(parsed.cases) ? (parsed.cases as CanonicalTestCase[]) : [],
      retiredIds: Array.isArray(parsed.retiredIds) ? parsed.retiredIds : [],
    };
  } catch {
    return emptySuite(appId);
  }
}

/** Persist the suite JSON + the per-functionality YAML mirror. Returns absolute paths written. */
export function saveSuite(root: string, suite: TestSuiteFile): string[] {
  const written: string[] = [];
  const base = suiteRoot(root);
  mkdirSync(base, { recursive: true });
  const jsonPath = suiteJsonPath(root);
  writeFileSync(jsonPath, JSON.stringify(suite, null, 2));
  written.push(jsonPath);

  for (const c of suite.cases) {
    const dir = join(suiteCasesDir(root), functionalitySlug(c.functionality));
    mkdirSync(dir, { recursive: true });
    const yamlPath = join(dir, `${c.id}.yaml`);
    writeFileSync(yamlPath, stringify(c));
    written.push(yamlPath);
  }
  return written;
}

/** Append a per-run ledger file. Returns the absolute path written. */
export function recordRun(root: string, ledger: RunLedger): string {
  const dir = testRunsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runIdFromNow(ledger.at)}.json`);
  writeFileSync(path, JSON.stringify(ledger, null, 2));
  return path;
}

export interface ApplyMergeResult {
  result: MergeResult;
  ledger: RunLedger;
  validationErrors: string[];
  written: string[];
  runPath: string;
}

/**
 * Full disk round-trip: load → merge → validate → save → record run ledger. The single entry point
 * every integration hook (qa_test_this / report / explore / feature / ticket) calls so the suite is
 * updated consistently from one place.
 */
export function applyMerge(root: string, incoming: CanonicalTestCase[], opts: MergeOptions, appId?: string): ApplyMergeResult {
  const suite = loadSuite(root, appId);
  const result = mergeCases(suite, incoming, opts);
  const validationErrors = validateSuite(result.suite);
  const written = saveSuite(root, result.suite);
  const ledger = buildRunLedger(result.suite.cases, {
    runId: opts.runId,
    at: opts.now,
    source: opts.source,
    sourceUri: opts.sourceUri,
    created: result.created,
    updated: result.updated,
    deprecated: result.deprecated,
  });
  const runPath = recordRun(root, ledger);
  return { result, ledger, validationErrors, written, runPath };
}

/** A compact delta summary for embedding in reports / terminal output. */
export interface SuiteDelta {
  totalCases: number;
  created: string[];
  updated: string[];
  deprecated: string[];
  failed: string[];
  blocked: string[];
  newlyAutomated: string[];
}

export function suiteDelta(suite: TestSuiteFile, result: MergeResult): SuiteDelta {
  const touched = new Set([...result.created, ...result.updated]);
  const byId = new Map(suite.cases.map((c) => [c.id, c] as const));
  const failed: string[] = [];
  const blocked: string[] = [];
  const newlyAutomated: string[] = [];
  for (const id of touched) {
    const c = byId.get(id);
    if (!c) continue;
    if (c.actualResult.status === 'fail') failed.push(id);
    if (c.actualResult.status === 'blocked' || c.status === 'blocked') blocked.push(id);
    if (result.created.includes(id) ? c.automation.status === 'automated' || c.automation.status === 'partial' : false)
      newlyAutomated.push(id);
  }
  return {
    totalCases: suite.cases.length,
    created: result.created,
    updated: result.updated,
    deprecated: result.deprecated,
    failed,
    blocked,
    newlyAutomated,
  };
}
