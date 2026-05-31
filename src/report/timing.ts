import type { Session } from '../session/store.js';

export interface PhaseTimings {
  totalSec: number | null;
  setupSec: number | null;
  activeSec: number | null;
  timeToLoginSec: number | null;
  diagnostics: {
    simulatorBootSec: number | null;
    appInstallSec: number | null;
    appLaunchSec: number | null;
    wdaBuildSec: number | null;
    wdaStartSec: number | null;
    wdaReuseCheckSec: number | null;
    wdaStartupWaitSec: number | null;
    wdaSessionCreateSec: number | null;
    wdaSourceSec: number | null;
    wdaFindElementSec: number | null;
    wdaTapSec: number | null;
    wdaTypeSec: number | null;
    wdaClearSec: number | null;
    wdaScreenshotSec: number | null;
    flowRuntimeSec: number | null;
    waitSec: number | null;
    screenshotCount: number | null;
  };
}

export function phaseTimingsForSession(session: Pick<Session, 'createdAt' | 'milestones'> & Partial<Pick<Session, 'counters'>>, now = Date.now()): PhaseTimings {
  const start = session.milestones.session_start ?? session.createdAt;
  const firstAction = session.milestones.first_action;
  const sec = (ms: number): number => Math.max(0, Math.round(ms / 1000));
  const pair = (from: string, to: string): number | null => {
    const a = session.milestones[from];
    const b = session.milestones[to];
    return a != null && b != null ? sec(b - a) : null;
  };
  const aggregate = (key: string): number | null => session.milestones[key] != null ? sec(session.milestones[key]) : null;

  return {
    totalSec: sec(now - start),
    setupSec: sec((firstAction ?? now) - start),
    activeSec: firstAction ? sec(now - firstAction) : 0,
    timeToLoginSec: session.milestones.login_performed ? sec(session.milestones.login_performed - start) : null,
    diagnostics: {
      simulatorBootSec: pair('simulator_boot_start', 'simulator_boot_end'),
      appInstallSec: pair('app_install_start', 'app_install_end'),
      appLaunchSec: pair('app_launch_start', 'app_launch_end'),
      wdaBuildSec: pair('wda_build_start', 'wda_build_end'),
      wdaStartSec: pair('wda_start_start', 'wda_start_end'),
      wdaReuseCheckSec: aggregate('wda_reuse_check_ms'),
      wdaStartupWaitSec: aggregate('wda_startup_wait_ms'),
      wdaSessionCreateSec: aggregate('wda_session_create_ms'),
      wdaSourceSec: aggregate('wda_source_ms'),
      wdaFindElementSec: aggregate('wda_find_element_ms'),
      wdaTapSec: aggregate('wda_tap_ms'),
      wdaTypeSec: aggregate('wda_type_ms'),
      wdaClearSec: aggregate('wda_clear_ms'),
      wdaScreenshotSec: aggregate('wda_screenshot_ms'),
      flowRuntimeSec: aggregate('flow_runtime_ms'),
      waitSec: aggregate('wait_ms'),
      screenshotCount: session.counters?.screenshots ?? null,
    },
  };
}
