import type { Session } from '../session/store.js';

// Structured output fields are milliseconds with *Ms names (1.5.0 unit normalization —
// inputs were already *Ms everywhere). Human-readable text may still render seconds.
export interface PhaseTimings {
  totalMs: number | null;
  setupMs: number | null;
  activeMs: number | null;
  timeToLoginMs: number | null;
  diagnostics: {
    simulatorBootMs: number | null;
    appInstallMs: number | null;
    appLaunchMs: number | null;
    wdaBuildMs: number | null;
    wdaStartMs: number | null;
    wdaReuseCheckMs: number | null;
    wdaStartupWaitMs: number | null;
    wdaSessionCreateMs: number | null;
    wdaSourceMs: number | null;
    wdaFindElementMs: number | null;
    wdaTapMs: number | null;
    wdaTypeMs: number | null;
    wdaClearMs: number | null;
    wdaScreenshotMs: number | null;
    flowRuntimeMs: number | null;
    waitMs: number | null;
    screenshotCount: number | null;
  };
}

export function phaseTimingsForSession(
  session: Pick<Session, 'createdAt' | 'milestones'> & Partial<Pick<Session, 'counters'>>,
  now = Date.now(),
): PhaseTimings {
  const start = session.milestones.session_start ?? session.createdAt;
  const firstAction = session.milestones.first_action;
  const ms = (n: number): number => Math.max(0, Math.round(n));
  const pair = (from: string, to: string): number | null => {
    const a = session.milestones[from];
    const b = session.milestones[to];
    return a != null && b != null ? ms(b - a) : null;
  };
  const aggregate = (key: string): number | null => (session.milestones[key] != null ? ms(session.milestones[key]) : null);

  return {
    totalMs: ms(now - start),
    setupMs: ms((firstAction ?? now) - start),
    activeMs: firstAction ? ms(now - firstAction) : 0,
    timeToLoginMs: session.milestones.login_performed ? ms(session.milestones.login_performed - start) : null,
    diagnostics: {
      simulatorBootMs: pair('simulator_boot_start', 'simulator_boot_end'),
      appInstallMs: pair('app_install_start', 'app_install_end'),
      appLaunchMs: pair('app_launch_start', 'app_launch_end'),
      wdaBuildMs: pair('wda_build_start', 'wda_build_end'),
      wdaStartMs: pair('wda_start_start', 'wda_start_end'),
      wdaReuseCheckMs: aggregate('wda_reuse_check_ms'),
      wdaStartupWaitMs: aggregate('wda_startup_wait_ms'),
      wdaSessionCreateMs: aggregate('wda_session_create_ms'),
      wdaSourceMs: aggregate('wda_source_ms'),
      wdaFindElementMs: aggregate('wda_find_element_ms'),
      wdaTapMs: aggregate('wda_tap_ms'),
      wdaTypeMs: aggregate('wda_type_ms'),
      wdaClearMs: aggregate('wda_clear_ms'),
      wdaScreenshotMs: aggregate('wda_screenshot_ms'),
      flowRuntimeMs: aggregate('flow_runtime_ms'),
      waitMs: aggregate('wait_ms'),
      screenshotCount: session.counters?.screenshots ?? null,
    },
  };
}
