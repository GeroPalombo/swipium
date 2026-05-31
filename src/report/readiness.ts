import type { FindingRecord, RecordedAction, Session, TestNote } from '../session/store.js';
import { evidenceAssessmentForNote, type EvidenceKind } from './evidence.js';

export type ReadinessLabel = 'observed' | 'verified' | 'generated' | 'compiled' | 'replayed' | 'ci_ready';
export type AutomationReadinessGrade = 'A' | 'B' | 'C' | 'D';

const READINESS_ORDER: ReadinessLabel[] = ['observed', 'verified', 'generated', 'compiled', 'replayed', 'ci_ready'];

export function orderReadinessLabels(labels: ReadinessLabel[]): ReadinessLabel[] {
  const set = new Set(labels);
  return READINESS_ORDER.filter((label) => set.has(label));
}

export interface AutomationReadinessStandard {
  grade: AutomationReadinessGrade;
  score: number;
  labels: ReadinessLabel[];
  scoreBreakdown: {
    durableLocators: number;
    workflowEvidence: number;
    stateProfiles: number;
    idling: number;
    safeDestructiveBoundaries: number;
    replayEvidence: number;
  };
  locatorCoverage: {
    totalActions: number;
    durableActions: number;
    nativeFallbackActions: number;
    textActions: number;
    coordinateActions: number;
    durablePct: number;
    nativeOrDurablePct: number;
    byKind: Record<string, number>;
  };
  locatorCoverageTrend: Array<{ label: string; durablePct: number; totalActions: number }>;
  workflowGrades: Array<{
    workflow: string;
    grade: AutomationReadinessGrade;
    outcome: TestNote['outcome'] | 'unknown';
    evidence: EvidenceKind | 'none';
    fix?: string;
  }>;
  screenGrades: Array<{
    screen: string;
    grade: AutomationReadinessGrade;
    score: number;
    actionCount: number;
    durableLocatorPct: number;
    weakActions: number;
    fixes: string[];
  }>;
  topFixes: string[];
  prComments: Array<{ severity: 'blocker' | 'warning' | 'info'; body: string }>;
}

export function readinessForSession(session: Session, opts: { suiteRunnable?: boolean; suiteReplayed?: boolean; ciReady?: boolean } = {}): ReadinessLabel[] {
  const labels: ReadinessLabel[] = [];
  const artifacts = session.artifacts ?? [];
  const notes = session.notes ?? [];
  const findings = session.findings ?? [];
  const recordedActions = session.recordedActions ?? [];
  if (artifacts.length || session.exploration || notes.length || findings.length || recordedActions.length) labels.push('observed');
  if (notes.some((n) => n.outcome === 'pass') || findings.length || recordedActions.length) labels.push('verified');
  if (recordedActions.length) labels.push('generated');
  if (opts.suiteRunnable) labels.push('compiled');
  if (opts.suiteReplayed) labels.push('replayed');
  if (opts.ciReady) labels.push('ci_ready');
  return orderReadinessLabels(labels);
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

function gradeFromScore(score: number): AutomationReadinessGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function gradeFromOutcome(outcome: TestNote['outcome'] | 'unknown', weakerEvidence: boolean, durablePct: number): AutomationReadinessGrade {
  if (outcome === 'fail') return 'D';
  if (outcome === 'blocked') return 'C';
  if (outcome === 'skipped' || outcome === 'not_applicable') return 'C';
  if (outcome === 'pass') {
    if (durablePct >= 80 && !weakerEvidence) return 'A';
    if (durablePct >= 60 || weakerEvidence) return 'B';
    return 'C';
  }
  return durablePct >= 70 ? 'B' : durablePct >= 40 ? 'C' : 'D';
}

function locatable(actions: RecordedAction[]): RecordedAction[] {
  return actions.filter((a) => ['tap', 'type', 'clear', 'scroll', 'swipe', 'press', 'assert_visual'].includes(a.action));
}

function locatorCoverage(actions: RecordedAction[]): AutomationReadinessStandard['locatorCoverage'] {
  const items = locatable(actions);
  const byKind: Record<string, number> = {};
  for (const a of items) byKind[a.selectorKind ?? 'none'] = (byKind[a.selectorKind ?? 'none'] ?? 0) + 1;
  const durableActions = items.filter((a) => a.selectorKind === 'accessibility_id' || a.selectorKind === 'resource_id').length;
  const nativeFallbackActions = items.filter((a) => a.selectorKind === 'name' || a.selectorKind === 'predicate' || a.selectorKind === 'class_chain').length;
  const textActions = items.filter((a) => a.selectorKind === 'text').length;
  const coordinateActions = items.filter((a) => !a.selectorKind || a.selectorKind === 'coords').length;
  return {
    totalActions: items.length,
    durableActions,
    nativeFallbackActions,
    textActions,
    coordinateActions,
    durablePct: pct(durableActions, items.length),
    nativeOrDurablePct: pct(durableActions + nativeFallbackActions, items.length),
    byKind,
  };
}

function uniqueTop(items: string[], limit = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items.map((x) => x.trim()).filter(Boolean)) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function noteFix(n: TestNote): string | undefined {
  if (n.outcome === 'pass') return undefined;
  if (n.recommendedSetup) return `${n.workflow}: ${n.recommendedSetup}`;
  if (n.missingPrecondition) return `${n.workflow}: add fixture/state profile for missing precondition "${n.missingPrecondition}"`;
  if (n.reason) return `${n.workflow}: resolve ${n.reason}`;
  return `${n.workflow}: investigate ${n.outcome} outcome`;
}

function findingFix(f: FindingRecord): string {
  return `${f.kind}: ${f.detail}`;
}

function actionFix(a: RecordedAction): string | undefined {
  const where = a.screen ? ` on ${a.screen}` : '';
  if (!a.selectorKind || a.selectorKind === 'coords') return `Add a testID/accessibilityIdentifier for coordinate-only ${a.action}${where}.`;
  if (a.selectorKind === 'text') return `Promote text selector "${a.selector ?? 'unknown'}"${where} to a durable testID/accessibilityIdentifier.`;
  if (a.selectorKind === 'name') return `Promote iOS name selector "${a.selector ?? 'unknown'}"${where} to accessibilityIdentifier.`;
  return undefined;
}

function screenGrades(actions: RecordedAction[]): AutomationReadinessStandard['screenGrades'] {
  const groups = new Map<string, RecordedAction[]>();
  for (const action of locatable(actions)) {
    const screen = action.screen ?? 'unknown_screen';
    groups.set(screen, [...(groups.get(screen) ?? []), action]);
  }
  return [...groups.entries()].map(([screen, group]) => {
    const c = locatorCoverage(group);
    const score = Math.round(c.durablePct * 0.8 + c.nativeOrDurablePct * 0.2);
    return {
      screen,
      grade: gradeFromScore(score),
      score,
      actionCount: group.length,
      durableLocatorPct: c.durablePct,
      weakActions: c.textActions + c.coordinateActions,
      fixes: uniqueTop(group.map(actionFix).filter((x): x is string => !!x), 5),
    };
  }).sort((a, b) => a.grade.localeCompare(b.grade) || b.actionCount - a.actionCount);
}

function workflowGrades(notes: TestNote[], durablePct: number): AutomationReadinessStandard['workflowGrades'] {
  if (!notes.length) {
    return [{
      workflow: 'recorded_session',
      grade: gradeFromOutcome('unknown', false, durablePct),
      outcome: 'unknown',
      evidence: 'none',
      fix: durablePct < 80 ? 'Record qa_note outcomes and promote weak locators before CI promotion.' : 'Record qa_note outcomes so product readiness is auditable.',
    }];
  }
  return notes.map((n) => {
    const evidence = evidenceAssessmentForNote(n);
    return {
      workflow: n.workflow,
      grade: gradeFromOutcome(n.outcome, evidence.authority !== 'deterministic', durablePct),
      outcome: n.outcome,
      evidence: evidence.kind,
      fix: noteFix(n),
    };
  });
}

function workflowEvidenceWeight(n: TestNote): number {
  const evidence = evidenceAssessmentForNote(n);
  if (evidence.authority === 'deterministic') return 1;
  if (evidence.authority === 'probabilistic') return 0.65;
  return 0.4;
}

function scoreBreakdown(session: Session, labels: ReadinessLabel[], coverage: AutomationReadinessStandard['locatorCoverage']): AutomationReadinessStandard['scoreBreakdown'] {
  const weightedPassCount = session.notes.filter((n) => n.outcome === 'pass').reduce((sum, n) => sum + workflowEvidenceWeight(n), 0);
  const failOrBlocked = session.notes.filter((n) => n.outcome === 'fail' || n.outcome === 'blocked').length;
  const workflowEvidence = session.notes.length ? Math.max(0, Math.round((weightedPassCount / session.notes.length) * 15) - failOrBlocked * 2) : 0;
  const stateProfiles = session.mutations.some((m) => m.action === 'state_profile_mutation' && m.status === 'executed') ? 10 : session.fixtures.length ? 5 : 0;
  const idling = session.workarounds.some((w) => /idling: app-declared/i.test(w)) ? 10 : session.workarounds.some((w) => /idling:/i.test(w)) ? 5 : 0;
  const riskyExecuted = session.mutations.filter((m) => m.risk === 'high' && m.status === 'executed').length;
  const refusedOrBounded = session.mutations.some((m) => (m.status === 'refused' || m.status === 'blocked') && m.risk === 'high');
  const safeDestructiveBoundaries = riskyExecuted ? 4 : refusedOrBounded ? 10 : 8;
  const replayEvidence = labels.includes('ci_ready') ? 20 : labels.includes('replayed') ? 16 : labels.includes('compiled') ? 10 : labels.includes('generated') ? 5 : 0;
  return {
    durableLocators: coverage.totalActions ? Math.round(((coverage.durableActions + coverage.nativeFallbackActions * 0.6) / coverage.totalActions) * 35) : 0,
    workflowEvidence,
    stateProfiles,
    idling,
    safeDestructiveBoundaries,
    replayEvidence,
  };
}

export function automationReadinessForSession(session: Session, opts: { suiteRunnable?: boolean; suiteReplayed?: boolean; ciReady?: boolean } = {}): AutomationReadinessStandard {
  const labels = readinessForSession(session, opts);
  const coverage = locatorCoverage(session.recordedActions);
  const breakdown = scoreBreakdown(session, labels, coverage);
  const score = Math.max(0, Math.min(100, Object.values(breakdown).reduce((a, b) => a + b, 0)));
  const fixes = uniqueTop([
    ...session.notes.map(noteFix).filter((x): x is string => !!x),
    ...session.findings.map(findingFix),
    ...session.recordedActions.map(actionFix).filter((x): x is string => !!x),
    coverage.totalActions && coverage.durablePct < 80 ? `Raise durable locator coverage from ${coverage.durablePct}% to at least 80% before release gating.` : '',
    session.notes.length ? '' : 'Record workflow outcomes with qa_note so readiness can be reviewed by workflow.',
    session.mutations.some((m) => m.action === 'state_profile_mutation' && m.status === 'executed') ? '' : 'Add a declared state profile for repeatable setup and teardown.',
    session.workarounds.some((w) => /idling:/i.test(w)) ? '' : 'Add an app-declared idling hook for stable waits.',
  ], 10);
  return {
    grade: gradeFromScore(score),
    score,
    labels,
    scoreBreakdown: breakdown,
    locatorCoverage: coverage,
    locatorCoverageTrend: [{ label: 'current_session', durablePct: coverage.durablePct, totalActions: coverage.totalActions }],
    workflowGrades: workflowGrades(session.notes, coverage.durablePct),
    screenGrades: screenGrades(session.recordedActions),
    topFixes: fixes,
    prComments: fixes.slice(0, 5).map((fix, i) => ({
      severity: i === 0 && score < 70 ? 'blocker' : score < 85 ? 'warning' : 'info',
      body: `Swipium automation readiness: ${fix}`,
    })),
  };
}
