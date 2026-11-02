// Report 2.0 exporters. Turn the assembled report into formats a developer
// can use without the agent transcript: an issue-ready Markdown doc and a CI-ready JUnit XML.
// (a third-party-format exporter is deferred and out of scope here.)
//
// Callers pass the report through redactReportData() FIRST: every string field (steps,
// nextStep, missingPrecondition, workflow names, …) is scrubbed with the session redactor before
// any format escapes it, so XML/JSON/Markdown escaping can never hide a secret from redaction.

import { createHash } from 'node:crypto';
import type { AutomationReadinessStandard, ReadinessLabel } from './readiness.js';
import type { FlakeClassification } from './flake.js';
import type { FlowVerdict, PolicyDecision } from './policy.js';
import { evidenceTaxonomyForNotes, type EvidenceKind, type EvidenceMethod, type EvidenceTaxonomy } from './evidence.js';
import { FAILURES } from '../oracle/failures.js';
import { scrubVolatile } from '../issues/fingerprint.js';
import { uniqueKey, type Redactor } from '../lib/redact.js';
import type { SarifSourceMap } from './sarifSources.js';
import { pickNotTestedLog } from './logTail.js';

export interface ReportNote {
  workflow: string;
  outcome: 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_applicable';
  category?: string;
  reason?: string;
  method?: EvidenceMethod;
  evidenceKind?: EvidenceKind | 'ocr_text';
  verifiedVisually?: boolean;
  confidence?: number;
  minConfidence?: number;
  decision?: string;
  steps?: Array<{ index: number; phase?: string; kind: string; summary?: string; ok: boolean; durationMs?: number; failureCode?: string }>;
  missingPrecondition?: string;
  recommendedSetup?: string;
  artifactUris?: string[];
  /** 'qa_note' = written by the agent, not by Swipium. */
  source?: string;
  /** An agent's pass claim nothing on the device backs (services/report.ts). Rendered as
   *  skipped / "pass (unverified)", never as a passing test. */
  unverified?: boolean;
  /** Who wrote it (2.4.0+): smoke | flow | flow_note | explore | agent. Absent on older reports. */
  origin?: string;
  /** Flow verdict came from a visual step. */
  visualStep?: boolean;
  /** session.steps numbers [from, to] this outcome covers. */
  stepRange?: [number, number];
  /** Evidence URIs (checkpoint screenshot, failure screenshot/dump, explicit artifactUris) that resolve
   *  to this session's artifacts. */
  evidence?: string[];
  /** The other attempts of the same workflow: earlier ones this one replaced, and later
   *  blocked / skipped / not_applicable ones that could not replace it. */
  attempts?: Array<{ outcome: ReportNote['outcome']; at?: number; reason?: string }>;
  /** The attempts disagreed (a fail and a pass). */
  flaky?: boolean;
  /** A pass whose step range holds a high crash/ANR/app-error finding or a failed flow/smoke step. */
  contradicted?: boolean;
  at?: number;
}

/** Which attempts may replace each other: Swipium runs replace Swipium runs, agent notes replace
 *  agent notes. Explore notes and in-flow note steps (null) never replace and are never replaced. */
export function attemptKind(n: Pick<ReportNote, 'origin' | 'source' | 'workflow' | 'reason'>): 'swipium' | 'agent' | null {
  switch (n.origin) {
    case 'smoke':
    case 'flow':
      return 'swipium';
    case 'agent':
      return 'agent';
    case 'explore':
    case 'flow_note':
      return null;
  }
  // Pre-2.4.0 notes carry no origin.
  if (n.source === 'qa_note') return 'agent';
  if (n.workflow === 'launch_smoke' || /^qa_flow_run\b/.test(n.reason ?? '')) return 'swipium';
  return null;
}

/** Workflow identity for latest-wins: trimmed, case-folded name. */
export function workflowKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A verdict that can replace an earlier attempt. Blocked / skipped / not_applicable say the
 *  workflow did not run to a verdict, so they never hide an earlier pass or fail. */
function isDefinitive(n: Pick<ReportNote, 'outcome'>): boolean {
  return n.outcome === 'pass' || n.outcome === 'fail';
}

/** Per attempt group (same kind + workflow key), which note counts: the latest definitive one, else
 *  the latest one. Returns the notes in order with the counting note annotated (attempts, flaky)
 *  and every other note of a multi-attempt group replaced by null. */
function resolveAttempts<T extends ReportNote>(notes: readonly T[]): Array<T | null> {
  const groups = new Map<string, number[]>();
  notes.forEach((n, idx) => {
    const kind = attemptKind(n);
    if (!kind) return;
    const key = `${kind}:${workflowKey(n.workflow)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(idx);
  });
  const out: Array<T | null> = [...notes];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const definitive = idxs.filter((i) => isDefinitive(notes[i]));
    const win = (definitive.length ? definitive : idxs).at(-1)!;
    const others = idxs.filter((i) => i !== win).map((i) => notes[i]);
    const outcomes = new Set(idxs.map((i) => notes[i].outcome));
    for (const i of idxs) out[i] = null;
    // attempts is rebuilt from the raw notes every time (never appended to), so re-collapsing a saved
    // report that already carries attempts on its counting entry gives the same result.
    out[win] = {
      ...notes[win],
      attempts: others.map((p) => ({
        outcome: p.outcome,
        ...(p.at !== undefined ? { at: p.at } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
      })),
      ...(outcomes.has('pass') && outcomes.has('fail') ? { flaky: true } : {}),
    };
  }
  return out;
}

/**
 * Latest attempt wins per workflow (and per attempt kind). The ONE helper every consumer uses
 * (release gate, risk/fail counts, JUnit, markdown, html, summaries) so they always agree.
 * Only a definitive verdict (pass or fail) replaces an earlier attempt: a later blocked / skipped /
 * not_applicable (a budget skip, a cancelled smoke, an agent's n/a) keeps the latest pass or fail
 * as the counting outcome and is listed in its `attempts`. With no definitive attempt, the latest
 * one counts. Order is preserved at the position of the counting attempt. `flaky` is set when the
 * attempts include both a pass and a fail. Findings are not notes and are never touched here.
 */
export function latestAttempts<T extends ReportNote>(notes: readonly T[]): T[] {
  return resolveAttempts(notes).filter((n): n is T => n !== null);
}

/** Every note kept, in order, with `attempts` / `flaky` set on the one that counts per workflow
 *  (what report.json saves; latestAttempts on the result gives the same verdicts). */
export function annotateAttempts<T extends ReportNote>(notes: readonly T[]): T[] {
  return resolveAttempts(notes).map((n, i) => n ?? notes[i]);
}
/** One step of the timeline (mirror of session StepRecord, as saved in report.json). */
export interface ReportStep {
  i: number;
  at: number;
  durationMs: number;
  source: string;
  action: string;
  target?: string;
  result: 'ok' | 'failed' | 'no_change' | string;
  failureCode?: string;
  screen?: string;
  screenshotUri?: string;
  dumpUri?: string;
  screenshotSkipped?: string;
  group?: string;
}
export interface ReportFinding {
  severity: string;
  layer?: string;
  kind: string;
  failureCode?: string;
  bucket?: string;
  retrySafe?: boolean;
  nextStep?: string;
  detail: string;
  evidence?: string;
  screen?: string;
  screenshotUri?: string;
  /** Identical occurrences this (deduplicated) finding stands for (see report/findingsDedupe.ts). */
  count?: number;
  logUri?: string;
  at?: number;
}
export interface ReportMutation {
  id?: string;
  at?: number;
  tool: string;
  action: string;
  risk: 'low' | 'medium' | 'high' | string;
  target?: Record<string, unknown>;
  consent?: {
    required?: boolean;
    consentId?: string;
    approved?: boolean;
    payloadHash?: string;
  };
  status: 'requested' | 'approved' | 'executed' | 'refused' | 'blocked' | 'restored' | string;
  ledgerUri?: string;
  detail?: string;
}
export interface ReportData {
  sessionId: string;
  appId: string | null;
  device: string | null;
  coverage: string;
  readiness?: ReadinessLabel[];
  automationBackend?: {
    kind: string;
    mode: string;
    structured: boolean;
    description: string;
  };
  wda?: {
    webDriverAgentUrl: string;
    device: string | null;
    wdaSessionId: string | null;
    config?: unknown;
    status?: { reachable?: boolean; ready?: boolean; message?: string };
    tuning?: {
      timings?: Record<string, number | null>;
      recommendations?: Array<{ setting: string; value: unknown; reason: string; failureCode?: string }>;
    };
  } | null;
  executiveSummary: { risk: string; reasons: string[]; nextAction: string };
  /** The run did not test what it set out to (services/report.ts). `reachedApp:false` gates like a
   *  failed required flow (code `failureCode`, default NOT_TESTED), so a run that tested nothing
   *  can't pass `--fail-on-gate`. `exercised:false` (no workflow tested, even on a reached app) gates
   *  the same way; reports saved before it existed gate on `reachedApp` only. */
  notTested?: { reachedApp: boolean; exercised?: boolean; reason: string; failureCode?: string };
  appVerdict?: { status: string; summary: string };
  coverageVerdict?: { status: string; summary: string };
  toolVerdict?: { status: string; summary: string };
  nativeHealth: string;
  appHealth: string;
  findings: ReportFinding[];
  highSeverityCount: number;
  testOutcomes: ReportNote[];
  outcomeTally: Record<string, number>;
  automationReadiness?: AutomationReadinessStandard;
  evidenceTaxonomy?: EvidenceTaxonomy;
  environmentChanges: string[];
  ciMutations?: string[];
  mutationLedger?: ReportMutation[];
  /** Session was rehydrated after a server restart with prior secret-bearing state.
   * pre-restart secrets are no longer in the redaction set for artifacts written since. */
  redactionDegraded?: boolean;
  guardrailOverrides: string[];
  finalNetwork: string;
  networkRestore: string;
  authState: string;
  phaseTimings: {
    totalMs: number | null;
    setupMs: number | null;
    activeMs: number | null;
    timeToLoginMs: number | null;
    diagnostics?: {
      simulatorBootMs: number | null;
      appInstallMs: number | null;
      appLaunchMs: number | null;
      wdaBuildMs: number | null;
      wdaStartMs: number | null;
      wdaReuseCheckMs?: number | null;
      wdaStartupWaitMs?: number | null;
      wdaSessionCreateMs?: number | null;
      wdaSourceMs?: number | null;
      wdaFindElementMs?: number | null;
      wdaTapMs?: number | null;
      wdaTypeMs?: number | null;
      wdaClearMs?: number | null;
      wdaScreenshotMs?: number | null;
      flowRuntimeMs: number | null;
      waitMs: number | null;
      screenshotCount?: number | null;
    };
  };
  /** 2.4.0+: `path` is relative to the session folder (never absolute: CI uploads must not carry
   *  $HOME), `createdAt` epoch ms, `redaction` as stored ('not-applied' = pixels may be sensitive). */
  artifacts: Array<{ uri: string; kind: string; label?: string; path?: string; createdAt?: number; redaction?: string }>;
  /** Report JSON schema: 2 since 2.4.0; absent on older reports (treat as 1). */
  schemaVersion?: number;
  /** Ordered step timeline (2.4.0+). Absent on older reports and stripped from inline JSON results. */
  steps?: ReportStep[];
  /** URI of the saved report.json, set on inline results that leave out `steps`. */
  stepsUri?: string;
  /** Another job of this session was still running when the report was made. */
  partial?: { jobId: string; kind: string } | null;
  generatedValues?: Array<{
    fixture: string;
    field: string;
    varName: string;
    generator: string;
    value: string;
    secret: boolean;
    artifactUri?: string;
  }>;
  prSummary?: { text: string };
  flakeClassification?: FlakeClassification;
  /** Issue-memory markdown block, pre-rendered by the issues report bridge. */
  issuesMarkdown?: string;
  issueRecurrences?: string[];
}

/**
 * Deep-redact a report: returns a copy where EVERY string value at any depth (and every string
 * object key) has been passed through the session redactor. Run it once on the assembled report,
 * before persisting it or rendering any export format. Escaping (`&` > `&amp;`, `"` > `\"`) would
 * otherwise turn a secret like `P@ss&w0rd"1` into text the redactor no longer matches.
 */
export function redactReportData<T>(value: T, redact: Redactor): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      // Two keys that redact to the same spelling (e.g. "hunter22" and a literal "«redacted»")
      // are disambiguated with a `#2` suffix instead of one silently overwriting the other.
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[uniqueKey(out, redact(k) ?? k)] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Steps of the timeline an outcome covers (its stepRange, inclusive, by step number). Empty on
 *  reports without steps or outcomes without a range. */
export function stepsInRange(r: Pick<ReportData, 'steps'>, n: Pick<ReportNote, 'stepRange'>): ReportStep[] {
  const range = n.stepRange;
  if (!range || !r.steps?.length) return [];
  return r.steps.filter((s) => s.i >= range[0] && s.i <= range[1]);
}

/** Where a failed outcome failed: the first failed timeline step in its range, else (older reports)
 *  the first failed flow step the note recorded. */
export function failingStep(
  r: Pick<ReportData, 'steps'>,
  n: ReportNote,
): { i: number; label: string; failureCode?: string; screen?: string; screenshotUri?: string } | undefined {
  const st = stepsInRange(r, n).find((s) => s.result === 'failed');
  if (st) {
    return {
      i: st.i,
      label: st.target ?? st.action,
      ...(st.failureCode ? { failureCode: st.failureCode } : {}),
      ...(st.screen ? { screen: st.screen } : {}),
      ...(st.screenshotUri ? { screenshotUri: st.screenshotUri } : {}),
    };
  }
  const fs = n.steps?.find((s) => !s.ok);
  if (fs) return { i: fs.index, label: fs.summary ?? fs.kind, ...(fs.failureCode ? { failureCode: fs.failureCode } : {}) };
  return undefined;
}

/** Duration of an outcome in ms: its timeline steps, else its recorded flow steps, else 0. */
function outcomeDurationMs(r: Pick<ReportData, 'steps'>, n: ReportNote): number {
  const inRange = stepsInRange(r, n);
  const ms = inRange.length
    ? inRange.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
    : (n.steps?.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) ?? 0);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

/** Evidence of an outcome: the linked evidence (2.4.0+), else the URIs the note carried. */
export function outcomeEvidence(n: Pick<ReportNote, 'evidence' | 'artifactUris'>): string[] {
  return n.evidence ?? n.artifactUris ?? [];
}

/** A pass or fail with nothing captured behind it renders "(no evidence)". */
function lacksEvidence(n: ReportNote): boolean {
  return (n.outcome === 'pass' || n.outcome === 'fail') && outcomeEvidence(n).length === 0;
}

/** "fail, pass" for a flaky outcome: earlier attempts, then the one that counts. */
function attemptsText(n: Pick<ReportNote, 'attempts' | 'outcome'>): string {
  return [...(n.attempts ?? []).map((a) => a.outcome), n.outcome].join(', ');
}

/** Workflow outcomes as every renderer counts them: latest attempt per workflow. */
function latestTally(r: Pick<ReportData, 'testOutcomes'>): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const n of latestAttempts(r.testOutcomes)) {
    const key = n.outcome === 'pass' && n.unverified ? 'pass (unverified)' : n.outcome;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return [...out.entries()];
}

/** The playwright export is kept for compatibility only. */
export const PLAYWRIGHT_DEPRECATION =
  'The playwright export is deprecated and will be removed in a future release; use junit or the HTML report.';

type PlaywrightStatus = 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';

function playwrightStatus(outcome: ReportNote['outcome']): PlaywrightStatus {
  if (outcome === 'pass') return 'passed';
  if (outcome === 'fail') return 'failed';
  return 'skipped';
}

function playwrightAttachments(n: ReportNote): Array<{ name: string; contentType: string; path: string }> {
  return outcomeEvidence(n).map((uri, i) => ({
    name: `artifact-${i + 1}`,
    contentType: uri.match(/\.(png|jpg|jpeg|webp)$/i) ? 'image/*' : 'application/octet-stream',
    path: uri,
  }));
}

export function toPlaywrightJson(r: ReportData): string {
  const generatedAt = new Date().toISOString();
  const evidenceTaxonomy = r.evidenceTaxonomy ?? evidenceTaxonomyForNotes(r.testOutcomes);
  const evidenceByWorkflow = new Map(evidenceTaxonomy.assessments.map((a) => [a.workflow, a]));
  // The not-tested marker is a failed case, as in JUnit: a run that tested nothing is red.
  const outcomes = [...latestAttempts(r.testOutcomes), ...notReachedOutcomes(r)];
  const specs = outcomes.map((n) => {
    const status = n.unverified ? 'skipped' : playwrightStatus(n.outcome); // a claim is not a pass
    const message =
      (n.unverified ? 'unverified manual claim: ' : '') +
      ([n.category, n.reason, n.missingPrecondition, n.recommendedSetup].filter(Boolean).join(': ') || n.outcome);
    const evidence = evidenceByWorkflow.get(n.workflow);
    return {
      title: n.workflow,
      ok: status === 'passed',
      tags: [n.category, n.outcome, evidence?.kind, evidence?.authority].filter(Boolean),
      tests: [
        {
          timeout: 0,
          expectedStatus: 'passed',
          projectName: r.automationBackend?.mode ?? 'swipium',
          results: [
            {
              workerIndex: 0,
              status,
              duration: outcomeDurationMs(r, n),
              errors: status === 'failed' ? [{ message }] : [],
              attachments: playwrightAttachments(n),
              stdout: [],
              stderr: [],
              retry: 0,
              startTime: generatedAt,
            },
          ],
          status,
          annotations: [
            ...(status === 'skipped' ? [{ type: n.outcome, description: message }] : []),
            ...(evidence?.warning ? [{ type: 'evidence', description: evidence.warning }] : []),
            ...(n.flaky ? [{ type: 'flaky', description: `attempts: ${attemptsText(n)}` }] : []),
            ...(n.contradicted
              ? [{ type: 'contradicted', description: 'a crash, ANR, app error or failed Swipium step falls inside this pass' }]
              : []),
          ],
        },
      ],
      file: `swipium://${r.sessionId}/${n.workflow}`,
      line: 1,
      column: 1,
    };
  });
  const findingSpecs = r.findings.map((f, i) => ({
    title: `${f.failureCode ?? f.kind}: ${f.detail}`,
    ok: f.severity !== 'high',
    tags: [f.bucket, f.severity, f.layer].filter(Boolean),
    tests: [
      {
        timeout: 0,
        expectedStatus: 'passed',
        projectName: r.automationBackend?.mode ?? 'swipium',
        results: [
          {
            workerIndex: 0,
            status: f.severity === 'high' ? ('failed' as PlaywrightStatus) : ('passed' as PlaywrightStatus),
            duration: 0,
            errors:
              f.severity === 'high'
                ? [
                    {
                      message: f.detail,
                      location: { file: f.screenshotUri ?? `swipium://${r.sessionId}/finding/${i + 1}`, line: 1, column: 1 },
                    },
                  ]
                : [],
            attachments: f.screenshotUri ? [{ name: 'screenshot', contentType: 'image/*', path: f.screenshotUri }] : [],
            stdout: [],
            stderr: [],
            retry: 0,
            startTime: generatedAt,
          },
        ],
        status: f.severity === 'high' ? ('failed' as PlaywrightStatus) : ('passed' as PlaywrightStatus),
        annotations: f.nextStep ? [{ type: 'nextStep', description: f.nextStep }] : [],
      },
    ],
    file: f.screenshotUri ?? `swipium://${r.sessionId}/finding/${i + 1}`,
    line: 1,
    column: 1,
  }));
  const allSpecs = [...specs, ...findingSpecs];
  const failed = allSpecs.filter((s) => !s.ok).length;
  const skipped = specs.filter((s) => s.tests[0].status === 'skipped').length;
  const payload = {
    schema: 'swipium.playwright.report.v1',
    deprecated: PLAYWRIGHT_DEPRECATION,
    generatedAt,
    config: {
      rootDir: '.',
      metadata: {
        swipium: {
          sessionId: r.sessionId,
          appId: r.appId,
          device: r.device,
          coverage: r.coverage,
          releaseRisk: r.executiveSummary.risk,
          nextAction: r.executiveSummary.nextAction,
          automationBackend: r.automationBackend ?? null,
          readiness: r.readiness ?? [],
          wda: r.wda ?? null,
          automationReadiness: r.automationReadiness ?? null,
          evidenceTaxonomy,
          mutationLedger: r.mutationLedger ?? [],
          flakeClassification: r.flakeClassification ?? null,
        },
      },
      projects: [{ name: r.automationBackend?.mode ?? 'swipium' }],
    },
    suites: [
      {
        title: `Swipium ${r.appId ?? 'app'}`,
        file: `swipium://${r.sessionId}/report`,
        specs: allSpecs,
      },
    ],
    stats: {
      expected: allSpecs.length - failed - skipped,
      skipped,
      unexpected: failed,
      flaky: Math.max(outcomes.filter((n) => n.flaky).length, r.flakeClassification?.classification === 'flaky' ? 1 : 0),
      duration: Math.round(r.phaseTimings.totalMs ?? 0),
    },
    errors: failed ? [{ message: r.executiveSummary.nextAction }] : [],
  };
  return JSON.stringify(payload, null, 2);
}

const RISK_BADGE: Record<string, string> = { ship: '🟢 SHIP', caution: '🟡 CAUTION', block: '🔴 BLOCK' };
const OUTCOME_MARK: Record<string, string> = { pass: '✅', fail: '❌', blocked: '⛔', skipped: '⏭️', not_applicable: '➖' };

/** A workflow outcome as shown to people: an unverified pass claim reads "pass (unverified)", a pass
 *  that its own steps contradict reads "pass (contradicted)", and a retried workflow whose attempts
 *  disagreed adds "flaky (attempts: fail, pass)". */
function outcomeLabel(n: Pick<ReportNote, 'outcome' | 'unverified' | 'contradicted' | 'flaky' | 'attempts'>): string {
  const base =
    n.outcome === 'pass' && n.unverified
      ? `${OUTCOME_MARK.skipped} pass (unverified)`
      : n.outcome === 'pass' && n.contradicted
        ? '⚠️ pass (contradicted)'
        : `${OUTCOME_MARK[n.outcome] ?? ''} ${n.outcome}`;
  return n.flaky ? `${base} flaky (attempts: ${attemptsText(n)})` : base;
}

/** WebDriverAgent returning no UI source is a tool / environment failure
 *  (WDA_UNREACHABLE), not an app or native defect: SARIF note, JUnit skipped, labelled "tool". It
 *  still fails the release gate (reportPolicyVerdicts), so the run never passes on it. */
export function isToolReportFinding(f: Pick<ReportFinding, 'kind' | 'failureCode'>): boolean {
  return f.kind === 'wda_unreachable' || f.failureCode === 'WDA_UNREACHABLE';
}

function statusWord(risk: string): string {
  return risk === 'block' ? 'BLOCK' : risk === 'caution' ? 'CAUTION' : 'SHIP';
}

function firstReportProblem(r: ReportData): { reason: string; category?: string; workflow?: string; evidence?: string[] } | null {
  const failed = latestAttempts(r.testOutcomes).find((o) => o.outcome === 'fail' || o.outcome === 'blocked');
  if (failed) {
    return {
      workflow: failed.workflow,
      reason: failed.reason ?? failed.missingPrecondition ?? failed.category ?? failed.outcome,
      category: failed.category,
      evidence: outcomeEvidence(failed),
    };
  }
  const finding = r.findings.find((f) => f.severity === 'high') ?? r.findings[0];
  if (!finding) return null;
  return {
    reason: finding.detail,
    category: finding.failureCode ?? finding.kind,
    evidence: [finding.screenshotUri].filter((x): x is string => !!x),
  };
}

/** A blocker that is the dev setup, not the app: a splash or Metro/bundler screen that never went
 *  away ("splash still visible"), a dev server that is down. Checked before the app-regression words,
 *  which include "visible" and "error". */
export const SETUP_BLOCKER_RE = /splash|metro|bundler|bundling|packager|dev[ _-]?server/;

/** Rough owner of the first problem, for the PR summary line. Exported for tests. */
export function likelyReportCategory(problem: { reason: string; category?: string } | null, r: Pick<ReportData, 'appHealth'>): string {
  const raw = `${problem?.category ?? ''} ${problem?.reason ?? ''}`.toLowerCase();
  if (SETUP_BLOCKER_RE.test(raw)) return 'environment/setup';
  if (/accessibility|identifier|locator|element|not found|missing/.test(raw)) return 'automation readiness';
  if (/wda|simulator|emulator|device|install|network|fixture|seed|permission|toolchain/.test(raw)) return 'environment/setup';
  if (r.appHealth === 'error' || r.appHealth === 'degraded' || /assert|visible|crash|error|redbox|logbox/.test(raw))
    return 'app regression';
  return 'unknown';
}

function evidenceSummary(r: ReportData, problem: ReturnType<typeof firstReportProblem>): string {
  const kinds = new Set<string>();
  // The report's own exports (report JSON/Markdown, manifest) are never evidence.
  const artifacts = r.artifacts.filter((a) => !REPORT_EXPORT_KINDS.has(a.kind));
  // The problem's own evidence is usually also in the artifact list: list each URI once.
  const uris = [...new Set([...(problem?.evidence ?? []), ...artifacts.map((a) => a.uri)])];
  for (const a of artifacts) {
    if (a.kind === 'screenshot') kinds.add('screenshot');
    else if (a.kind === 'recording') kinds.add('video');
    else if (a.kind === 'dump') kinds.add('UI tree');
    else if (['logs', 'logcat', 'metro', 'wda'].includes(a.kind)) kinds.add('logs');
    else kinds.add(a.kind);
  }
  return kinds.size ? `${[...kinds].join(', ')} (${uris.slice(0, 5).join(', ')})` : uris.slice(0, 5).join(', ') || 'none recorded';
}

/** Artifact kinds Swipium writes as report output (report.json / report.md / exports, manifest). */
const REPORT_EXPORT_KINDS = new Set(['report', 'manifest']);

function tableCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/** A Markdown-export table cell: pipes escaped and newlines flattened, so the row stays one row. */
function mdCell(s: string): string {
  return tableCell(s.replace(/\r?\n/g, ' '));
}

function compactValue(value: unknown, maxLength = 180): string {
  if (value == null) return '-';
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (!raw) return '-';
  return raw.length > maxLength ? `${raw.slice(0, Math.max(0, maxLength - 1))}…` : raw;
}

function mutationTime(at: number | undefined): string {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : '-';
}

function mutationConsentSummary(m: ReportMutation): string {
  if (!m.consent) return 'not recorded';
  if (!m.consent.required) return 'not required';
  const approval = m.consent.approved ? 'approved' : 'not approved';
  return m.consent.consentId ? `${approval} (${m.consent.consentId})` : approval;
}

function mutationEvidenceSummary(m: ReportMutation): string {
  const parts = [
    m.ledgerUri ? `[ledger](${m.ledgerUri})` : '',
    m.consent?.payloadHash ? `payload ${m.consent.payloadHash.slice(0, 12)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : '-';
}

/** Health badge; 'not checked' (app never reached) and 'unverified' (visual-only) are not OK. */
function healthMark(h: string): string {
  if (h === 'OK') return '✅ OK';
  if (h === 'degraded') return '⚠️ degraded';
  if (h === 'error') return '❌ error';
  if (h === 'unverified') return '⚠️ unverified (visual-only)';
  return h;
}

export function inlinePrSummary(r: ReportData): string {
  const problem = firstReportProblem(r);
  const reason = problem
    ? `${problem.workflow ? `${problem.workflow}: ` : ''}${problem.reason}`
    : (r.executiveSummary.reasons[0] ?? 'No blocking failures detected.');
  const category = likelyReportCategory(problem, r);
  const lines = [
    `Swipium: ${statusWord(r.executiveSummary.risk)}`,
    `Reason: ${reason}.`,
    `Native health: ${r.nativeHealth}. App health: ${r.appHealth}.`,
  ];
  if (r.automationBackend) lines.push(`Backend: ${r.automationBackend.description}.`);
  if (r.readiness?.length) lines.push(`Readiness: ${r.readiness.join(' > ')}.`);
  if (r.automationReadiness) lines.push(`Automation readiness: ${r.automationReadiness.grade} (${r.automationReadiness.score}/100).`);
  lines.push(`Likely category: ${category}.`, `Evidence: ${evidenceSummary(r, problem)}.`, `Next action: ${r.executiveSummary.nextAction}`);
  return lines.join('\n');
}

export function toMarkdown(r: ReportData): string {
  const L: string[] = [];
  const outcomes = latestAttempts(r.testOutcomes);
  const evidenceTaxonomy = r.evidenceTaxonomy ?? evidenceTaxonomyForNotes(outcomes);
  L.push(`# QA report: ${r.appId ?? 'app'}`);
  L.push('');
  L.push('## PR summary', '');
  // The one fenced block. Its fence is longer than any backtick run in the summary, so run text
  // (a reason with a newline and ```) can never close it early.
  const prText = inlinePrSummary(r);
  const fence = codeFence(prText);
  L.push(`${fence}text`);
  const fencedEntry = L.push(prText) - 1;
  L.push(fence);
  L.push('');
  L.push(`**Release risk: ${RISK_BADGE[r.executiveSummary.risk] ?? r.executiveSummary.risk.toUpperCase()}**`);
  if (r.appVerdict || r.coverageVerdict || r.toolVerdict) {
    L.push('');
    if (r.appVerdict) L.push(`**App status:** ${r.appVerdict.status} - ${mdLine(r.appVerdict.summary)}`);
    if (r.coverageVerdict) L.push(`**Coverage status:** ${r.coverageVerdict.status} - ${mdLine(r.coverageVerdict.summary)}`);
    if (r.toolVerdict) L.push(`**Tool status:** ${r.toolVerdict.status} - ${mdLine(r.toolVerdict.summary)}`);
  }
  L.push('');
  L.push(`**Next action:** ${mdLine(r.executiveSummary.nextAction)}`);
  if (r.executiveSummary.reasons.length) {
    L.push('');
    for (const reason of r.executiveSummary.reasons) L.push(`- ${mdLine(reason)}`);
  }
  // Issue memory: durable, cross-run issue ledger summary + recurrence warnings.
  if (r.issuesMarkdown) {
    L.push('');
    L.push(r.issuesMarkdown);
  }
  L.push('');
  L.push(`> ${r.coverage}. Session \`${r.sessionId}\` ${r.device ? `on \`${r.device}\`` : '(no device bound)'}.`);
  if (r.automationBackend) {
    L.push(
      `> Backend: ${r.automationBackend.description} (${r.automationBackend.mode}; structured=${r.automationBackend.structured ? 'yes' : 'no'}).`,
    );
  }
  if (r.readiness?.length) {
    L.push('', '## Capability readiness', '');
    L.push(`- Labels: ${r.readiness.join(' > ')}.`);
    L.push(`- Highest: ${r.readiness.at(-1)}.`);
  }
  if (r.wda) {
    const state = r.wda.status?.reachable ? (r.wda.status.ready === false ? 'reachable/not-ready' : 'reachable') : 'unreachable';
    L.push(`> WDA: ${state} at ${r.wda.webDriverAgentUrl}; device=${r.wda.device ?? 'unknown'}; session=${r.wda.wdaSessionId ?? 'none'}.`);
  }
  if (r.wda?.tuning?.recommendations?.length) {
    L.push('', '## WDA tuning', '');
    for (const rec of r.wda.tuning.recommendations) {
      L.push(
        `- \`${tableCell(rec.setting)}\` = \`${tableCell(compactValue(rec.value, 80))}\`${rec.failureCode ? ` (${rec.failureCode})` : ''}: ${tableCell(rec.reason)}`,
      );
    }
  }

  if (r.automationReadiness) {
    const ar = r.automationReadiness;
    L.push('', '## Automation readiness', '');
    L.push(`- Grade: ${ar.grade} (${ar.score}/100).`);
    L.push(
      `- Durable locator coverage: ${ar.locatorCoverage.durablePct}% (${ar.locatorCoverage.durableActions}/${ar.locatorCoverage.totalActions}); native-or-durable ${ar.locatorCoverage.nativeOrDurablePct}%.`,
    );
    L.push(`- Labels: ${ar.labels.length ? ar.labels.join(', ') : 'none'}.`);
    if (ar.topFixes.length) {
      L.push('- Top fixes:');
      for (const fix of ar.topFixes.slice(0, 10)) L.push(`  - ${mdLine(fix)}`);
    }
    if (ar.workflowGrades.length) {
      L.push('', '| Workflow | Grade | Outcome | Evidence | Fix |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const w of ar.workflowGrades)
        L.push(`| ${mdCell(w.workflow)} | ${w.grade} | ${w.outcome} | ${w.evidence} | ${mdCell(w.fix ?? '-')} |`);
    }
    if (ar.screenGrades.length) {
      L.push('', '| Screen | Grade | Durable locators | Weak actions | Fixes |');
      L.push('| --- | --- | ---: | ---: | --- |');
      for (const s of ar.screenGrades)
        L.push(`| ${mdCell(s.screen)} | ${s.grade} | ${s.durableLocatorPct}% | ${s.weakActions} | ${mdCell(s.fixes.join('; ') || '-')} |`);
    }
    if (ar.prComments.length) {
      L.push('', '### Suggested PR comments', '');
      for (const c of ar.prComments) L.push(`- [${c.severity}] ${mdLine(c.body)}`);
    }
  }

  L.push('', '## Health', '');
  L.push(`- Native: ${healthMark(r.nativeHealth)}`);
  L.push(`- App: ${healthMark(r.appHealth)}`);
  L.push(`- Auth: ${r.authState}`);

  if (outcomes.length) {
    L.push('', '## Workflows', '');
    L.push('| Workflow | Outcome | Notes | Evidence |');
    L.push('| --- | --- | --- | --- |');
    for (const n of outcomes) {
      const step = n.outcome === 'fail' ? failingStep(r, n) : undefined;
      const detail = [
        step ? `failed at step #${step.i} ${step.label}${step.failureCode ? ` (${step.failureCode})` : ''}` : '',
        n.category,
        n.reason,
        n.missingPrecondition ? `missing: ${n.missingPrecondition}` : '',
        n.recommendedSetup ? `setup: ${n.recommendedSetup}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const evidence = outcomeEvidence(n);
      const evidenceCell = evidence.length ? evidence.map((u) => tableCell(mdCode(u))).join(' ') : lacksEvidence(n) ? '(no evidence)' : '-';
      // A "|" or newline in a workflow name / reason must not break the table row.
      L.push(`| ${mdCell(n.workflow)} | ${tableCell(outcomeLabel(n))} | ${detail ? mdCell(detail) : '-'} | ${evidenceCell} |`);
    }

    L.push('', '## Evidence quality', '');
    L.push(`- Deterministic structured locator: ${evidenceTaxonomy.counts.structured_locator}.`);
    L.push(`- Probabilistic visual/OCR/AI evidence: ${evidenceTaxonomy.byAuthority.probabilistic}.`);
    L.push(`- Manual review evidence: ${evidenceTaxonomy.counts.manual_review}.`);
    L.push(
      `- Calibration: ${evidenceTaxonomy.calibration.status}${evidenceTaxonomy.calibration.requiredCorpus ? ` (${evidenceTaxonomy.calibration.requiredCorpus})` : ''}. ${evidenceTaxonomy.calibration.note}`,
    );
    L.push('', '| Workflow | Evidence | Authority | Notes |');
    L.push('| --- | --- | --- | --- |');
    for (const ev of evidenceTaxonomy.assessments) {
      L.push(`| ${tableCell(ev.workflow)} | ${ev.kind} | ${ev.authority} | ${ev.warning ? tableCell(ev.warning) : '-'} |`);
    }
  }

  if (r.flakeClassification && r.flakeClassification.repeat > 1) {
    const f = r.flakeClassification;
    L.push('', '## Flake classification', '');
    L.push(`- ${f.classification}: ${f.passed}/${f.repeat} passed (${f.passRate}%).`);
    L.push(`- Triage: ${mdLine(f.triage.likelyCause)} (${f.triage.confidence} confidence). ${mdLine(f.triage.nextStep)}`);
    for (const ev of f.triage.evidence) L.push(`  - ${mdLine(ev)}`);
  }

  if (r.generatedValues?.length) {
    L.push('', '## Generated test data', '');
    L.push('| Fixture | Field | Generator | Variable | Value | Evidence |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const g of r.generatedValues) {
      L.push(
        `| ${tableCell(g.fixture)} | ${tableCell(g.field)} | ${tableCell(g.generator)} | \`${tableCell(g.varName)}\` | ${g.secret ? '<redacted>' : tableCell(g.value)} | ${g.artifactUri ? `[artifact](${g.artifactUri})` : '-'} |`,
      );
    }
  }

  if (r.findings.length) {
    L.push('', '## Findings', '');
    for (const f of r.findings) {
      const code = f.failureCode ? ` \`${f.failureCode}\`` : '';
      const bucket = f.bucket ? ` ${f.bucket}` : '';
      const retry = f.retrySafe == null ? '' : ` retrySafe=${f.retrySafe}`;
      const next = f.nextStep ? ` Next: ${mdLine(f.nextStep)}` : '';
      L.push(
        `- **[${f.severity}]**${code}${bucket}${retry} ${isToolReportFinding(f) ? 'tool' : (f.layer ?? '?')}/${f.kind}: ${mdLine(f.detail)}${f.count && f.count > 1 ? ` (×${f.count})` : ''}${f.evidence ? `: _"${mdLine(f.evidence)}"_` : ''}${f.screenshotUri ? ` ([screenshot](${f.screenshotUri}))` : ''}${next}`,
      );
    }
  }

  if (r.environmentChanges.length || r.guardrailOverrides.length) {
    L.push('', '## Environment', '');
    L.push(`- Network at end: ${r.finalNetwork} (${r.networkRestore})`);
    if (r.guardrailOverrides.length) L.push(`- ⚠️ Guardrail overrides: ${r.guardrailOverrides.length}`);
    for (const c of r.environmentChanges) L.push(`  - ${mdLine(c)}`);
  }

  // ciMutations is the same list as environmentChanges (kept in the JSON, not rendered twice).

  if (r.mutationLedger?.length) {
    L.push('', '## Mutation ledger', '');
    L.push('| Time | Tool | Action | Risk | Status | Consent | Evidence | Target / detail |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const m of r.mutationLedger) {
      const targetDetail =
        [compactValue(m.target), m.detail ? compactValue(m.detail) : ''].filter((part) => part && part !== '-').join('; ') || '-';
      L.push(
        `| ${tableCell(mutationTime(m.at))} | ${tableCell(m.tool)} | ${tableCell(m.action)} | ${tableCell(m.risk)} | ${tableCell(m.status)} | ${tableCell(mutationConsentSummary(m))} | ${tableCell(mutationEvidenceSummary(m))} | ${tableCell(targetDetail)} |`,
      );
    }
  }

  if (r.redactionDegraded) {
    L.push('', '## Redaction notice', '');
    L.push(
      '- ⚠️ This session was restored after a server restart. Secrets registered before the restart are no longer in the redaction set, so artifacts written after the restart may contain those values unredacted.',
    );
  }

  L.push('', '## Timing & artifacts', '');
  const fmtS = (ms: number | null | undefined): string => `${Math.round((ms ?? 0) / 1000)}s`;
  L.push(
    `- Total ${fmtS(r.phaseTimings.totalMs)} · setup ${fmtS(r.phaseTimings.setupMs)} · active ${fmtS(r.phaseTimings.activeMs)}${r.phaseTimings.timeToLoginMs != null ? ` · to-login ${fmtS(r.phaseTimings.timeToLoginMs)}` : ''}`,
  );
  const d = r.phaseTimings.diagnostics;
  if (d) {
    const parts = [
      d.simulatorBootMs != null ? `boot ${fmtS(d.simulatorBootMs)}` : '',
      d.appInstallMs != null ? `install ${fmtS(d.appInstallMs)}` : '',
      d.appLaunchMs != null ? `launch ${fmtS(d.appLaunchMs)}` : '',
      d.wdaBuildMs != null ? `WDA build ${fmtS(d.wdaBuildMs)}` : '',
      d.wdaStartMs != null ? `WDA start ${fmtS(d.wdaStartMs)}` : '',
      d.wdaReuseCheckMs != null ? `WDA reuse check ${fmtS(d.wdaReuseCheckMs)}` : '',
      d.wdaStartupWaitMs != null ? `WDA ready wait ${fmtS(d.wdaStartupWaitMs)}` : '',
      d.wdaSessionCreateMs != null ? `WDA session ${fmtS(d.wdaSessionCreateMs)}` : '',
      d.wdaSourceMs != null ? `WDA source ${fmtS(d.wdaSourceMs)}` : '',
      d.wdaFindElementMs != null ? `WDA find ${fmtS(d.wdaFindElementMs)}` : '',
      d.wdaTapMs != null ? `WDA tap ${fmtS(d.wdaTapMs)}` : '',
      d.wdaTypeMs != null ? `WDA type ${fmtS(d.wdaTypeMs)}` : '',
      d.wdaClearMs != null ? `WDA clear ${fmtS(d.wdaClearMs)}` : '',
      d.wdaScreenshotMs != null ? `WDA screenshot ${fmtS(d.wdaScreenshotMs)}` : '',
      d.flowRuntimeMs != null ? `flows ${fmtS(d.flowRuntimeMs)}` : '',
      d.waitMs != null ? `wait ${fmtS(d.waitMs)}` : '',
      d.screenshotCount != null ? `screenshots ${d.screenshotCount}` : '',
    ].filter(Boolean);
    if (parts.length) L.push(`- Diagnostics: ${parts.join(' · ')}`);
  }
  L.push(`- ${r.artifacts.length} artifact(s):`);
  for (const a of r.artifacts) L.push(`  - ${mdCode(a.uri)} (${a.kind}${a.label ? `: ${mdLine(a.label)}` : ''})`);

  L.push('', '---', '_Generated by Swipium._');
  // Run text (note reasons, app text, logs) is not trusted HTML: "<" becomes "&lt;" in every entry
  // but the PR-summary fence, so `<img onerror>` / `<script>` render as text. This is per entry,
  // never by scanning for fences, so a fence line smuggled in by run text cannot switch it off.
  return stripControls(L.map((entry, i) => (i === fencedEntry ? entry : entry.replace(/</g, '&lt;'))).join('\n'));
}

/** A single-line Markdown field: newlines flattened, so run text cannot start a line of its own
 *  (a heading, a list item or a code fence). */
function mdLine(s: string): string {
  return s.replace(/\r?\n/g, ' ');
}

/** A backtick fence longer than any backtick run in `content` (at least three), so no line of the
 *  content can close it. */
function codeFence(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Characters XML 1.0 forbids even as character references (https://www.w3.org/TR/xml/#charsets):
 *  C0 controls except TAB/LF/CR, lone UTF-16 surrogates, and U+FFFE/U+FFFF. Logcat/Metro output
 *  routinely carries ANSI escapes (\x1b) and NULs; one such byte makes CI reporters reject the whole
 *  JUnit file, so each is replaced with U+FFFD (visible, and legal). */
const XML_ILLEGAL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripXmlIllegal(s: string): string {
  return s.replace(XML_ILLEGAL, '\uFFFD');
}

/** Escape a string for XML text or attribute position. Newlines are entity-escaped too, so a
 *  multi-line failure reason survives attribute position and round-trips through any XML parser. */
export function escapeXml(s: string): string {
  return stripXmlIllegal(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

/** Map the report's failures onto policy FlowVerdicts (src/report/policy.ts): every recorded
 *  workflow outcome plus every high-severity finding. This is the seam that lets the release-gate
 *  policy (.swipium/policy.json blockOn/warnOn/ignoreKnown) decide the CI pass/fail verdict. */
export function reportPolicyVerdicts(r: ReportData): FlowVerdict[] {
  const verdicts: FlowVerdict[] = [...latestAttempts(r.testOutcomes), ...notReachedOutcomes(r)].map((n) => ({
    flow: n.workflow,
    passed: n.outcome !== 'fail',
    failureCode: n.outcome === 'fail' ? workflowFailureCode(n) : undefined,
    outcome: n.outcome,
    ...(isVisualFailure(n) ? { visual: true } : {}),
  }));
  for (const f of r.findings) {
    if (f.severity === 'high') verdicts.push({ flow: `finding:${f.kind}`, passed: false, failureCode: f.failureCode ?? f.kind });
  }
  return verdicts;
}

/** Flow steps whose failure is a visual comparison, not a structured UI assertion. */
const VISUAL_STEP_KINDS = new Set(['assertImage', 'assertOcrText', 'assertDiff']);
/** Evidence kinds Swipium records when it compared pixels or OCR text itself. */
const VISUAL_EVIDENCE_KINDS = new Set<string>(['visual_match', 'ocr_locator', 'ocr_text']);

/** A failed outcome the policy token `visual_diff` may match: the failing flow step is an image
 *  template / OCR / screenshot-diff assertion, or (without step detail) Swipium's own visual or OCR
 *  evidence. assertVisible / waitForVisible failures and agent verdicts (qa_note, qa_visual assert,
 *  evidence manual_review) are never visual diffs, so a warnOn:["visual_diff"] policy cannot
 *  downgrade them. */
export function isVisualFailure(n: ReportNote): boolean {
  if (n.outcome !== 'fail') return false;
  const failedStep = n.steps?.find((s) => !s.ok);
  if (failedStep) return VISUAL_STEP_KINDS.has(failedStep.kind);
  return n.source !== 'qa_note' && !!n.evidenceKind && VISUAL_EVIDENCE_KINDS.has(n.evidenceKind);
}

/** Name of the synthetic outcome a run that tested nothing gets. */
export const NOT_TESTED_WORKFLOW = 'swipium: not tested';

/** A run that never reached the app, as a synthetic failed workflow: the gate and
 *  JUnit count it, so CI can't go green on a run that tested nothing. */
function notReachedOutcomes(r: ReportData): ReportNote[] {
  const nt = r.notTested;
  if (!nt || (nt.reachedApp && nt.exercised !== false)) return [];
  return [{ workflow: NOT_TESTED_WORKFLOW, outcome: 'fail', category: nt.failureCode ?? 'NOT_TESTED', reason: nt.reason }];
}

/** A failed workflow whose cause is the tool or the environment (device, WDA, install, network...),
 *  not the app: a JUnit <error>, not a <failure>. */
export function isToolOrEnvironmentOutcome(n: ReportNote, r?: Pick<ReportData, 'steps'>): boolean {
  if (n.outcome !== 'fail') return false;
  if (n.category === 'mcp_limitation') return true;
  const code = outcomeFailureCode(r, n);
  const catalog = FAILURES as Record<string, { bucket: string } | undefined>;
  return catalog[code]?.bucket === 'environment';
}

function junitTestcase(lines: string[], name: string, classname: string, timeSec: number, body: string[], systemOut: string[]): void {
  const open = `    <testcase name="${escapeXml(name)}" classname="${escapeXml(classname)}" time="${timeSec}"`;
  if (!body.length && !systemOut.length) {
    lines.push(`${open}></testcase>`);
    return;
  }
  lines.push(`${open}>`);
  lines.push(...body);
  if (systemOut.length) lines.push(`      <system-out>${escapeXml(systemOut.join('\n'))}</system-out>`);
  lines.push(`    </testcase>`);
}

/** Unique testcase names across the report: GitLab (and others) merge cases that share a name. A
 *  repeat gets the hint (a screen) appended, then an index. */
function uniqueCaseNames(): (base: string, hint?: string) => string {
  const used = new Set<string>();
  return (base, hint) => {
    let name = base;
    if (used.has(name) && hint) name = `${base} [${hint}]`;
    for (let k = 2; used.has(name); k++) name = `${base} #${k}`;
    used.add(name);
    return name;
  };
}

/** The policy key reportPolicyVerdicts/applyPolicy use for a failing workflow / high finding
 *  (`${flow}: ${code}`), so exporters can tell which failures the release gate did NOT block. */
function workflowFailureCode(n: ReportNote): string {
  return n.steps?.find((s) => s.failureCode)?.failureCode ?? n.category ?? 'UNKNOWN';
}
/** The failure code of a failed outcome as people see it: the failing timeline step's code (flow
 *  notes since 2.4.0 carry no legacy steps), else the note's own code / category. Not used for
 *  policy keys, so policy matching stays as it was. */
function outcomeFailureCode(r: Pick<ReportData, 'steps'> | undefined, n: ReportNote): string {
  return (r ? failingStep(r, n)?.failureCode : undefined) ?? workflowFailureCode(n);
}
function workflowPolicyKey(n: ReportNote): string {
  return `${n.workflow}: ${workflowFailureCode(n)}`;
}
function findingPolicyKey(f: ReportFinding): string {
  return `finding:${f.kind}: ${f.failureCode ?? f.kind}`;
}

/** Failures the gate let through (warnOn / ignoreKnown), keyed like PolicyDecision entries. */
function nonBlockingFailures(policy?: PolicyDecision): Map<string, 'warned' | 'suppressed'> {
  const out = new Map<string, 'warned' | 'suppressed'>();
  for (const k of policy?.warned ?? []) out.set(k, 'warned');
  for (const k of policy?.suppressed ?? []) out.set(k, 'suppressed');
  // The same key can be both blocked and let through (one workflow failing twice for different
  // reasons); the block wins, so the exports never show a blocking failure as a warning.
  for (const k of policy?.blocked ?? []) out.delete(k);
  return out;
}

type JUnitVerdict = 'failure' | 'error' | 'skipped' | 'pass';

/** JUnit XML for CI test-report sinks. Two suites:
 *   - workflows: one case per workflow (latest attempt wins, a retried workflow is one case, flaky
 *     noted in system-out). fail > <failure type=failureCode message=human text>; a tool /
 *     environment failure or the synthetic "swipium: not tested" case > <error>; blocked / skipped /
 *     not_applicable > <skipped message="blocked: ...">; an unverified pass claim > <skipped>.
 *   - findings: HIGH findings only (app > <failure>, tool / environment > <error>).
 *  Every case has `time` (seconds) from the timeline steps in its range (0 when unknown) and a
 *  unique name. When a release-gate PolicyDecision is provided, it is recorded as testsuite
 *  <properties> AND shapes the verdicts: a failure the policy only warns on or ignores (warnOn /
 *  ignoreKnown) is <skipped message="policy ..."> rather than <failure>, so "gate PASS" never fails CI. */
export function toJUnit(r: ReportData, policy?: PolicyDecision): string {
  const cases = [...latestAttempts(r.testOutcomes), ...notReachedOutcomes(r)];
  const findings = r.findings.filter((f) => f.severity === 'high');
  const lenient = nonBlockingFailures(policy);
  const caseVerdict = (n: ReportNote): JUnitVerdict => {
    if (n.outcome === 'pass') return n.unverified ? 'skipped' : 'pass'; // a claim is not a passing test
    if (n.outcome !== 'fail') return 'skipped';
    if (lenient.has(workflowPolicyKey(n))) return 'skipped';
    return n.workflow === NOT_TESTED_WORKFLOW || isToolOrEnvironmentOutcome(n, r) ? 'error' : 'failure';
  };
  // A tool / environment finding is not an app failure (the gate still fails on it).
  const findingVerdict = (f: ReportFinding): JUnitVerdict =>
    lenient.has(findingPolicyKey(f)) ? 'skipped' : isToolReportFinding(f) ? 'error' : 'failure';
  const caseVerdicts = cases.map(caseVerdict);
  const findingVerdicts = findings.map(findingVerdict);
  const count = (vs: JUnitVerdict[], v: JUnitVerdict) => vs.filter((x) => x === v).length;
  const tally = (vs: JUnitVerdict[]) =>
    `tests="${vs.length}" failures="${count(vs, 'failure')}" errors="${count(vs, 'error')}" skipped="${count(vs, 'skipped')}"`;
  const suiteName = `swipium.${r.appId ?? 'app'}`;
  const timeSec = (r.phaseTimings.totalMs ?? 0) / 1000;
  const name = uniqueCaseNames();
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<testsuites name="${escapeXml(suiteName)}" ${tally([...caseVerdicts, ...findingVerdicts])} time="${timeSec}">`);
  lines.push(`  <testsuite name="${escapeXml(suiteName)}" ${tally(caseVerdicts)} time="${timeSec}">`);
  if (policy) {
    lines.push('    <properties>');
    lines.push(`      <property name="swipium.releaseGate" value="${policy.block ? 'fail' : 'pass'}"></property>`);
    lines.push(`      <property name="swipium.releaseGate.reason" value="${escapeXml(policy.reason)}"></property>`);
    // Additive, same vocabulary as SARIF run.properties.releaseGateVerdict (pass | block).
    lines.push(`      <property name="swipium.releaseGate.verdict" value="${policy.block ? 'block' : 'pass'}"></property>`);
    lines.push('    </properties>');
  }
  cases.forEach((n, idx) => {
    const human = [n.reason, n.missingPrecondition].filter(Boolean).join(': ') || n.category || n.outcome;
    const step = n.outcome === 'fail' ? failingStep(r, n) : undefined;
    const code = step?.failureCode ?? workflowFailureCode(n);
    const body: string[] = [];
    const systemOut: string[] = [];
    if (step) systemOut.push(`failing step #${step.i}: ${step.label}${step.failureCode ? ` (${step.failureCode})` : ''}`);
    if (n.flaky) systemOut.push(`flaky: attempts ${attemptsText(n)} (the latest attempt counts)`);
    if (n.contradicted) systemOut.push('contradicted: a crash, ANR, app error or failed Swipium step falls inside this pass');
    const evidence = outcomeEvidence(n);
    if (evidence.length) systemOut.push(...evidence);
    else if (lacksEvidence(n)) systemOut.push('(no evidence)');
    const verdict = caseVerdicts[idx];
    if (verdict === 'failure' || verdict === 'error') {
      const detail = step ? `${human}\nfailing step #${step.i}: ${step.label}` : human;
      body.push(`      <${verdict} message="${escapeXml(human)}" type="${escapeXml(code)}">${escapeXml(detail)}</${verdict}>`);
    } else if (verdict === 'skipped') {
      const why =
        n.outcome === 'fail'
          ? `policy ${lenient.get(workflowPolicyKey(n))} (release gate not blocked): ${code}: ${human}`
          : n.outcome === 'pass'
            ? `unverified manual claim (qa_note pass that no Swipium check or device evidence backs): ${human}`
            : `${n.outcome.replace(/_/g, ' ')}: ${human}`;
      body.push(`      <skipped message="${escapeXml(why)}"></skipped>`);
    }
    junitTestcase(lines, name(n.workflow, step?.screen), suiteName, outcomeDurationMs(r, n) / 1000, body, systemOut);
  });
  lines.push('  </testsuite>');
  // Always two suites (docs/ci-reports.md), the findings suite empty when nothing high was found.
  const findingsSuite = `${suiteName}.findings`;
  lines.push(`  <testsuite name="${escapeXml(findingsSuite)}" ${tally(findingVerdicts)} time="0">`);
  findings.forEach((f, idx) => {
    const tool = isToolReportFinding(f);
    const code = f.failureCode ?? f.kind;
    const detail = `${f.detail}${f.evidence ? `: "${f.evidence}"` : ''}${f.nextStep ? ` Next: ${f.nextStep}` : ''}`;
    const body: string[] = [];
    const systemOut: string[] = [];
    const verdict = findingVerdicts[idx];
    if (verdict === 'failure' || verdict === 'error') {
      body.push(`      <${verdict} message="${escapeXml(f.detail)}" type="${escapeXml(code)}">${escapeXml(detail)}</${verdict}>`);
    } else {
      body.push(
        `      <skipped message="${escapeXml(`policy ${lenient.get(findingPolicyKey(f))} (release gate not blocked): ${code}`)}"></skipped>`,
      );
      systemOut.push(detail);
    }
    if (f.screenshotUri) systemOut.push(f.screenshotUri);
    if (f.logUri) systemOut.push(f.logUri);
    junitTestcase(
      lines,
      name(`[${f.severity}] ${tool ? 'tool' : (f.layer ?? '?')}/${f.kind}`, f.screen),
      findingsSuite,
      0,
      body,
      systemOut,
    );
  });
  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return lines.join('\n');
}

type SarifLevel = 'error' | 'warning' | 'note';

interface SarifPhysicalLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId?: string };
    region?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  };
  message?: { text: string };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifPhysicalLocation[];
  partialFingerprints: Record<string, string>;
  relatedLocations?: Array<SarifPhysicalLocation & { id: number }>;
  properties?: Record<string, unknown>;
}

/** Options for toSarif. `sources` anchors results to real repo files (see resolveSarifSources). */
export interface SarifOptions {
  sources?: SarifSourceMap;
}

/** An own string entry of a name-keyed lookup table: a screen or workflow named "constructor" or
 *  "__proto__" must never resolve to an Object.prototype member. */
function ownLookup(table: Record<string, string> | undefined, key: string): string | undefined {
  if (!table || !Object.prototype.hasOwnProperty.call(table, key)) return undefined;
  const v = table[key];
  return typeof v === 'string' ? v : undefined;
}

/** Stable 16-hex digest (volatile ids/timestamps scrubbed) for SARIF partialFingerprints. */
function stableHash(...parts: string[]): string {
  return createHash('sha256')
    .update(parts.map((p) => scrubVolatile(p.toLowerCase())).join('|'))
    .digest('hex')
    .slice(0, 16);
}

/** SARIF 2.1.0 for code-scanning sinks (GitHub `upload-sarif`). Experimental. Only HIGH-severity app
 *  findings become results (ruleId = failureCode/kind, level error, or warning / note when the policy
 *  only warns on / ignores it). Workflow failures, tool / environment findings and medium / low
 *  findings are not code alerts and stay in JUnit and the report. Per GitHub's SARIF requirements
 *  (https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning):
 *   - every result has locations[0] > a REAL repo-relative file (`uriBaseId: %SRCROOT%`, full
 *     region at line 1): the app-map source of the screen/workflow when known, else the project
 *     manifest (`options.sources`, built by resolveSarifSources). Results without one are dropped
 *     by code scanning ("at least one location is required").
 *   - partialFingerprints are built from content only (rule, screen, scrubbed detail), never from
 *     the result's position, so reordered findings keep their alerts (`primaryLocationLineHash`
 *     plus `swipium/v1`).
 *   - rules carry short/full descriptions + help from the failure catalog.
 *  swipium:// evidence URIs stay in relatedLocations / properties. invocations[0].executionSuccessful
 *  means "the tool ran" (always true here); the release-gate verdict lives in run.properties. */
export function toSarif(r: ReportData, policy?: PolicyDecision, options: SarifOptions = {}): string {
  const sources = options.sources ?? { defaultUri: 'package.json' };
  const anchor = (file: string): SarifPhysicalLocation => ({
    physicalLocation: {
      artifactLocation: { uri: file, uriBaseId: '%SRCROOT%' },
      region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    },
  });
  const evidenceLocations = (uris: string[]) =>
    uris.length
      ? {
          relatedLocations: uris.map((uri, i) => ({
            id: i + 1,
            physicalLocation: { artifactLocation: { uri } },
            message: { text: 'Swipium evidence artifact (resolve with qa_get_artifact)' },
          })),
        }
      : {};
  // Identical findings are already collapsed into one (findingsDedupe), so content alone is unique.
  const fingerprints = (ruleId: string, screen: string, detail: string) => {
    const hash = stableHash(ruleId, screen, detail);
    return { primaryLocationLineHash: hash, 'swipium/v1': hash };
  };
  // Like JUnit: a failure the policy only warns on is a warning, one it ignores is a note.
  const lenient = nonBlockingFailures(policy);
  const policyLevel = (key: string, level: SarifLevel): SarifLevel => {
    const how = lenient.get(key);
    if (how === 'suppressed') return 'note';
    if (how === 'warned' && level === 'error') return 'warning';
    return level;
  };
  const appFindings = r.findings.filter((f) => f.severity === 'high' && !isToolReportFinding(f));
  const results: SarifResult[] = appFindings.map((f) => {
    const ruleId = f.failureCode ?? f.kind;
    const file = (f.screen && ownLookup(sources.byScreen, f.screen.toLowerCase())) || sources.defaultUri;
    return {
      ruleId,
      level: policyLevel(findingPolicyKey(f), 'error'),
      message: { text: `${f.detail}${f.evidence ? `: "${f.evidence}"` : ''}${f.nextStep ? ` Next: ${f.nextStep}` : ''}` },
      locations: [anchor(file)],
      partialFingerprints: fingerprints(ruleId, f.screen ?? '', f.detail),
      ...evidenceLocations(f.screenshotUri ? [f.screenshotUri] : []),
      properties: {
        severity: f.severity,
        ...(f.layer ? { layer: f.layer } : {}),
        ...(f.bucket ? { bucket: f.bucket } : {}),
        ...(f.screen ? { screen: f.screen } : {}),
        ...(f.retrySafe == null ? {} : { retrySafe: f.retrySafe }),
        ...(f.screenshotUri ? { evidenceUris: [f.screenshotUri] } : {}),
      },
    };
  });
  const catalog = FAILURES as Record<string, { summary: string; recovery: string; bucket: string } | undefined>;
  const rules = [...new Set(results.map((res) => res.ruleId))].map((id) => {
    const info = catalog[id];
    const short = info?.summary ?? `Swipium ${id.replace(/_/g, ' ').toLowerCase()}`;
    const full = info ? `${info.summary}. Bucket: ${info.bucket}.` : `Swipium mobile QA result "${id}" observed on a device run.`;
    const help = info?.recovery ?? 'Open the linked Swipium evidence (screenshots, logs) for this run and reproduce on a device.';
    return {
      id,
      name: id,
      shortDescription: { text: short.slice(0, 1024) },
      fullDescription: { text: full.slice(0, 1024) },
      help: { text: help, markdown: help },
      properties: { tags: ['swipium', 'mobile-qa', ...(info?.bucket ? [info.bucket] : [])] },
    };
  });
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'swipium', informationUri: 'https://github.com/GeroPalombo/swipium', rules } },
        automationDetails: { id: `swipium/${r.appId ?? 'app'}/` },
        originalUriBaseIds: {
          '%SRCROOT%': { description: { text: 'The project root Swipium ran against (repository checkout root in CI).' } },
        },
        invocations: [{ executionSuccessful: true }],
        results,
        properties: {
          sessionId: r.sessionId,
          appId: r.appId,
          device: r.device,
          releaseRisk: r.executiveSummary.risk,
          nextAction: r.executiveSummary.nextAction,
          releaseGateVerdict: policy ? (policy.block ? 'block' : 'pass') : r.executiveSummary.risk === 'block' ? 'block' : 'pass',
          ...(policy ? { releaseGate: policy } : {}),
          // Not a code alert, but a reader of the SARIF alone must still see that nothing was tested.
          ...(notReachedOutcomes(r).length ? { notTested: r.notTested } : {}),
        },
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/** Longest free-text cell in the job summary; one giant log dump must not eat the 1 MiB budget. */
const SUMMARY_CELL_MAX = 2000;

function summaryCell(s: string): string {
  const clipped = s.length > SUMMARY_CELL_MAX ? `${s.slice(0, SUMMARY_CELL_MAX - 1)}…` : s;
  return tableCell(mdText(clipped)).replace(/\r?\n/g, '<br>');
}

/** Neutralize Markdown/HTML in free text shown in the job summary (app ids, device names, policy
 *  reasons, next actions come from the device / project and are not trusted Markdown). */
export function mdText(s: string): string {
  return (
    stripControls(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/([\\`*_[\]#|~])/g, '\\$1')
      // No live @mentions / team pings and no autolinks from run text. A zero-width space
      // after "@" and inside "://" / "www." keeps the text readable but inert on GitHub.
      .replace(/@/g, '@\u200b')
      .replace(/:\/\//g, ':\u200b//')
      .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}\u200b.`)
  );
}

/** Drop ANSI escape sequences and other C0 controls (except TAB/LF/CR) from run text: GitHub renders
 *  a raw ESC as a replacement glyph ("[31m" noise). */
export function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Inline-code span that survives backticks/newlines in the value. */
function mdCode(s: string): string {
  const flat = stripControls(s).replace(/\r?\n/g, ' ');
  return flat.includes('`') ? `\`\` ${flat.replace(/``+/g, '`')} \`\`` : `\`${flat}\``;
}

/** GitHub caps a step summary at 1 MiB (larger uploads are rejected with an error annotation). We
 *  stop at ~900 KB so the verdict survives, and say so. */
export const GITHUB_SUMMARY_MAX_BYTES = 900 * 1024;

/** Failures listed by name in the job summary before "+N more". */
const SUMMARY_MAX_FAILURES = 20;

/** The last line of the job summary: where the human report is. */
export const GITHUB_SUMMARY_FULL_REPORT = 'Full report: the swipium-report.html artifact of this run';

/** GitHub Actions job-summary Markdown (write it to $GITHUB_STEP_SUMMARY), failure first:
 *   1. verdict and reason;
 *   2. the not-tested reason (with the log to read, path only) or the failures (workflow, failing
 *      step, failureCode);
 *   3. the outcomes table; 4. findings; 5. a pointer to the HTML report artifact.
 *  No images (artifact URLs need a login). Capped at GITHUB_SUMMARY_MAX_BYTES with a truncation note. */
export function toGithubSummary(r: ReportData, policy?: PolicyDecision): string {
  const L: string[] = [];
  const outcomes = latestAttempts(r.testOutcomes);
  L.push(`## Swipium QA: ${RISK_BADGE[r.executiveSummary.risk] ?? mdText(r.executiveSummary.risk.toUpperCase())}`);
  L.push('');
  if (policy) L.push(`**Release gate (policy):** ${policy.block ? '❌ BLOCK' : '✅ PASS'}: ${mdText(policy.reason)}`);
  else L.push(`**Verdict:** ${mdText(r.executiveSummary.reasons[0] ?? r.executiveSummary.nextAction)}`);
  L.push('');

  const nt = notReachedOutcomes(r).length ? r.notTested : undefined;
  if (nt) {
    const log = pickNotTestedLog(r);
    const where = log ? `Log: ${mdCode(log.path ?? log.uri)}` : 'No log captured.';
    L.push(`**Not tested:** ${mdText(nt.reason)} (${mdCode(nt.failureCode ?? 'NOT_TESTED')}). ${where}`);
    L.push('');
  }
  const failures = outcomes.filter((n) => n.outcome === 'fail');
  if (failures.length) {
    L.push('### Failures', '');
    for (const n of failures.slice(0, SUMMARY_MAX_FAILURES)) {
      const step = failingStep(r, n);
      const code = step?.failureCode ?? workflowFailureCode(n);
      const where = step ? `step #${step.i} ${summaryCell(step.label)}` : 'no failing step recorded';
      const why = [n.reason, n.missingPrecondition].filter(Boolean).join(': ');
      L.push(
        `- **${summaryCell(n.workflow)}**: ${where} (${mdCode(code)})${why ? `: ${summaryCell(why)}` : ''}${n.flaky ? ' (flaky)' : ''}`,
      );
    }
    if (failures.length > SUMMARY_MAX_FAILURES) L.push(`- +${failures.length - SUMMARY_MAX_FAILURES} more in the full report`);
    L.push('');
  }
  L.push(`**Next action:** ${mdText(r.executiveSummary.nextAction)}`);
  L.push('');

  // Tool / environment findings (WDA_UNREACHABLE) are counted apart from app findings.
  const toolCount = r.findings.filter(isToolReportFinding).length;
  const sevCount = (sev: string) => r.findings.filter((f) => f.severity === sev && !isToolReportFinding(f)).length;
  const tally = latestTally(r)
    .map(([k, v]) => `${k === 'pass (unverified)' ? OUTCOME_MARK.skipped : (OUTCOME_MARK[k] ?? '')} ${mdText(k)}=${v}`)
    .join(' · ');
  L.push(
    `Findings: **${r.highSeverityCount} high** · ${sevCount('medium')} medium · ${sevCount('low')} low${toolCount ? ` · ${toolCount} tool/environment` : ''}. Workflows: ${tally || 'none recorded'}.`,
  );
  if (outcomes.length) {
    L.push('', '### Outcomes', '', '| Workflow | Outcome | Reason | Evidence |', '| --- | --- | --- | --- |');
    for (const n of outcomes) {
      const reason = [n.category, n.reason, n.missingPrecondition].filter(Boolean).join(': ') || '-';
      // swipium:// URIs are not browsable on GitHub: show them as artifact paths, not dead links.
      const uris = outcomeEvidence(n);
      const evidence = uris.length ? uris.map((uri) => tableCell(mdCode(uri))).join(' ') : lacksEvidence(n) ? '(no evidence)' : '-';
      L.push(`| ${summaryCell(n.workflow)} | ${tableCell(outcomeLabel(n))} | ${summaryCell(reason)} | ${evidence} |`);
    }
  }
  if (r.findings.length) {
    L.push('', '### Findings', '', '| Severity | Code | Detail | Evidence |', '| --- | --- | --- | --- |');
    const bySeverity = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const top = [...r.findings].sort((a, b) => (bySeverity[a.severity] ?? 3) - (bySeverity[b.severity] ?? 3)).slice(0, 10);
    for (const f of top) {
      const evidence = f.screenshotUri ? tableCell(mdCode(f.screenshotUri)) : '-';
      const times = f.count && f.count > 1 ? ` (×${f.count})` : '';
      L.push(
        `| ${summaryCell(isToolReportFinding(f) ? `${f.severity} (tool/environment)` : f.severity)} | ${tableCell(mdCode(f.failureCode ?? f.kind))} | ${summaryCell(f.detail)}${times} | ${evidence} |`,
      );
    }
    if (r.findings.length > top.length) L.push('', `+${r.findings.length - top.length} more in the full report.`);
  }
  // Say what is missing instead of printing placeholder words as if they were values.
  L.push(
    '',
    `App ${r.appId ? mdCode(r.appId) : '(not resolved)'} ${r.device ? `on ${mdCode(r.device)}` : '(no device bound)'}, session ${mdCode(r.sessionId)}.`,
  );
  L.push('', GITHUB_SUMMARY_FULL_REPORT);
  return capSummary(L);
}

/** Join lines, dropping trailing ones (whole lines, never mid-table-row) past the byte cap. */
function capSummary(lines: string[]): string {
  const full = lines.join('\n');
  if (Buffer.byteLength(full, 'utf8') <= GITHUB_SUMMARY_MAX_BYTES) return full;
  const note = `\n\n> ⚠️ Summary truncated at ${Math.round(GITHUB_SUMMARY_MAX_BYTES / 1024)} KB (GitHub's step-summary limit is 1 MiB). See the JUnit/SARIF/Markdown exports for the full report.`;
  const budget = GITHUB_SUMMARY_MAX_BYTES - Buffer.byteLength(note, 'utf8');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  return kept.join('\n') + note;
}
