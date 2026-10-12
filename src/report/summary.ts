// Release assessment (Report 2.0): turn the accumulated health + outcomes
// into a single verdict a non-QA developer can act on: ship | caution | block, with reasons
// and the one most important next action. Pure + deterministic so it's unit-testable.

export type ReleaseRisk = 'ship' | 'caution' | 'block';

export interface RiskInput {
  /** 'not checked': the app was never reached, so health was never probed (not a pass). */
  nativeHealth: 'OK' | 'error' | 'not checked';
  /** 'unverified': visual-only run, no UI tree was read, so an error screen could have been missed. */
  appHealth: 'OK' | 'degraded' | 'error' | 'unverified' | 'not checked';
  highSeverityCount: number;
  failCount: number;
  blockedCount: number;
  overrideCount: number;
  topHighFinding?: string; // detail of the first high-severity finding
  topFail?: { workflow: string; reason?: string };
  topBlocked?: { workflow: string; recommendedSetup?: string };
  /**
   * The run did not test what it set out to. `reachedApp:false` (stopped before the app was
   * launched/exercised, or nothing at all was captured) is a BLOCK; `reachedApp:true` (the app was
   * reached but no workflow/case was executed) is a CAUTION. Either way, never SHIP without evidence.
   */
  notTested?: { reachedApp: boolean; reason: string };
  /** Coverage the run planned but did not get (blocked exploration, flows skipped by the session
   *  budget): a CAUTION, never SHIP. `next` is the action that closes the gap. */
  coverageGaps?: Array<{ reason: string; next: string }>;
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

  if (!blocking && i.notTested && !i.notTested.reachedApp) {
    return {
      risk: 'block',
      reasons: [`not tested: ${i.notTested.reason}`],
      nextAction: `Not tested: ${i.notTested.reason}. This run is not a pass; fix the blocker and re-run.`,
    };
  }

  if (blocking) {
    const next = i.topFail
      ? `Fix "${i.topFail.workflow}"${i.topFail.reason ? `: ${i.topFail.reason}` : ''} before shipping.`
      : i.topHighFinding
        ? `Investigate: ${i.topHighFinding}`
        : 'Resolve the blocking health issue before shipping.';
    return { risk: 'block', reasons, nextAction: next };
  }

  const cautions: string[] = [];
  if (i.notTested) cautions.push(`not tested: ${i.notTested.reason}`);
  if (i.appHealth === 'degraded') cautions.push('app health degraded (non-fatal warnings/LogBox)');
  if (i.appHealth === 'unverified')
    cautions.push('app health unverified (visual-only: no UI tree was read, so an error screen could be missed; check the screenshot)');
  if (i.blockedCount > 0) cautions.push(`${i.blockedCount} workflow(s) blocked by missing preconditions`);
  if (i.overrideCount > 0) cautions.push(`${i.overrideCount} guardrail override(s) used`);
  for (const g of i.coverageGaps ?? []) cautions.push(g.reason);
  if (cautions.length) {
    const next = i.notTested
      ? `Not tested: ${i.notTested.reason}. Exercise it (or provide the missing setup), then re-run.`
      : i.topBlocked
        ? `Provide setup for "${i.topBlocked.workflow}"${i.topBlocked.recommendedSetup ? `: ${i.topBlocked.recommendedSetup}` : ''}, then re-run.`
        : (i.coverageGaps?.[0]?.next ?? 'Review the cautions below before shipping.');
    return { risk: 'caution', reasons: cautions, nextAction: next };
  }

  return {
    risk: 'ship',
    reasons: ['no blocking findings; native + app healthy'],
    nextAction: 'No blocking issues found in simulator/emulator evidence.',
  };
}
