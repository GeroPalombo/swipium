import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportData, ReportNote } from './export.js';
import { evidenceTaxonomyForNotes } from './evidence.js';

export interface ReportCompare {
  current: string;
  baseline: string;
  newFailures: string[];
  fixedFailures: string[];
  knownFlakyFailures: string[];
  flakeStatus: 'not_checked' | 'known_flaky' | 'not_flaky';
  changedScreenshots: { added: string[]; removed: string[] };
  changedOutcomes: Array<{ workflow: string; from: string; to: string }>;
  runtimeRegressionMs: number | null;
  failureCodeDelta: { current: string[]; baseline: string[] };
  summary: string;
}

export interface TrendSummary {
  reports: number;
  passRate: Record<string, number>;
  passRateByAppPlatformBackend: Record<string, number>;
  medianRuntimeMs: number | null;
  averageSetupMs: number | null;
  averageActiveMs: number | null;
  topFailureCodes: Array<{ code: string; count: number }>;
  topEnvironmentFailures: Array<{ kind: string; count: number }>;
  flakyFlows: string[];
  wdaReliability: { reports: number; reachable: number; ready: number };
  emulatorReliability: { reports: number; onlineAtEnd: number };
  locatorReadinessTrend: {
    visualOnlyRuns: number;
    coordinateOnlyWarnings: number;
    runsWithReadiness: number;
    latestDurablePct: number | null;
    averageDurablePct: number | null;
    minimumDurablePct: number | null;
    runs: Array<{ file: string; grade: string; durablePct: number; nativeOrDurablePct: number; totalActions: number; weakActions: number }>;
  };
  releaseGateSignals: TrendReleaseGateSignal[];
  confidenceCalibration: ConfidenceCalibrationSummary;
  slowestRuns: Array<{ file: string; totalMs: number }>;
  slowestSteps: Array<{ file: string; workflow: string; index: number; kind: string; summary?: string; durationMs: number }>;
}

export interface TrendReleaseGateSignal {
  level: 'block' | 'warn';
  code: 'REQUIRED_WORKFLOW_FAILED' | 'APP_ERROR' | 'VISUAL_ONLY_PASS' | 'GENERATED_SUITE_NOT_REPLAYED';
  count: number;
  policy: string;
  examples: string[];
}

export type ConfidenceCalibrationStatus = 'not_required' | 'insufficient_data' | 'calibrated' | 'needs_attention';
export type ProbabilisticEvidenceKind = 'ocr_locator' | 'visual_match' | 'ai_visual_evidence';

export interface ConfidenceCalibrationBucket {
  label: string;
  min: number;
  max: number;
  samples: number;
  passed: number;
  failed: number;
  unknown: number;
  averageConfidence: number | null;
  observedPassRate: number | null;
  calibrationError: number | null;
}

export interface ConfidenceCalibrationKindSummary {
  evidence: number;
  confidenceSamples: number;
  missingConfidence: number;
  outcomeSamples: number;
  passRate: number | null;
  averageConfidence: number | null;
  calibrationError: number | null;
}

export interface ConfidenceCalibrationSummary {
  schema: 'swipium.confidence.calibration.v1';
  status: ConfidenceCalibrationStatus;
  requiredCorpus: 'dogfood-nightly';
  reports: number;
  probabilisticEvidence: number;
  confidenceSamples: number;
  missingConfidence: number;
  outcomeSamples: number;
  passRate: number | null;
  averageConfidence: number | null;
  calibrationError: number | null;
  byEvidenceKind: Record<ProbabilisticEvidenceKind, ConfidenceCalibrationKindSummary>;
  buckets: ConfidenceCalibrationBucket[];
  warnings: string[];
  note: string;
}

export interface PrSummary {
  status: 'SHIP' | 'CAUTION' | 'BLOCK';
  classification:
    'clean' | 'new_app_regression' | 'known_flaky_flow' | 'new_environment_failure' | 'automation_readiness' | 'runtime_regression';
  reason: string;
  nativeHealth: string;
  appHealth: string;
  likelyCategory: string;
  evidence: string[];
  nextAction: string;
  comparison?: string;
  knownFlaky: boolean;
  text: string;
}

export function loadReport(path: string): ReportData {
  return JSON.parse(readFileSync(path, 'utf8')) as ReportData;
}

// ---- Legacy on-disk compatibility (pre-1.5.0 reports stored *Sec fields) ----
// History/trends read report.json files written by OLDER Swipium versions, so ms readers
// fall back to the legacy seconds fields and convert.

function legacySecAsMs(obj: unknown, secKey: string): number | null {
  const v = obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[secKey] : undefined;
  return typeof v === 'number' ? Math.round(v * 1000) : null;
}

/** phaseTimings.totalMs / setupMs / activeMs with legacy *Sec fallback. */
function timingMs(t: ReportData['phaseTimings'], msKey: 'totalMs' | 'setupMs' | 'activeMs'): number | null {
  const v = t?.[msKey];
  if (typeof v === 'number') return v;
  return legacySecAsMs(t, msKey.replace(/Ms$/, 'Sec'));
}

/** step.durationMs with legacy durationSec fallback. */
function stepDurationMs(step: NonNullable<ReportNote['steps']>[number]): number | null {
  if (typeof step.durationMs === 'number') return step.durationMs;
  return legacySecAsMs(step, 'durationSec');
}

function outcomeMap(r: ReportData): Map<string, string> {
  return new Map(r.testOutcomes.map((o) => [o.workflow, o.outcome]));
}

function failureKeys(r: ReportData): string[] {
  const fromOutcomes = r.testOutcomes
    .filter((o) => o.outcome === 'fail' || o.outcome === 'blocked')
    .map((o) => `${o.workflow}: ${o.reason ?? o.missingPrecondition ?? o.category ?? o.outcome}`);
  const fromFindings = r.findings.filter((f) => f.severity === 'high').map((f) => `${f.kind}: ${f.detail}`);
  return [...fromOutcomes, ...fromFindings].sort();
}

function screenshotUris(r: ReportData): string[] {
  const direct = r.artifacts.filter((a) => a.kind === 'screenshot').map((a) => a.uri);
  const fromOutcomes = r.testOutcomes
    .flatMap((o) => o.artifactUris ?? [])
    .filter((uri) => /\.(png|jpg|jpeg|webp)(\?|$)/i.test(uri) || /\/screenshot\//i.test(uri));
  return [...new Set([...direct, ...fromOutcomes])].sort();
}

function workflowFromFailureKey(failure: string): string | null {
  const m = failure.match(/^([^:]+):\s/);
  return m ? m[1] : null;
}

export function compareReports(currentPath: string, baselinePath: string, opts: { trendRoot?: string } = {}): ReportCompare {
  const current = loadReport(currentPath);
  const baseline = loadReport(baselinePath);
  const curFailures = failureKeys(current);
  const baseFailures = failureKeys(baseline);
  const currentSet = new Set(curFailures);
  const baseSet = new Set(baseFailures);
  const newFailures = curFailures.filter((f) => !baseSet.has(f));
  const fixedFailures = baseFailures.filter((f) => !currentSet.has(f));
  const trend = opts.trendRoot ? trendForRoot(opts.trendRoot) : null;
  const knownFlakyFailures = trend
    ? newFailures.filter((f) => {
        const workflow = workflowFromFailureKey(f);
        return workflow ? trend.flakyFlows.includes(workflow) : false;
      })
    : [];
  const flakeStatus: ReportCompare['flakeStatus'] = trend ? (knownFlakyFailures.length ? 'known_flaky' : 'not_flaky') : 'not_checked';
  const curOut = outcomeMap(current);
  const baseOut = outcomeMap(baseline);
  const changedOutcomes: ReportCompare['changedOutcomes'] = [];
  for (const [workflow, to] of curOut) {
    const from = baseOut.get(workflow);
    if (from && from !== to) changedOutcomes.push({ workflow, from, to });
  }
  const curScreenshots = screenshotUris(current);
  const baseScreenshots = screenshotUris(baseline);
  const currentScreenshots = new Set(curScreenshots);
  const baselineScreenshots = new Set(baseScreenshots);
  const changedScreenshots = {
    added: curScreenshots.filter((uri) => !baselineScreenshots.has(uri)),
    removed: baseScreenshots.filter((uri) => !currentScreenshots.has(uri)),
  };
  const curTime = timingMs(current.phaseTimings, 'totalMs');
  const baseTime = timingMs(baseline.phaseTimings, 'totalMs');
  const runtimeRegressionMs = curTime != null && baseTime != null && curTime > baseTime ? Math.round(curTime - baseTime) : null;
  const summary = newFailures.length
    ? `BLOCK: ${newFailures.length} new failure(s)`
    : fixedFailures.length
      ? `IMPROVED: ${fixedFailures.length} failure(s) fixed`
      : runtimeRegressionMs
        ? `CAUTION: runtime regressed by ${Math.round(runtimeRegressionMs / 100) / 10}s`
        : 'UNCHANGED: no new failures';
  return {
    current: currentPath,
    baseline: baselinePath,
    newFailures,
    fixedFailures,
    knownFlakyFailures,
    flakeStatus,
    changedScreenshots,
    changedOutcomes,
    runtimeRegressionMs,
    failureCodeDelta: { current: curFailures, baseline: baseFailures },
    summary,
  };
}

function firstProblem(r: ReportData): { workflow?: string; reason: string; category?: string; evidence: string[] } | null {
  const failed = r.testOutcomes.find((o) => o.outcome === 'fail' || o.outcome === 'blocked');
  if (failed) {
    return {
      workflow: failed.workflow,
      reason: failed.reason ?? failed.missingPrecondition ?? failed.category ?? failed.outcome,
      category: failed.category,
      evidence: failed.artifactUris ?? [],
    };
  }
  const high = r.findings.find((f) => f.severity === 'high') ?? r.findings[0];
  if (!high) return null;
  return {
    reason: high.detail,
    category: high.kind,
    evidence: [high.screenshotUri].filter((x): x is string => !!x),
  };
}

function likelyCategory(problem: { reason: string; category?: string } | null, report: ReportData): string {
  const raw = `${problem?.category ?? ''} ${problem?.reason ?? ''}`.toLowerCase();
  if (/accessibility|identifier|locator|element|not found|continue missing/.test(raw)) return 'automation readiness';
  if (/network|device|wda|simulator|emulator|install|seed|fixture|toolchain|permission/.test(raw)) return 'environment/setup';
  if (report.appHealth !== 'OK' || /assert|visible|expected|crash|errorboundary|redbox/.test(raw)) return 'app regression';
  return 'unknown';
}

function evidenceList(report: ReportData, problem: { evidence: string[] } | null): string[] {
  const fromProblem = problem?.evidence ?? [];
  const fromArtifacts = report.artifacts.map((a) => a.uri).slice(0, 5);
  return [...new Set([...fromProblem, ...fromArtifacts])];
}

export function buildPrSummary(currentPath: string, opts: { baselinePath?: string; trendRoot?: string } = {}): PrSummary {
  const report = loadReport(currentPath);
  const problem = firstProblem(report);
  const cmp = opts.baselinePath ? compareReports(currentPath, opts.baselinePath, { trendRoot: opts.trendRoot }) : null;
  const trend = opts.trendRoot ? trendForRoot(opts.trendRoot) : null;
  const knownFlaky = !!(problem?.workflow && trend?.flakyFlows.includes(problem.workflow));
  const hasNewFailure = !!cmp?.newFailures.length;
  const status: PrSummary['status'] =
    report.executiveSummary.risk === 'block' || hasNewFailure || (problem && !knownFlaky)
      ? 'BLOCK'
      : report.executiveSummary.risk === 'caution' || knownFlaky || !!cmp?.runtimeRegressionMs
        ? 'CAUTION'
        : 'SHIP';
  const reason = problem
    ? `${problem.workflow ? `${problem.workflow}: ` : ''}${problem.reason}`
    : (report.executiveSummary.reasons[0] ?? 'No blocking failures detected.');
  const category = likelyCategory(problem, report);
  const classification: PrSummary['classification'] = knownFlaky
    ? 'known_flaky_flow'
    : hasNewFailure && category === 'app regression'
      ? 'new_app_regression'
      : hasNewFailure && category === 'environment/setup'
        ? 'new_environment_failure'
        : category === 'automation readiness' && problem
          ? 'automation_readiness'
          : cmp?.runtimeRegressionMs != null
            ? 'runtime_regression'
            : 'clean';
  const evidence = evidenceList(report, problem);
  const comparison = cmp
    ? cmp.newFailures.length
      ? `${cmp.newFailures.length} new failure(s) versus baseline`
      : cmp.fixedFailures.length
        ? `${cmp.fixedFailures.length} failure(s) fixed versus baseline`
        : cmp.runtimeRegressionMs != null
          ? `runtime regressed by ${Math.round(cmp.runtimeRegressionMs! / 100) / 10}s versus baseline`
          : 'no new failures versus baseline'
    : undefined;
  const nextAction = problem
    ? category === 'automation readiness'
      ? 'Add a durable accessibilityIdentifier/testID or update the flow locator.'
      : report.executiveSummary.nextAction
    : report.executiveSummary.nextAction;
  const lines = [
    `Swipium: ${status}`,
    `Reason: ${reason}${knownFlaky ? ' (known flaky in local trend history)' : ''}.`,
    `Native health: ${report.nativeHealth}. App health: ${report.appHealth}.`,
    `Likely category: ${category}.`,
    `Classification: ${classification.replaceAll('_', ' ')}.`,
    comparison ? `Comparison: ${comparison}.` : '',
    `Evidence: ${evidence.length ? evidence.join(', ') : 'none recorded'}.`,
    `Next action: ${nextAction}`,
  ].filter(Boolean);
  return {
    status,
    classification,
    reason,
    nativeHealth: report.nativeHealth,
    appHealth: report.appHealth,
    likelyCategory: category,
    evidence,
    nextAction,
    comparison,
    knownFlaky,
    text: lines.join('\n'),
  };
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
}

function average(nums: number[]): number | null {
  return nums.length ? round(nums.reduce((sum, n) => sum + n, 0) / nums.length, 2) : null;
}

const PROBABILISTIC_KINDS: ProbabilisticEvidenceKind[] = ['ocr_locator', 'visual_match', 'ai_visual_evidence'];
const CALIBRATION_BUCKETS = [
  { label: '0.00-0.49', min: 0, max: 0.49 },
  { label: '0.50-0.69', min: 0.5, max: 0.69 },
  { label: '0.70-0.84', min: 0.7, max: 0.84 },
  { label: '0.85-0.94', min: 0.85, max: 0.94 },
  { label: '0.95-1.00', min: 0.95, max: 1 },
] as const;
const MIN_CALIBRATION_OUTCOMES = 10;
const MIN_BUCKET_OUTCOMES = 3;
const MAX_CALIBRATION_ERROR = 0.15;

type CalibrationOutcome = 'pass' | 'fail' | 'unknown';

interface CalibrationObservation {
  file: string;
  workflow: string;
  kind: ProbabilisticEvidenceKind;
  outcome: CalibrationOutcome;
  confidence: number | null;
}

interface CalibrationAccumulator {
  evidence: number;
  confidenceSamples: number;
  missingConfidence: number;
  passed: number;
  failed: number;
  unknown: number;
  confidenceSum: number;
  outcomeConfidenceSum: number;
}

function round(n: number, places = 3): number {
  return Number(n.toFixed(places));
}

function isProbabilisticKind(kind: unknown): kind is ProbabilisticEvidenceKind {
  return typeof kind === 'string' && (PROBABILISTIC_KINDS as string[]).includes(kind);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const normalized = value <= 1 ? value : value <= 100 ? value / 100 : null;
  return normalized == null ? null : round(Math.min(1, Math.max(0, normalized)));
}

function confidenceFromRecord(record: Record<string, unknown>): number | null {
  return normalizeConfidence(record.confidence) ?? normalizeConfidence(record.score) ?? normalizeConfidence(record.probability);
}

function outcomeFromRecord(record: Record<string, unknown>): CalibrationOutcome {
  for (const key of ['outcome', 'decision', 'status']) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const value = raw.toLowerCase();
    if (['pass', 'passed', 'ok', 'success'].includes(value)) return 'pass';
    if (['fail', 'failed', 'error', 'timedout', 'timed_out', 'timeout'].includes(value)) return 'fail';
  }
  for (const key of ['pass', 'passed', 'ok']) {
    const value = record[key];
    if (typeof value === 'boolean') return value ? 'pass' : 'fail';
  }
  return 'unknown';
}

function emptyAccumulator(): CalibrationAccumulator {
  return {
    evidence: 0,
    confidenceSamples: 0,
    missingConfidence: 0,
    passed: 0,
    failed: 0,
    unknown: 0,
    confidenceSum: 0,
    outcomeConfidenceSum: 0,
  };
}

function addObservation(acc: CalibrationAccumulator, obs: CalibrationObservation): void {
  acc.evidence++;
  if (obs.confidence == null) {
    acc.missingConfidence++;
    return;
  }
  acc.confidenceSamples++;
  acc.confidenceSum += obs.confidence;
  if (obs.outcome === 'pass') {
    acc.passed++;
    acc.outcomeConfidenceSum += obs.confidence;
  } else if (obs.outcome === 'fail') {
    acc.failed++;
    acc.outcomeConfidenceSum += obs.confidence;
  } else {
    acc.unknown++;
  }
}

function accumulatorSummary(acc: CalibrationAccumulator): ConfidenceCalibrationKindSummary {
  const outcomeSamples = acc.passed + acc.failed;
  const passRate = outcomeSamples ? round(acc.passed / outcomeSamples) : null;
  const averageConfidence = acc.confidenceSamples ? round(acc.confidenceSum / acc.confidenceSamples) : null;
  const expectedConfidence = outcomeSamples ? round(acc.outcomeConfidenceSum / outcomeSamples) : averageConfidence;
  return {
    evidence: acc.evidence,
    confidenceSamples: acc.confidenceSamples,
    missingConfidence: acc.missingConfidence,
    outcomeSamples,
    passRate,
    averageConfidence,
    calibrationError: passRate != null && expectedConfidence != null ? round(Math.abs(expectedConfidence - passRate)) : null,
  };
}

function bucketForConfidence(confidence: number): (typeof CALIBRATION_BUCKETS)[number] {
  if (confidence < 0.5) return CALIBRATION_BUCKETS[0];
  if (confidence < 0.7) return CALIBRATION_BUCKETS[1];
  if (confidence < 0.85) return CALIBRATION_BUCKETS[2];
  if (confidence < 0.95) return CALIBRATION_BUCKETS[3];
  return CALIBRATION_BUCKETS[4];
}

function confidenceObservationsForReport(file: string, report: ReportData): CalibrationObservation[] {
  const taxonomy = report.evidenceTaxonomy ?? evidenceTaxonomyForNotes(report.testOutcomes);
  const notesByWorkflow = new Map<string, ReportNote[]>();
  for (const note of report.testOutcomes) notesByWorkflow.set(note.workflow, [...(notesByWorkflow.get(note.workflow) ?? []), note]);
  const observations: CalibrationObservation[] = [];
  for (const assessment of taxonomy.assessments) {
    if (!isProbabilisticKind(assessment.kind)) continue;
    const matchingNotes = notesByWorkflow.get(assessment.workflow) ?? [];
    const note = matchingNotes.shift();
    const assessmentRecord = asRecord(assessment);
    const noteRecord = asRecord(note);
    observations.push({
      file,
      workflow: assessment.workflow,
      kind: assessment.kind,
      outcome: outcomeFromRecord(assessmentRecord) !== 'unknown' ? outcomeFromRecord(assessmentRecord) : outcomeFromRecord(noteRecord),
      confidence: confidenceFromRecord(assessmentRecord) ?? confidenceFromRecord(noteRecord),
    });
  }
  return observations;
}

function calibrationNote(status: ConfidenceCalibrationStatus, warnings: string[]): string {
  if (status === 'not_required') return 'No probabilistic visual/OCR/AI visual evidence was recorded in the history.';
  if (status === 'insufficient_data')
    return warnings[0] ?? 'More dogfood-nightly confidence samples are required before calibration can be trusted.';
  if (status === 'needs_attention') return warnings[0] ?? 'Confidence calibration is available but has reliability warnings.';
  return 'Probabilistic confidence values are paired with enough dogfood outcomes and no calibration warning crossed the configured thresholds.';
}

function confidenceCalibrationForReports(reports: Array<{ file: string; report: ReportData }>): ConfidenceCalibrationSummary {
  const observations = reports.flatMap(({ file, report }) => confidenceObservationsForReport(file, report));
  const overall = emptyAccumulator();
  const byKindAcc = Object.fromEntries(PROBABILISTIC_KINDS.map((kind) => [kind, emptyAccumulator()])) as Record<
    ProbabilisticEvidenceKind,
    CalibrationAccumulator
  >;
  const bucketAcc = new Map<string, CalibrationAccumulator>();
  for (const b of CALIBRATION_BUCKETS) bucketAcc.set(b.label, emptyAccumulator());

  for (const obs of observations) {
    addObservation(overall, obs);
    addObservation(byKindAcc[obs.kind], obs);
    if (obs.confidence != null) addObservation(bucketAcc.get(bucketForConfidence(obs.confidence).label)!, obs);
  }

  const overallSummary = accumulatorSummary(overall);
  const buckets: ConfidenceCalibrationBucket[] = CALIBRATION_BUCKETS.map((bucket) => {
    const acc = bucketAcc.get(bucket.label)!;
    const summary = accumulatorSummary(acc);
    return {
      label: bucket.label,
      min: bucket.min,
      max: bucket.max,
      samples: acc.confidenceSamples,
      passed: acc.passed,
      failed: acc.failed,
      unknown: acc.unknown,
      averageConfidence: summary.averageConfidence,
      observedPassRate: summary.passRate,
      calibrationError: summary.calibrationError,
    };
  });

  const warnings: string[] = [];
  if (overall.missingConfidence) warnings.push(`${overall.missingConfidence} probabilistic evidence item(s) did not record confidence.`);
  if (overall.evidence && !overall.confidenceSamples) warnings.push('No probabilistic evidence had a numeric confidence value.');
  if (overall.evidence && overallSummary.outcomeSamples < MIN_CALIBRATION_OUTCOMES) {
    warnings.push(
      `Only ${overallSummary.outcomeSamples} pass/fail outcome sample(s) are paired with confidence; ${MIN_CALIBRATION_OUTCOMES} are required for calibration.`,
    );
  }
  if (
    overallSummary.outcomeSamples >= MIN_CALIBRATION_OUTCOMES &&
    overallSummary.calibrationError != null &&
    overallSummary.calibrationError > MAX_CALIBRATION_ERROR
  ) {
    warnings.push(`Observed pass rate differs from average confidence by ${overallSummary.calibrationError}.`);
  }
  for (const bucket of buckets) {
    const bucketOutcomes = bucket.passed + bucket.failed;
    if (bucket.min >= 0.85 && bucketOutcomes >= MIN_BUCKET_OUTCOMES && bucket.observedPassRate != null && bucket.observedPassRate < 0.9) {
      warnings.push(
        `High-confidence bucket ${bucket.label} passed only ${(bucket.observedPassRate * 100).toFixed(1)}% of ${bucketOutcomes} outcome sample(s).`,
      );
    }
  }

  const status: ConfidenceCalibrationStatus = !overall.evidence
    ? 'not_required'
    : !overall.confidenceSamples || overallSummary.outcomeSamples < MIN_CALIBRATION_OUTCOMES
      ? 'insufficient_data'
      : warnings.length
        ? 'needs_attention'
        : 'calibrated';

  return {
    schema: 'swipium.confidence.calibration.v1',
    status,
    requiredCorpus: 'dogfood-nightly',
    reports: reports.length,
    probabilisticEvidence: overall.evidence,
    confidenceSamples: overall.confidenceSamples,
    missingConfidence: overall.missingConfidence,
    outcomeSamples: overallSummary.outcomeSamples,
    passRate: overallSummary.passRate,
    averageConfidence: overallSummary.averageConfidence,
    calibrationError: overallSummary.calibrationError,
    byEvidenceKind: Object.fromEntries(PROBABILISTIC_KINDS.map((kind) => [kind, accumulatorSummary(byKindAcc[kind])])) as Record<
      ProbabilisticEvidenceKind,
      ConfidenceCalibrationKindSummary
    >,
    buckets,
    warnings,
    note: calibrationNote(status, warnings),
  };
}

export function findReportJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name === 'report.json') out.push(p);
    }
  };
  for (const base of [join(root, '.swipium', 'runs'), join(root, '.swipium', 'ci')]) {
    if (existsSync(base)) walk(base);
  }
  return out.sort();
}

export function trendForReports(files: string[]): TrendSummary {
  const reports = files.map((f) => ({ file: f, report: loadReport(f) }));
  const byFlow = new Map<string, string[]>();
  const byContext = new Map<string, string[]>();
  const codeCounts = new Map<string, number>();
  const envCounts = new Map<string, number>();
  const times: number[] = [];
  const setupTimes: number[] = [];
  const activeTimes: number[] = [];
  const stepTimes: TrendSummary['slowestSteps'] = [];
  const releaseSignals = new Map<TrendReleaseGateSignal['code'], TrendReleaseGateSignal>();
  let wdaReports = 0;
  let wdaReachable = 0;
  let wdaReady = 0;
  let onlineAtEnd = 0;
  let visualOnlyRuns = 0;
  let coordinateOnlyWarnings = 0;
  const locatorRuns: TrendSummary['locatorReadinessTrend']['runs'] = [];
  const addReleaseSignal = (
    level: TrendReleaseGateSignal['level'],
    code: TrendReleaseGateSignal['code'],
    policy: string,
    example: string,
  ) => {
    const existing = releaseSignals.get(code);
    if (existing) {
      existing.count++;
      if (existing.examples.length < 5 && !existing.examples.includes(example)) existing.examples.push(example);
      return;
    }
    releaseSignals.set(code, { level, code, count: 1, policy, examples: [example] });
  };
  for (const { file, report } of reports) {
    const totalMs = timingMs(report.phaseTimings, 'totalMs');
    const setupMs = timingMs(report.phaseTimings, 'setupMs');
    const activeMs = timingMs(report.phaseTimings, 'activeMs');
    if (totalMs != null) times.push(totalMs);
    if (setupMs != null) setupTimes.push(setupMs);
    if (activeMs != null) activeTimes.push(activeMs);
    for (const o of report.testOutcomes) {
      byFlow.set(o.workflow, [...(byFlow.get(o.workflow) ?? []), o.outcome]);
      const contextKey = `${report.appId ?? 'unknown'}|${report.device ?? 'device'}|${report.automationBackend?.kind ?? 'unknown'}`;
      byContext.set(contextKey, [...(byContext.get(contextKey) ?? []), o.outcome]);
      for (const step of o.steps ?? []) {
        const durationMs = stepDurationMs(step);
        if (durationMs == null) continue;
        stepTimes.push({ file, workflow: o.workflow, index: step.index, kind: step.kind, summary: step.summary, durationMs });
      }
      if (o.outcome === 'fail') {
        const code = o.category ?? o.reason ?? 'fail';
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
      if (o.outcome === 'fail' || o.outcome === 'blocked') {
        addReleaseSignal(
          'block',
          'REQUIRED_WORKFLOW_FAILED',
          'Block release when a required workflow fails or is blocked.',
          `${o.workflow}: ${o.reason ?? o.missingPrecondition ?? o.category ?? o.outcome}`,
        );
      }
      if (
        o.outcome === 'pass' &&
        (o.method === 'visual' ||
          o.verifiedVisually ||
          o.evidenceKind === 'ocr_locator' ||
          o.evidenceKind === 'visual_match' ||
          o.evidenceKind === 'ai_visual_evidence')
      ) {
        addReleaseSignal(
          'warn',
          'VISUAL_ONLY_PASS',
          'Warn when a passing workflow is proven only by visual/OCR/AI evidence.',
          `${o.workflow}: ${o.evidenceKind ?? o.method ?? 'visual evidence'}`,
        );
      }
    }
    for (const f of report.findings) {
      if (f.failureCode) codeCounts.set(f.failureCode, (codeCounts.get(f.failureCode) ?? 0) + 1);
      if (f.layer === 'native' || /device|install|network|foreground|seed|toolchain/i.test(f.kind)) {
        envCounts.set(f.kind, (envCounts.get(f.kind) ?? 0) + 1);
      }
    }
    if (report.appHealth !== 'OK' || report.findings.some((f) => f.layer === 'app' && f.severity === 'high')) {
      addReleaseSignal(
        'block',
        'APP_ERROR',
        'Block release on app-layer health errors or high-severity app findings.',
        `${file}: appHealth=${report.appHealth}`,
      );
    }
    const readinessLabels = report.automationReadiness?.labels ?? [];
    if (
      (readinessLabels.includes('generated') || readinessLabels.includes('compiled')) &&
      !readinessLabels.includes('replayed') &&
      !readinessLabels.includes('ci_ready')
    ) {
      addReleaseSignal(
        'warn',
        'GENERATED_SUITE_NOT_REPLAYED',
        'Warn when generated or compiled suites have not replayed from declared state.',
        `${file}: labels=${readinessLabels.join(',')}`,
      );
    }
    if (report.wda) {
      wdaReports++;
      if (report.wda.status?.reachable) wdaReachable++;
      if (report.wda.status?.ready !== false && report.wda.status?.reachable) wdaReady++;
    }
    if (report.finalNetwork === 'online') onlineAtEnd++;
    if ((report as unknown as { visualOnly?: boolean }).visualOnly) visualOnlyRuns++;
    coordinateOnlyWarnings += report.findings.filter((f) =>
      /COORDINATE_ONLY|coordinate/i.test(`${f.failureCode ?? ''} ${f.kind} ${f.detail}`),
    ).length;
    if (report.automationReadiness?.locatorCoverage) {
      const coverage = report.automationReadiness.locatorCoverage;
      locatorRuns.push({
        file,
        grade: report.automationReadiness.grade,
        durablePct: coverage.durablePct,
        nativeOrDurablePct: coverage.nativeOrDurablePct,
        totalActions: coverage.totalActions,
        weakActions: coverage.textActions + coverage.coordinateActions,
      });
    }
  }
  const passRate: Record<string, number> = {};
  const flakyFlows: string[] = [];
  for (const [flow, outcomes] of byFlow) {
    const passes = outcomes.filter((o) => o === 'pass').length;
    passRate[flow] = Number((passes / outcomes.length).toFixed(3));
    if (new Set(outcomes).size > 1) flakyFlows.push(flow);
  }
  const passRateByAppPlatformBackend: Record<string, number> = {};
  for (const [key, outcomes] of byContext) {
    const passes = outcomes.filter((o) => o === 'pass').length;
    passRateByAppPlatformBackend[key] = Number((passes / outcomes.length).toFixed(3));
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({ code, count }));
  return {
    reports: reports.length,
    passRate,
    passRateByAppPlatformBackend,
    medianRuntimeMs: median(times),
    averageSetupMs: average(setupTimes),
    averageActiveMs: average(activeTimes),
    topFailureCodes: top(codeCounts),
    topEnvironmentFailures: top(envCounts).map(({ code, count }) => ({ kind: code, count })),
    flakyFlows: flakyFlows.sort(),
    wdaReliability: { reports: wdaReports, reachable: wdaReachable, ready: wdaReady },
    emulatorReliability: { reports: reports.length, onlineAtEnd },
    locatorReadinessTrend: {
      visualOnlyRuns,
      coordinateOnlyWarnings,
      runsWithReadiness: locatorRuns.length,
      latestDurablePct: locatorRuns[locatorRuns.length - 1]?.durablePct ?? null,
      averageDurablePct: average(locatorRuns.map((r) => r.durablePct)),
      minimumDurablePct: locatorRuns.length ? Math.min(...locatorRuns.map((r) => r.durablePct)) : null,
      runs: locatorRuns,
    },
    releaseGateSignals: [...releaseSignals.values()].sort((a, b) =>
      a.level === b.level ? b.count - a.count : a.level === 'block' ? -1 : 1,
    ),
    confidenceCalibration: confidenceCalibrationForReports(reports),
    slowestRuns: reports
      .map((r) => ({ file: r.file, totalMs: timingMs(r.report.phaseTimings, 'totalMs') }))
      .filter((r): r is { file: string; totalMs: number } => r.totalMs != null)
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 10),
    slowestSteps: stepTimes.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
  };
}

export function trendForRoot(root: string): TrendSummary {
  return trendForReports(findReportJsonFiles(root));
}
