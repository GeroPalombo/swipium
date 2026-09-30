// Report 2.0 exporters. Turn the assembled report into formats a developer
// can use without the agent transcript: an issue-ready Markdown doc and a CI-ready JUnit XML.
// (a third-party-format exporter is deferred and out of scope here.)
//
// Callers pass the report through redactReportData() FIRST (B9): every string field (steps,
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
  artifacts: Array<{ uri: string; kind: string; label?: string }>;
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
 * Deep-redact a report (B9): returns a copy where EVERY string value at any depth (and every string
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

type PlaywrightStatus = 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';

function playwrightStatus(outcome: ReportNote['outcome']): PlaywrightStatus {
  if (outcome === 'pass') return 'passed';
  if (outcome === 'fail') return 'failed';
  return 'skipped';
}

function playwrightDuration(n: ReportNote): number {
  return Math.round(n.steps?.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) ?? 0);
}

function playwrightAttachments(n: ReportNote): Array<{ name: string; contentType: string; path: string }> {
  return (n.artifactUris ?? []).map((uri, i) => ({
    name: `artifact-${i + 1}`,
    contentType: uri.match(/\.(png|jpg|jpeg|webp)$/i) ? 'image/*' : 'application/octet-stream',
    path: uri,
  }));
}

export function toPlaywrightJson(r: ReportData): string {
  const generatedAt = new Date().toISOString();
  const evidenceTaxonomy = r.evidenceTaxonomy ?? evidenceTaxonomyForNotes(r.testOutcomes);
  const evidenceByWorkflow = new Map(evidenceTaxonomy.assessments.map((a) => [a.workflow, a]));
  const specs = r.testOutcomes.map((n) => {
    const status = playwrightStatus(n.outcome);
    const message = [n.category, n.reason, n.missingPrecondition, n.recommendedSetup].filter(Boolean).join(': ') || n.outcome;
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
              duration: playwrightDuration(n),
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
  const skipped = r.testOutcomes.filter((n) => playwrightStatus(n.outcome) === 'skipped').length;
  const payload = {
    schema: 'swipium.playwright.report.v1',
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
      flaky: r.flakeClassification?.classification === 'flaky' ? 1 : 0,
      duration: Math.round(r.phaseTimings.totalMs ?? 0),
    },
    errors: failed ? [{ message: r.executiveSummary.nextAction }] : [],
  };
  return JSON.stringify(payload, null, 2);
}

const RISK_BADGE: Record<string, string> = { ship: '🟢 SHIP', caution: '🟡 CAUTION', block: '🔴 BLOCK' };
const OUTCOME_MARK: Record<string, string> = { pass: '✅', fail: '❌', blocked: '⛔', skipped: '⏭️', not_applicable: '➖' };

function statusWord(risk: string): string {
  return risk === 'block' ? 'BLOCK' : risk === 'caution' ? 'CAUTION' : 'SHIP';
}

function firstReportProblem(r: ReportData): { reason: string; category?: string; workflow?: string; evidence?: string[] } | null {
  const failed = r.testOutcomes.find((o) => o.outcome === 'fail' || o.outcome === 'blocked');
  if (failed) {
    return {
      workflow: failed.workflow,
      reason: failed.reason ?? failed.missingPrecondition ?? failed.category ?? failed.outcome,
      category: failed.category,
      evidence: failed.artifactUris,
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

function likelyReportCategory(problem: ReturnType<typeof firstReportProblem>, r: ReportData): string {
  const raw = `${problem?.category ?? ''} ${problem?.reason ?? ''}`.toLowerCase();
  if (/accessibility|identifier|locator|element|not found|missing/.test(raw)) return 'automation readiness';
  if (/wda|simulator|emulator|device|install|network|fixture|seed|permission|toolchain/.test(raw)) return 'environment/setup';
  if (r.appHealth !== 'OK' || /assert|visible|crash|error|redbox|logbox/.test(raw)) return 'app regression';
  return 'unknown';
}

function evidenceSummary(r: ReportData, problem: ReturnType<typeof firstReportProblem>): string {
  const kinds = new Set<string>();
  const uris = [...(problem?.evidence ?? []), ...r.artifacts.map((a) => a.uri)];
  for (const a of r.artifacts) {
    if (a.kind === 'screenshot') kinds.add('screenshot');
    else if (a.kind === 'recording') kinds.add('video');
    else if (a.kind === 'dump') kinds.add('UI tree');
    else if (['logs', 'logcat', 'metro', 'wda'].includes(a.kind)) kinds.add('logs');
    else kinds.add(a.kind);
  }
  return kinds.size ? `${[...kinds].join(', ')} (${uris.slice(0, 5).join(', ')})` : uris.slice(0, 5).join(', ') || 'none recorded';
}

function tableCell(s: string): string {
  return s.replace(/\|/g, '\\|');
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
  const evidenceTaxonomy = r.evidenceTaxonomy ?? evidenceTaxonomyForNotes(r.testOutcomes);
  L.push(`# QA report: ${r.appId ?? 'app'}`);
  L.push('');
  L.push('## PR summary', '');
  L.push('```text');
  L.push(inlinePrSummary(r));
  L.push('```');
  L.push('');
  L.push(`**Release risk: ${RISK_BADGE[r.executiveSummary.risk] ?? r.executiveSummary.risk.toUpperCase()}**`);
  if (r.appVerdict || r.coverageVerdict || r.toolVerdict) {
    L.push('');
    if (r.appVerdict) L.push(`**App status:** ${r.appVerdict.status} - ${r.appVerdict.summary}`);
    if (r.coverageVerdict) L.push(`**Coverage status:** ${r.coverageVerdict.status} - ${r.coverageVerdict.summary}`);
    if (r.toolVerdict) L.push(`**Tool status:** ${r.toolVerdict.status} - ${r.toolVerdict.summary}`);
  }
  L.push('');
  L.push(`**Next action:** ${r.executiveSummary.nextAction}`);
  if (r.executiveSummary.reasons.length) {
    L.push('');
    for (const reason of r.executiveSummary.reasons) L.push(`- ${reason}`);
  }
  // Issue memory: durable, cross-run issue ledger summary + recurrence warnings.
  if (r.issuesMarkdown) {
    L.push('');
    L.push(r.issuesMarkdown);
  }
  L.push('');
  L.push(`> ${r.coverage}. Session \`${r.sessionId}\` on \`${r.device ?? 'device'}\`.`);
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
      for (const fix of ar.topFixes.slice(0, 10)) L.push(`  - ${fix}`);
    }
    if (ar.workflowGrades.length) {
      L.push('', '| Workflow | Grade | Outcome | Evidence | Fix |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const w of ar.workflowGrades)
        L.push(`| ${w.workflow} | ${w.grade} | ${w.outcome} | ${w.evidence} | ${(w.fix ?? '-').replace(/\|/g, '\\|')} |`);
    }
    if (ar.screenGrades.length) {
      L.push('', '| Screen | Grade | Durable locators | Weak actions | Fixes |');
      L.push('| --- | --- | ---: | ---: | --- |');
      for (const s of ar.screenGrades)
        L.push(
          `| ${s.screen} | ${s.grade} | ${s.durableLocatorPct}% | ${s.weakActions} | ${(s.fixes.join('; ') || '-').replace(/\|/g, '\\|')} |`,
        );
    }
    if (ar.prComments.length) {
      L.push('', '### Suggested PR comments', '');
      for (const c of ar.prComments) L.push(`- [${c.severity}] ${c.body}`);
    }
  }

  L.push('', '## Health', '');
  L.push(`- Native: ${r.nativeHealth === 'OK' ? '✅ OK' : '❌ error'}`);
  L.push(`- App: ${r.appHealth === 'OK' ? '✅ OK' : r.appHealth === 'degraded' ? '⚠️ degraded' : '❌ error'}`);
  L.push(`- Auth: ${r.authState}`);

  if (r.testOutcomes.length) {
    L.push('', '## Workflows', '');
    L.push('| Workflow | Outcome | Notes |');
    L.push('| --- | --- | --- |');
    for (const n of r.testOutcomes) {
      const detail = [
        n.category,
        n.reason,
        n.missingPrecondition ? `missing: ${n.missingPrecondition}` : '',
        n.recommendedSetup ? `setup: ${n.recommendedSetup}` : '',
      ]
        .filter(Boolean)
        .join('; ')
        .replace(/\|/g, '\\|');
      L.push(`| ${n.workflow} | ${OUTCOME_MARK[n.outcome] ?? ''} ${n.outcome} | ${detail || '-'} |`);
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
    L.push(`- Triage: ${f.triage.likelyCause} (${f.triage.confidence} confidence). ${f.triage.nextStep}`);
    for (const ev of f.triage.evidence) L.push(`  - ${ev}`);
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
      const next = f.nextStep ? ` Next: ${f.nextStep}` : '';
      L.push(
        `- **[${f.severity}]**${code}${bucket}${retry} ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.count && f.count > 1 ? ` (×${f.count})` : ''}${f.evidence ? `: _"${f.evidence}"_` : ''}${f.screenshotUri ? ` ([screenshot](${f.screenshotUri}))` : ''}${next}`,
      );
    }
  }

  if (r.environmentChanges.length || r.guardrailOverrides.length) {
    L.push('', '## Environment', '');
    L.push(`- Network at end: ${r.finalNetwork} (${r.networkRestore})`);
    if (r.guardrailOverrides.length) L.push(`- ⚠️ Guardrail overrides: ${r.guardrailOverrides.length}`);
    for (const c of r.environmentChanges) L.push(`  - ${c}`);
  }

  if (r.ciMutations?.length) {
    L.push('', '## CI mutations', '');
    for (const c of r.ciMutations) L.push(`- ${c}`);
  }

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
  for (const a of r.artifacts) L.push(`  - \`${a.uri}\` (${a.kind}${a.label ? `: ${a.label}` : ''})`);

  L.push('', '---', '_Generated by Swipium._');
  return L.join('\n');
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
  const verdicts: FlowVerdict[] = r.testOutcomes.map((n) => ({
    flow: n.workflow,
    passed: n.outcome !== 'fail',
    failureCode: n.outcome === 'fail' ? workflowFailureCode(n) : undefined,
  }));
  for (const f of r.findings) {
    if (f.severity === 'high') verdicts.push({ flow: `finding:${f.kind}`, passed: false, failureCode: f.failureCode ?? f.kind });
  }
  return verdicts;
}

function junitTestcase(lines: string[], name: string, classname: string, body: string[], systemOut: string[]): void {
  if (!body.length && !systemOut.length) {
    lines.push(`    <testcase name="${escapeXml(name)}" classname="${escapeXml(classname)}"></testcase>`);
    return;
  }
  lines.push(`    <testcase name="${escapeXml(name)}" classname="${escapeXml(classname)}">`);
  lines.push(...body);
  if (systemOut.length) lines.push(`      <system-out>${escapeXml(systemOut.join('\n'))}</system-out>`);
  lines.push(`    </testcase>`);
}

/** The policy key reportPolicyVerdicts/applyPolicy use for a failing workflow / high finding
 *  (`${flow}: ${code}`), so exporters can tell which failures the release gate did NOT block. */
function workflowFailureCode(n: ReportNote): string {
  return n.steps?.find((s) => s.failureCode)?.failureCode ?? n.category ?? 'UNKNOWN';
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
  return out;
}

/** JUnit XML for CI test-report sinks. Two suites: recorded workflow outcomes (fail > <failure>;
 *  blocked/skipped/not_applicable > <skipped>) and findings (high > <failure>, medium/low pass with
 *  the detail in system-out). Evidence URIs are listed in each testcase's system-out. When a
 *  release-gate PolicyDecision is provided, it is recorded as testsuite <properties> AND it shapes
 *  the verdicts (D5): a failure the policy only warns on or ignores (warnOn / ignoreKnown) is
 *  emitted as <skipped message="policy …"> rather than <failure>, so "gate PASS" never fails CI. */
export function toJUnit(r: ReportData, policy?: PolicyDecision): string {
  const cases = r.testOutcomes;
  const lenient = nonBlockingFailures(policy);
  const caseVerdict = (n: ReportNote): 'failure' | 'skipped' | 'pass' => {
    if (n.outcome === 'pass') return 'pass';
    if (n.outcome !== 'fail') return 'skipped';
    return lenient.has(workflowPolicyKey(n)) ? 'skipped' : 'failure';
  };
  const findingVerdict = (f: ReportFinding): 'failure' | 'skipped' | 'pass' =>
    f.severity !== 'high' ? 'pass' : lenient.has(findingPolicyKey(f)) ? 'skipped' : 'failure';
  const failures = cases.filter((n) => caseVerdict(n) === 'failure').length;
  const skipped = cases.filter((n) => caseVerdict(n) === 'skipped').length;
  const findingFailures = r.findings.filter((f) => findingVerdict(f) === 'failure').length;
  const findingSkipped = r.findings.filter((f) => findingVerdict(f) === 'skipped').length;
  const suiteName = `swipium.${r.appId ?? 'app'}`;
  const timeSec = (r.phaseTimings.totalMs ?? 0) / 1000;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(
    `<testsuites name="${escapeXml(suiteName)}" tests="${cases.length + r.findings.length}" failures="${failures + findingFailures}" skipped="${skipped + findingSkipped}" time="${timeSec}">`,
  );
  lines.push(
    `  <testsuite name="${escapeXml(suiteName)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${timeSec}">`,
  );
  if (policy) {
    lines.push('    <properties>');
    lines.push(`      <property name="swipium.releaseGate" value="${policy.block ? 'fail' : 'pass'}"></property>`);
    lines.push(`      <property name="swipium.releaseGate.reason" value="${escapeXml(policy.reason)}"></property>`);
    lines.push('    </properties>');
  }
  for (const n of cases) {
    const text = [n.category, n.reason, n.missingPrecondition].filter(Boolean).join(': ') || n.outcome;
    const body: string[] = [];
    const verdict = caseVerdict(n);
    if (verdict === 'failure') body.push(`      <failure message="${escapeXml(text)}">${escapeXml(text)}</failure>`);
    else if (verdict === 'skipped') {
      const why = n.outcome === 'fail' ? `policy ${lenient.get(workflowPolicyKey(n))} (release gate not blocked): ${text}` : text;
      body.push(`      <skipped message="${escapeXml(why)}"></skipped>`);
    }
    junitTestcase(lines, n.workflow, suiteName, body, n.artifactUris ?? []);
  }
  lines.push('  </testsuite>');
  if (r.findings.length) {
    const findingsSuite = `${suiteName}.findings`;
    lines.push(
      `  <testsuite name="${escapeXml(findingsSuite)}" tests="${r.findings.length}" failures="${findingFailures}" skipped="${findingSkipped}" time="0">`,
    );
    for (const f of r.findings) {
      const name = `[${f.severity}] ${f.layer ?? '?'}/${f.kind}`;
      const detail = `${f.detail}${f.evidence ? `: "${f.evidence}"` : ''}${f.nextStep ? ` Next: ${f.nextStep}` : ''}`;
      const body: string[] = [];
      const systemOut: string[] = f.screenshotUri ? [f.screenshotUri] : [];
      const verdict = findingVerdict(f);
      if (verdict === 'failure') body.push(`      <failure message="${escapeXml(f.failureCode ?? f.kind)}">${escapeXml(detail)}</failure>`);
      else if (verdict === 'skipped') {
        body.push(
          `      <skipped message="${escapeXml(`policy ${lenient.get(findingPolicyKey(f))} (release gate not blocked): ${f.failureCode ?? f.kind}`)}"></skipped>`,
        );
        systemOut.unshift(detail);
      } else systemOut.unshift(detail);
      junitTestcase(lines, name, findingsSuite, body, systemOut);
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return lines.join('\n');
}

type SarifLevel = 'error' | 'warning' | 'note';

function sarifLevel(severity: string): SarifLevel {
  return severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'note';
}

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

/** Stable 16-hex digest (volatile ids/timestamps scrubbed) for SARIF partialFingerprints. */
function stableHash(...parts: string[]): string {
  return createHash('sha256')
    .update(parts.map((p) => scrubVolatile(p.toLowerCase())).join('|'))
    .digest('hex')
    .slice(0, 16);
}

/** SARIF 2.1.0 for code-scanning sinks (GitHub `upload-sarif`). Findings > results with
 *  ruleId = failureCode/kind and level from severity (high > error, medium > warning, low > note); failed
 *  workflows are results too. Per GitHub's SARIF requirements
 *  (https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning):
 *   - every result has locations[0] > a REAL repo-relative file (`uriBaseId: %SRCROOT%`, full
 *     region at line 1): the app-map source of the screen/workflow when known, else the project
 *     manifest (`options.sources`, built by resolveSarifSources). Results without one are dropped
 *     by code scanning ("at least one location is required").
 *   - partialFingerprints carry a stable per-result hash (own `primaryLocationLineHash`, so results
 *     anchored to the same manifest line don't collapse into one alert) plus `swipium/v1`.
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
  const seen = new Map<string, number>();
  const fingerprints = (ruleId: string, ...identity: string[]) => {
    const base = stableHash(ruleId, ...identity);
    // Two genuinely identical results in one run still need distinct alerts-per-occurrence ids.
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { primaryLocationLineHash: `${base}:${n}`, 'swipium/v1': `${base}:${n}` };
  };
  const results: SarifResult[] = r.findings.map((f) => {
    const ruleId = f.failureCode ?? f.kind;
    const file = (f.screen && sources.byScreen?.[f.screen.toLowerCase()]) || sources.defaultUri;
    return {
      ruleId,
      level: sarifLevel(f.severity),
      message: { text: `${f.detail}${f.evidence ? `: "${f.evidence}"` : ''}${f.nextStep ? ` Next: ${f.nextStep}` : ''}` },
      locations: [anchor(file)],
      partialFingerprints: fingerprints(ruleId, f.kind, f.screen ?? '', f.detail),
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
  for (const n of r.testOutcomes) {
    if (n.outcome !== 'fail') continue;
    const ruleId = n.steps?.find((s) => s.failureCode)?.failureCode ?? n.category ?? 'WORKFLOW_FAILED';
    const file = sources.byWorkflow?.[n.workflow.toLowerCase()] ?? sources.defaultUri;
    results.push({
      ruleId,
      level: 'error',
      message: { text: `${n.workflow}: ${[n.reason, n.missingPrecondition].filter(Boolean).join('; ') || 'workflow failed'}` },
      locations: [anchor(file)],
      partialFingerprints: fingerprints(ruleId, 'workflow', n.workflow),
      ...evidenceLocations(n.artifactUris ?? []),
      properties: {
        workflow: n.workflow,
        outcome: n.outcome,
        ...(n.category ? { category: n.category } : {}),
        ...(n.artifactUris?.length ? { evidenceUris: n.artifactUris } : {}),
      },
    });
  }
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
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]#|~])/g, '\\$1');
}

/** Inline-code span that survives backticks/newlines in the value. */
function mdCode(s: string): string {
  const flat = s.replace(/\r?\n/g, ' ');
  return flat.includes('`') ? `\`\` ${flat.replace(/``+/g, '`')} \`\`` : `\`${flat}\``;
}

/** GitHub caps a step summary at 1 MiB (larger uploads are rejected with an error annotation). We
 *  stop at ~900 KB so the verdict survives, and say so. */
export const GITHUB_SUMMARY_MAX_BYTES = 900 * 1024;

/** Concise GitHub Actions job-summary Markdown (write it to $GITHUB_STEP_SUMMARY): verdict,
 *  counts by severity, top findings table, workflow outcomes, and evidence links. Capped at
 *  GITHUB_SUMMARY_MAX_BYTES with a truncation note. */
export function toGithubSummary(r: ReportData, policy?: PolicyDecision): string {
  const L: string[] = [];
  L.push(`## Swipium QA: ${RISK_BADGE[r.executiveSummary.risk] ?? mdText(r.executiveSummary.risk.toUpperCase())}`);
  L.push('');
  L.push(`App ${mdCode(r.appId ?? 'unknown')} on ${mdCode(r.device ?? 'device')}, session ${mdCode(r.sessionId)}.`);
  L.push('');
  if (policy) L.push(`**Release gate (policy):** ${policy.block ? '❌ FAIL' : '✅ PASS'}: ${mdText(policy.reason)}`, '');
  L.push(`**Next action:** ${mdText(r.executiveSummary.nextAction)}`);
  L.push('');
  const sevCount = (sev: string) => r.findings.filter((f) => f.severity === sev).length;
  const outcomes = Object.entries(r.outcomeTally)
    .map(([k, v]) => `${OUTCOME_MARK[k] ?? ''} ${mdText(k)}=${v}`)
    .join(' · ');
  L.push(
    `Findings: **${sevCount('high')} high** · ${sevCount('medium')} medium · ${sevCount('low')} low. Workflows: ${outcomes || 'none recorded'}.`,
  );
  if (r.findings.length) {
    L.push('', '### Top findings', '', '| Severity | Code | Detail | Evidence |', '| --- | --- | --- | --- |');
    const bySeverity = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const top = [...r.findings].sort((a, b) => (bySeverity[a.severity] ?? 3) - (bySeverity[b.severity] ?? 3)).slice(0, 10);
    for (const f of top) {
      const evidence = f.screenshotUri ? `[screenshot](${f.screenshotUri})` : '-';
      const times = f.count && f.count > 1 ? ` (×${f.count})` : '';
      L.push(
        `| ${summaryCell(f.severity)} | ${tableCell(mdCode(f.failureCode ?? f.kind))} | ${summaryCell(f.detail)}${times} | ${evidence} |`,
      );
    }
  }
  const problems = r.testOutcomes.filter((n) => n.outcome !== 'pass');
  if (problems.length) {
    L.push('', '### Failed / blocked workflows', '', '| Workflow | Outcome | Reason | Evidence |', '| --- | --- | --- | --- |');
    for (const n of problems) {
      const reason = [n.category, n.reason, n.missingPrecondition].filter(Boolean).join(': ') || '-';
      const evidence = (n.artifactUris ?? []).map((uri, i) => `[${i + 1}](${uri})`).join(' ') || '-';
      L.push(`| ${summaryCell(n.workflow)} | ${OUTCOME_MARK[n.outcome] ?? ''} ${n.outcome} | ${summaryCell(reason)} | ${evidence} |`);
    }
  }
  const evidenceArtifacts = r.artifacts.filter((a) => ['screenshot', 'recording', 'report'].includes(a.kind)).slice(0, 10);
  if (evidenceArtifacts.length) {
    L.push('', '### Evidence', '');
    for (const a of evidenceArtifacts) L.push(`- ${mdCode(a.uri)} (${mdText(a.kind)}${a.label ? `: ${mdText(a.label)}` : ''})`);
  }
  L.push('', '_Generated by Swipium._');
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
