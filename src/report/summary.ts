// Release assessment (PHASE3-PLAN §3.5 Report 2.0) — turn the accumulated health + outcomes
// into a single verdict a non-QA developer can act on: ship | caution | block, with reasons
// and the one most important next action. Pure + deterministic so it's unit-testable.

export type ReleaseRisk = 'ship' | 'caution' | 'block';

export interface RiskInput {
  nativeHealth: 'OK' | 'error';
  appHealth: 'OK' | 'degraded' | 'error';
  highSeverityCount: number;
  failCount: number;
  blockedCount: number;
  overrideCount: number;
  topHighFinding?: string; // detail of the first high-severity finding
  topFail?: { workflow: string; reason?: string };
  topBlocked?: { workflow: string; recommendedSetup?: string };
}

export interface ReleaseAssessment {
  risk: ReleaseRisk;
  reasons: string[];
  nextAction: string;
}

export function releaseAssessment(i: RiskInput): ReleaseAssessment {
  const reasons: string[] = [];

  const blocking = i.nativeHealth === 'error' || i.appHealth === 'error' || i.highSeverityCount > 0 || i.failCount > 0;
  if (i.nativeHealth === 'error') reasons.push('native crash/ANR detected');
  if (i.appHealth === 'error') reasons.push('app-level error surface (ErrorBoundary/RedBox)');
  if (i.highSeverityCount > 0) reasons.push(`${i.highSeverityCount} high-severity finding(s)`);
  if (i.failCount > 0) reasons.push(`${i.failCount} workflow(s) failed`);

  if (blocking) {
    const next = i.topFail
      ? `Fix "${i.topFail.workflow}"${i.topFail.reason ? ` — ${i.topFail.reason}` : ''} before shipping.`
      : i.topHighFinding
        ? `Investigate: ${i.topHighFinding}`
        : 'Resolve the blocking health issue before shipping.';
    return { risk: 'block', reasons, nextAction: next };
  }

  const cautions: string[] = [];
  if (i.appHealth === 'degraded') cautions.push('app health degraded (non-fatal warnings/LogBox)');
  if (i.blockedCount > 0) cautions.push(`${i.blockedCount} workflow(s) blocked by missing preconditions`);
  if (i.overrideCount > 0) cautions.push(`${i.overrideCount} guardrail override(s) used`);
  if (cautions.length) {
    const next = i.topBlocked
      ? `Provide setup for "${i.topBlocked.workflow}"${i.topBlocked.recommendedSetup ? `: ${i.topBlocked.recommendedSetup}` : ''}, then re-run.`
      : 'Review the cautions below before shipping.';
    return { risk: 'caution', reasons: cautions, nextAction: next };
  }

  return {
    risk: 'ship',
    reasons: ['no blocking findings; native + app healthy'],
    nextAction: 'No blocking issues found in simulator/emulator evidence.',
  };
}
