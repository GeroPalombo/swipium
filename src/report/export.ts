// Report 2.0 exporters (PHASE3-PLAN §3.5). Turn the assembled report into formats a developer
// can use without the agent transcript: an issue-ready Markdown doc and a CI-ready JUnit XML.
// (a third-party-format exporter is deferred — out of scope here.)
//
// These consume the already-redacted report object, so no secret ever reaches an export.

import type { AutomationReadinessStandard, ReadinessLabel } from './readiness.js';
import type { FlakeClassification } from './flake.js';
import { evidenceTaxonomyForNotes, type EvidenceKind, type EvidenceMethod, type EvidenceTaxonomy } from './evidence.js';

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
  steps?: Array<{ index: number; phase?: string; kind: string; summary?: string; ok: boolean; durationSec?: number; failureCode?: string }>;
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
  screenshotUri?: string;
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
  guardrailOverrides: string[];
  finalNetwork: string;
  networkRestore: string;
  authState: string;
  phaseTimings: {
    totalSec: number | null;
    setupSec: number | null;
    activeSec: number | null;
    timeToLoginSec: number | null;
    diagnostics?: {
      simulatorBootSec: number | null;
      appInstallSec: number | null;
      appLaunchSec: number | null;
      wdaBuildSec: number | null;
      wdaStartSec: number | null;
      wdaReuseCheckSec?: number | null;
      wdaStartupWaitSec?: number | null;
      wdaSessionCreateSec?: number | null;
      wdaSourceSec?: number | null;
      wdaFindElementSec?: number | null;
      wdaTapSec?: number | null;
      wdaTypeSec?: number | null;
      wdaClearSec?: number | null;
      wdaScreenshotSec?: number | null;
      flowRuntimeSec: number | null;
      waitSec: number | null;
      screenshotCount?: number | null;
    };
  };
  artifacts: Array<{ uri: string; kind: string; label?: string }>;
  generatedValues?: Array<{ fixture: string; field: string; varName: string; generator: string; value: string; secret: boolean; artifactUri?: string }>;
  prSummary?: { text: string };
  flakeClassification?: FlakeClassification;
  /** Issue-memory markdown block (SWIPIUM-REQ-07), pre-rendered by the issues report bridge. */
  issuesMarkdown?: string;
  issueRecurrences?: string[];
}

type PlaywrightStatus = 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';

function playwrightStatus(outcome: ReportNote['outcome']): PlaywrightStatus {
  if (outcome === 'pass') return 'passed';
  if (outcome === 'fail') return 'failed';
  return 'skipped';
}

function playwrightDuration(n: ReportNote): number {
  const sec = n.steps?.reduce((sum, s) => sum + (s.durationSec ?? 0), 0) ?? 0;
  return Math.round(sec * 1000);
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
      tests: [{
        timeout: 0,
        expectedStatus: 'passed',
        projectName: r.automationBackend?.mode ?? 'swipium',
        results: [{
          workerIndex: 0,
          status,
          duration: playwrightDuration(n),
          errors: status === 'failed' ? [{ message }] : [],
          attachments: playwrightAttachments(n),
          stdout: [],
          stderr: [],
          retry: 0,
          startTime: generatedAt,
        }],
        status,
        annotations: [
          ...(status === 'skipped' ? [{ type: n.outcome, description: message }] : []),
          ...(evidence?.warning ? [{ type: 'evidence', description: evidence.warning }] : []),
        ],
      }],
      file: `swipium://${r.sessionId}/${n.workflow}`,
      line: 1,
      column: 1,
    };
  });
  const findingSpecs = r.findings.map((f, i) => ({
    title: `${f.failureCode ?? f.kind}: ${f.detail}`,
    ok: f.severity !== 'high',
    tags: [f.bucket, f.severity, f.layer].filter(Boolean),
    tests: [{
      timeout: 0,
      expectedStatus: 'passed',
      projectName: r.automationBackend?.mode ?? 'swipium',
      results: [{
        workerIndex: 0,
        status: f.severity === 'high' ? 'failed' as PlaywrightStatus : 'passed' as PlaywrightStatus,
        duration: 0,
        errors: f.severity === 'high' ? [{ message: f.detail, location: { file: f.screenshotUri ?? `swipium://${r.sessionId}/finding/${i + 1}`, line: 1, column: 1 } }] : [],
        attachments: f.screenshotUri ? [{ name: 'screenshot', contentType: 'image/*', path: f.screenshotUri }] : [],
        stdout: [],
        stderr: [],
        retry: 0,
        startTime: generatedAt,
      }],
      status: f.severity === 'high' ? 'failed' as PlaywrightStatus : 'passed' as PlaywrightStatus,
      annotations: f.nextStep ? [{ type: 'nextStep', description: f.nextStep }] : [],
    }],
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
    suites: [{
      title: `Swipium ${r.appId ?? 'app'}`,
      file: `swipium://${r.sessionId}/report`,
      specs: allSpecs,
    }],
    stats: {
      expected: allSpecs.length - failed - skipped,
      skipped,
      unexpected: failed,
      flaky: r.flakeClassification?.classification === 'flaky' ? 1 : 0,
      duration: Math.round((r.phaseTimings.totalSec ?? 0) * 1000),
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
  if (value == null) return '—';
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (!raw) return '—';
  return raw.length > maxLength ? `${raw.slice(0, Math.max(0, maxLength - 1))}…` : raw;
}

function mutationTime(at: number | undefined): string {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : '—';
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
  return parts.length ? parts.join('; ') : '—';
}

export function inlinePrSummary(r: ReportData): string {
  const problem = firstReportProblem(r);
  const reason = problem ? `${problem.workflow ? `${problem.workflow}: ` : ''}${problem.reason}` : r.executiveSummary.reasons[0] ?? 'No blocking failures detected.';
  const category = likelyReportCategory(problem, r);
  const lines = [
    `Swipium: ${statusWord(r.executiveSummary.risk)}`,
    `Reason: ${reason}.`,
    `Native health: ${r.nativeHealth}. App health: ${r.appHealth}.`,
  ];
  if (r.automationBackend) lines.push(`Backend: ${r.automationBackend.description}.`);
  if (r.readiness?.length) lines.push(`Readiness: ${r.readiness.join(' → ')}.`);
  if (r.automationReadiness) lines.push(`Automation readiness: ${r.automationReadiness.grade} (${r.automationReadiness.score}/100).`);
  lines.push(
    `Likely category: ${category}.`,
    `Evidence: ${evidenceSummary(r, problem)}.`,
    `Next action: ${r.executiveSummary.nextAction}`,
  );
  return lines.join('\n');
}

export function toMarkdown(r: ReportData): string {
  const L: string[] = [];
  const evidenceTaxonomy = r.evidenceTaxonomy ?? evidenceTaxonomyForNotes(r.testOutcomes);
  L.push(`# QA report — ${r.appId ?? 'app'}`);
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
  // Issue memory (SWIPIUM-REQ-07): durable, cross-run issue ledger summary + recurrence warnings.
  if (r.issuesMarkdown) {
    L.push('');
    L.push(r.issuesMarkdown);
  }
  L.push('');
  L.push(`> ${r.coverage}. Session \`${r.sessionId}\` on \`${r.device ?? 'device'}\`.`);
  if (r.automationBackend) {
    L.push(`> Backend: ${r.automationBackend.description} (${r.automationBackend.mode}; structured=${r.automationBackend.structured ? 'yes' : 'no'}).`);
  }
  if (r.readiness?.length) {
    L.push('', '## Capability readiness', '');
    L.push(`- Labels: ${r.readiness.join(' → ')}.`);
    L.push(`- Highest: ${r.readiness.at(-1)}.`);
  }
  if (r.wda) {
    const state = r.wda.status?.reachable ? (r.wda.status.ready === false ? 'reachable/not-ready' : 'reachable') : 'unreachable';
    L.push(`> WDA: ${state} at ${r.wda.webDriverAgentUrl}; device=${r.wda.device ?? 'unknown'}; session=${r.wda.wdaSessionId ?? 'none'}.`);
  }
  if (r.wda?.tuning?.recommendations?.length) {
    L.push('', '## WDA tuning', '');
    for (const rec of r.wda.tuning.recommendations) {
      L.push(`- \`${tableCell(rec.setting)}\` = \`${tableCell(compactValue(rec.value, 80))}\`${rec.failureCode ? ` (${rec.failureCode})` : ''}: ${tableCell(rec.reason)}`);
    }
  }

  if (r.automationReadiness) {
    const ar = r.automationReadiness;
    L.push('', '## Automation readiness', '');
    L.push(`- Grade: ${ar.grade} (${ar.score}/100).`);
    L.push(`- Durable locator coverage: ${ar.locatorCoverage.durablePct}% (${ar.locatorCoverage.durableActions}/${ar.locatorCoverage.totalActions}); native-or-durable ${ar.locatorCoverage.nativeOrDurablePct}%.`);
    L.push(`- Labels: ${ar.labels.length ? ar.labels.join(', ') : 'none'}.`);
    if (ar.topFixes.length) {
      L.push('- Top fixes:');
      for (const fix of ar.topFixes.slice(0, 10)) L.push(`  - ${fix}`);
    }
    if (ar.workflowGrades.length) {
      L.push('', '| Workflow | Grade | Outcome | Evidence | Fix |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const w of ar.workflowGrades) L.push(`| ${w.workflow} | ${w.grade} | ${w.outcome} | ${w.evidence} | ${(w.fix ?? '-').replace(/\|/g, '\\|')} |`);
    }
    if (ar.screenGrades.length) {
      L.push('', '| Screen | Grade | Durable locators | Weak actions | Fixes |');
      L.push('| --- | --- | ---: | ---: | --- |');
      for (const s of ar.screenGrades) L.push(`| ${s.screen} | ${s.grade} | ${s.durableLocatorPct}% | ${s.weakActions} | ${(s.fixes.join('; ') || '-').replace(/\|/g, '\\|')} |`);
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
      const detail = [n.category, n.reason, n.missingPrecondition ? `missing: ${n.missingPrecondition}` : '', n.recommendedSetup ? `setup: ${n.recommendedSetup}` : '']
        .filter(Boolean)
        .join('; ')
        .replace(/\|/g, '\\|');
      L.push(`| ${n.workflow} | ${OUTCOME_MARK[n.outcome] ?? ''} ${n.outcome} | ${detail || '—'} |`);
    }

    L.push('', '## Evidence quality', '');
    L.push(`- Deterministic structured locator: ${evidenceTaxonomy.counts.structured_locator}.`);
    L.push(`- Probabilistic visual/OCR/AI evidence: ${evidenceTaxonomy.byAuthority.probabilistic}.`);
    L.push(`- Manual review evidence: ${evidenceTaxonomy.counts.manual_review}.`);
    L.push(`- Calibration: ${evidenceTaxonomy.calibration.status}${evidenceTaxonomy.calibration.requiredCorpus ? ` (${evidenceTaxonomy.calibration.requiredCorpus})` : ''}. ${evidenceTaxonomy.calibration.note}`);
    L.push('', '| Workflow | Evidence | Authority | Notes |');
    L.push('| --- | --- | --- | --- |');
    for (const ev of evidenceTaxonomy.assessments) {
      L.push(`| ${tableCell(ev.workflow)} | ${ev.kind} | ${ev.authority} | ${ev.warning ? tableCell(ev.warning) : '—'} |`);
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
      L.push(`| ${tableCell(g.fixture)} | ${tableCell(g.field)} | ${tableCell(g.generator)} | \`${tableCell(g.varName)}\` | ${g.secret ? '<redacted>' : tableCell(g.value)} | ${g.artifactUri ? `[artifact](${g.artifactUri})` : '—'} |`);
    }
  }

  if (r.findings.length) {
    L.push('', '## Findings', '');
    for (const f of r.findings) {
      const code = f.failureCode ? ` \`${f.failureCode}\`` : '';
      const bucket = f.bucket ? ` ${f.bucket}` : '';
      const retry = f.retrySafe == null ? '' : ` retrySafe=${f.retrySafe}`;
      const next = f.nextStep ? ` Next: ${f.nextStep}` : '';
      L.push(`- **[${f.severity}]**${code}${bucket}${retry} ${f.layer ?? '?'}/${f.kind}: ${f.detail}${f.evidence ? ` — _"${f.evidence}"_` : ''}${f.screenshotUri ? ` ([screenshot](${f.screenshotUri}))` : ''}${next}`);
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
      const targetDetail = [compactValue(m.target), m.detail ? compactValue(m.detail) : '']
        .filter((part) => part && part !== '—')
        .join('; ') || '—';
      L.push(`| ${tableCell(mutationTime(m.at))} | ${tableCell(m.tool)} | ${tableCell(m.action)} | ${tableCell(m.risk)} | ${tableCell(m.status)} | ${tableCell(mutationConsentSummary(m))} | ${tableCell(mutationEvidenceSummary(m))} | ${tableCell(targetDetail)} |`);
    }
  }

  L.push('', '## Timing & artifacts', '');
  L.push(`- Total ${r.phaseTimings.totalSec}s · setup ${r.phaseTimings.setupSec}s · active ${r.phaseTimings.activeSec}s${r.phaseTimings.timeToLoginSec != null ? ` · to-login ${r.phaseTimings.timeToLoginSec}s` : ''}`);
  const d = r.phaseTimings.diagnostics;
  if (d) {
    const parts = [
      d.simulatorBootSec != null ? `boot ${d.simulatorBootSec}s` : '',
      d.appInstallSec != null ? `install ${d.appInstallSec}s` : '',
      d.appLaunchSec != null ? `launch ${d.appLaunchSec}s` : '',
      d.wdaBuildSec != null ? `WDA build ${d.wdaBuildSec}s` : '',
      d.wdaStartSec != null ? `WDA start ${d.wdaStartSec}s` : '',
      d.wdaReuseCheckSec != null ? `WDA reuse check ${d.wdaReuseCheckSec}s` : '',
      d.wdaStartupWaitSec != null ? `WDA ready wait ${d.wdaStartupWaitSec}s` : '',
      d.wdaSessionCreateSec != null ? `WDA session ${d.wdaSessionCreateSec}s` : '',
      d.wdaSourceSec != null ? `WDA source ${d.wdaSourceSec}s` : '',
      d.wdaFindElementSec != null ? `WDA find ${d.wdaFindElementSec}s` : '',
      d.wdaTapSec != null ? `WDA tap ${d.wdaTapSec}s` : '',
      d.wdaTypeSec != null ? `WDA type ${d.wdaTypeSec}s` : '',
      d.wdaClearSec != null ? `WDA clear ${d.wdaClearSec}s` : '',
      d.wdaScreenshotSec != null ? `WDA screenshot ${d.wdaScreenshotSec}s` : '',
      d.flowRuntimeSec != null ? `flows ${d.flowRuntimeSec}s` : '',
      d.waitSec != null ? `wait ${d.waitSec}s` : '',
      d.screenshotCount != null ? `screenshots ${d.screenshotCount}` : '',
    ].filter(Boolean);
    if (parts.length) L.push(`- Diagnostics: ${parts.join(' · ')}`);
  }
  L.push(`- ${r.artifacts.length} artifact(s):`);
  for (const a of r.artifacts) L.push(`  - \`${a.uri}\` (${a.kind}${a.label ? `: ${a.label}` : ''})`);

  L.push('', '---', '_Generated by Swipium._');
  return L.join('\n');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toJUnit(r: ReportData): string {
  // One <testcase> per recorded outcome. fail → <failure>; blocked/skipped/not_applicable → <skipped>.
  const cases = r.testOutcomes;
  const failures = cases.filter((n) => n.outcome === 'fail').length;
  const skipped = cases.filter((n) => n.outcome === 'blocked' || n.outcome === 'skipped' || n.outcome === 'not_applicable').length;
  const suiteName = `swipium.${r.appId ?? 'app'}`;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<testsuite name="${xmlEscape(suiteName)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${r.phaseTimings.totalSec ?? 0}">`);
  for (const n of cases) {
    const name = xmlEscape(n.workflow);
    const msg = xmlEscape([n.category, n.reason, n.missingPrecondition].filter(Boolean).join(': ') || n.outcome);
    if (n.outcome === 'fail') {
      lines.push(`  <testcase name="${name}" classname="${xmlEscape(suiteName)}">`);
      lines.push(`    <failure message="${msg}"></failure>`);
      lines.push(`  </testcase>`);
    } else if (n.outcome === 'blocked' || n.outcome === 'skipped' || n.outcome === 'not_applicable') {
      lines.push(`  <testcase name="${name}" classname="${xmlEscape(suiteName)}">`);
      lines.push(`    <skipped message="${msg}"></skipped>`);
      lines.push(`  </testcase>`);
    } else {
      lines.push(`  <testcase name="${name}" classname="${xmlEscape(suiteName)}"></testcase>`);
    }
  }
  lines.push('</testsuite>');
  return lines.join('\n');
}
