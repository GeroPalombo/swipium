// Persistent-suite store. The ONLY module here that does
// IO: it owns `.swipium/test-suite.json`, the per-functionality `.swipium/test-suite/<func>/<id>.yaml`
// mirror, and the `.swipium/test-runs/<runId>.json` ledger. Everything it persists is produced by the
// pure modules (schema/merge/generator/history) so the on-disk format is deterministic and testable.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import {
  type TestSuiteFile,
  type CanonicalTestCase,
  CASE_ID_RE,
  emptySuite,
  functionalityDirName,
  isSafeCaseId,
  validateSuite,
  TEST_SUITE_SCHEMA_VERSION,
} from './schema.js';
import { allocateId, mergeCases, type MergeOptions, type MergeResult } from './merge.js';
import { normalizeCase } from './generator.js';
import { buildRunLedger, type RunLedger } from './history.js';
import { withFileLock } from '../lib/lockfile.js';
import { assertNoSymlinkUnder, mkdirNoFollow, writeFileAtomicNoFollow, writeFileNoFollow } from '../lib/noFollowFs.js';

// Re-exported: callers outside the store (export) write through the same no-follow helper.
export { writeFileNoFollow };

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

/** A filesystem-safe run id from an ISO timestamp (no clock read here; caller passes `now`). */
export function runIdFromNow(now: string): string {
  return now.replace(/[:.]/g, '-');
}

/** Load the persistent suite, returning an empty suite when none exists yet. */
export function loadSuite(root: string, appId?: string): TestSuiteFile {
  return loadSuiteChecked(root, appId).suite;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Fill a hand-written or legacy case to the canonical shape (missing featureId, arrays, result,
 *  automation), keeping every well-typed field it has, so merge/export never crash on it. */
function repairLoadedCase(raw: Record<string, unknown>, at: string): CanonicalTestCase {
  const base = normalizeCase(
    {
      functionality: typeof raw.functionality === 'string' ? raw.functionality : undefined,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      featureId: typeof raw.featureId === 'string' && raw.featureId.trim() ? raw.featureId : undefined,
    },
    at,
  ) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    const want = base[k];
    if (Array.isArray(want) && !Array.isArray(v)) continue;
    if (isPlainObject(want) && !isPlainObject(v)) continue;
    if (typeof want === 'string' && typeof v !== 'string') continue;
    out[k] = isPlainObject(want) ? { ...want, ...v } : v;
  }
  out.steps = (out.steps as unknown[]).flatMap((s, i) => {
    const step: Record<string, unknown> | null = typeof s === 'string' ? { action: s } : isPlainObject(s) ? { ...s } : null;
    if (!step) return [];
    step.action = typeof step.action === 'string' ? step.action : String(step.action ?? '');
    if (step.target !== undefined && typeof step.target !== 'string') delete step.target;
    if (typeof step.index !== 'number') step.index = i + 1;
    return [step];
  });
  const ar = out.actualResult as Record<string, unknown>;
  if (!Array.isArray(ar.evidence)) ar.evidence = [];
  const au = out.automation as Record<string, unknown>;
  for (const k of ['pageObjects', 'testFiles']) if (!Array.isArray(au[k])) au[k] = [];
  return out as unknown as CanonicalTestCase;
}

/** loadSuite plus what it had to repair. A case id is a file name, so a stored id that is unsafe
 *  (`../../x`, a hand edit or a cloned repo) or duplicated gets a fresh TC id on read; the rename
 *  is persisted by the next save. Nothing downstream ever sees an unsafe id. */
export function loadSuiteChecked(root: string, appId?: string): { suite: TestSuiteFile; repairs: string[]; corrupt?: string } {
  const path = suiteJsonPath(root);
  if (!existsSync(path)) return { suite: emptySuite(appId), repairs: [] };
  const read = readSuiteJson(path);
  // Readers get an empty view of an unparseable file; writers (saveSuite/applyMerge) refuse it.
  if ('error' in read) return { suite: emptySuite(appId), repairs: [], corrupt: read.error };
  const parsed = read.value;
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString();
  const retiredIds = Array.isArray(parsed.retiredIds) ? parsed.retiredIds.filter(isSafeCaseId) : [];
  const repairs: string[] = [];
  const rawCases = (Array.isArray(parsed.cases) ? (parsed.cases as unknown[]) : []).filter(isPlainObject);
  const cases = rawCases.map((raw) => repairLoadedCase(raw, typeof raw.updatedAt === 'string' ? raw.updatedAt : updatedAt));
  const used = new Set<string>([...retiredIds, ...cases.map((c) => c.id).filter(isSafeCaseId)]);
  const kept = new Set<string>();
  for (const c of cases) {
    if (isSafeCaseId(c.id) && !kept.has(c.id)) {
      kept.add(c.id);
      continue;
    }
    const old = typeof c.id === 'string' ? c.id : String(c.id);
    c.id = allocateId(c.functionality, used);
    kept.add(c.id);
    repairs.push(
      `case id ${JSON.stringify(old.slice(0, 80))} ${isSafeCaseId(old) ? 'is a duplicate' : `is not a safe file name (must match ${CASE_ID_RE.source})`}; renamed to ${c.id}`,
    );
  }
  return {
    suite: { schemaVersion: TEST_SUITE_SCHEMA_VERSION, updatedAt, appId: parsed.appId ?? appId, cases, retiredIds },
    repairs,
  };
}

/** Parse test-suite.json. Anything but a JSON object is an error (never silently an empty suite). */
function readSuiteJson(path: string): { value: Partial<TestSuiteFile> } | { error: string } {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(v)) return { error: 'it is not a JSON object' };
    return { value: v as Partial<TestSuiteFile> };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The error a write raises instead of replacing an unparseable test-suite.json. It has no errno
 *  code on purpose: callers report it as bad suite data, not an unwritable disk. */
function corruptSuiteError(path: string, why: string): Error {
  return new Error(
    `${path} exists but does not parse (${why}); refusing to overwrite it. Fix the file, or move it aside to start a new suite`,
  );
}

function suiteLockPath(root: string): string {
  return join(suiteRoot(root), 'test-suite.lock');
}

/** Run a suite read-modify-write under the cross-process suite lock (not re-entrant). */
function withSuiteLock<T>(root: string, fn: () => T): T {
  mkdirNoFollow(root, suiteRoot(root)); // the lock dir's parent must exist (and not be a symlink)
  return withFileLock(suiteLockPath(root), fn);
}

/** Persist the suite JSON + the per-functionality YAML mirror. Returns absolute paths written.
 *  Locked; refuses to replace a test-suite.json that exists but does not parse. */
export function saveSuite(root: string, suite: TestSuiteFile): string[] {
  return withSuiteLock(root, () => saveSuiteUnlocked(root, suite));
}

function saveSuiteUnlocked(root: string, suite: TestSuiteFile): string[] {
  const jsonPath = suiteJsonPath(root);
  assertNoSymlinkUnder(root, jsonPath); // before reading it: a planted link is refused as a link
  if (existsSync(jsonPath)) {
    const current = readSuiteJson(jsonPath);
    if ('error' in current) throw corruptSuiteError(jsonPath, current.error);
  }
  const written: string[] = [];
  // Mirror first, JSON last: if a mirror write fails, test-suite.json still holds the previous
  // good suite instead of a case that breaks every later save.
  const casesRoot = resolve(suiteCasesDir(root));
  for (const c of suite.cases) {
    // The id is a file name: an unsafe one (a legacy or hand-edited suite) gets no mirror file
    // rather than a write outside cases/ or an ENAMETOOLONG; the JSON still holds the case.
    if (!isSafeCaseId(c.id)) continue;
    const dir = join(casesRoot, functionalityDirName(c.functionality));
    const yamlPath = resolve(dir, `${c.id}.yaml`);
    if (!yamlPath.startsWith(casesRoot + sep)) continue;
    writeFileNoFollow(root, yamlPath, stringify(c));
    written.push(yamlPath);
  }
  // Atomic: a crash mid-write never leaves a truncated test-suite.json.
  writeFileAtomicNoFollow(root, jsonPath, JSON.stringify(suite, null, 2));
  written.unshift(jsonPath);
  return written;
}

/** Append a per-run ledger file. Returns the absolute path written. */
export function recordRun(root: string, ledger: RunLedger): string {
  const dir = testRunsDir(root);
  const path = join(dir, `${runIdFromNow(ledger.at)}.json`);
  writeFileNoFollow(root, path, JSON.stringify(ledger, null, 2));
  return path;
}

export interface ApplyMergeResult {
  result: MergeResult;
  ledger: RunLedger;
  validationErrors: string[];
  written: string[];
  runPath: string;
  /** Load-time repairs (unsafe/duplicate stored ids renamed), persisted by this save. */
  loadRepairs: string[];
}

/**
 * Full disk round-trip: load > merge > validate > save > record run ledger. The single entry point
 * every integration hook (qa_test_this / report / explore / feature / ticket) calls so the suite is
 * updated consistently from one place. The whole cycle holds the cross-process suite lock, and a
 * test-suite.json that exists but does not parse makes it throw instead of starting over.
 */
export function applyMerge(root: string, incoming: CanonicalTestCase[], opts: MergeOptions, appId?: string): ApplyMergeResult {
  return withSuiteLock(root, () => applyMergeUnlocked(root, incoming, opts, appId));
}

function applyMergeUnlocked(root: string, incoming: CanonicalTestCase[], opts: MergeOptions, appId?: string): ApplyMergeResult {
  const { suite, repairs, corrupt } = loadSuiteChecked(root, appId);
  // Never merge into an empty stand-in for a file that exists but does not parse: that would
  // replace the user's whole suite with this run's cases.
  if (corrupt) throw corruptSuiteError(suiteJsonPath(root), corrupt);
  const result = mergeCases(suite, incoming, opts);
  const validationErrors = validateSuite(result.suite);
  const written = saveSuiteUnlocked(root, result.suite);
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
  return { result, ledger, validationErrors, written, runPath, loadRepairs: repairs };
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
