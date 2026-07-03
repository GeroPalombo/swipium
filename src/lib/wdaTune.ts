import type { Session } from '../session/store.js';
import type { SessionStore } from '../session/store.js';
import type { WdaTimingKind } from '../drivers/WdaDriver.js';
import type { WdaConfig } from './wdaConfig.js';

export interface WdaRecommendation {
  setting: string;
  value: unknown;
  reason: string;
  failureCode?: string;
}

function msOrNull(ms?: number): number | null {
  return ms == null ? null : Math.round(ms);
}

const WDA_TIMING_KEYS: Record<WdaTimingKind, string> = {
  session_create: 'wda_session_create_ms',
  source: 'wda_source_ms',
  find_element: 'wda_find_element_ms',
  tap: 'wda_tap_ms',
  type: 'wda_type_ms',
  clear: 'wda_clear_ms',
  screenshot: 'wda_screenshot_ms',
};

export function recordWdaTiming(
  session: Session,
  kind: WdaTimingKind,
  ms: number,
  sessions?: Pick<SessionStore, 'addMilestoneDuration'>,
): void {
  const key = WDA_TIMING_KEYS[kind];
  if (sessions) {
    sessions.addMilestoneDuration(session, key, ms);
    return;
  }
  if (!Number.isFinite(ms) || ms < 0) return;
  session.milestones[key] = (session.milestones[key] ?? 0) + ms;
}

// Structured output uses *Ms fields in milliseconds (1.5.0 unit normalization).
export function wdaTimingSummary(session: Session): Record<string, number | null> {
  return {
    sessionCreateMs: msOrNull(session.milestones.wda_session_create_ms),
    buildMs: msOrNull(
      session.milestones.wda_build_end && session.milestones.wda_build_start
        ? session.milestones.wda_build_end - session.milestones.wda_build_start
        : undefined,
    ),
    startMs: msOrNull(
      session.milestones.wda_start_end && session.milestones.wda_start_start
        ? session.milestones.wda_start_end - session.milestones.wda_start_start
        : undefined,
    ),
    startupWaitMs: msOrNull(session.milestones.wda_startup_wait_ms),
    reuseCheckMs: msOrNull(session.milestones.wda_reuse_check_ms),
    sourceMs: msOrNull(session.milestones.wda_source_ms),
    findElementMs: msOrNull(session.milestones.wda_find_element_ms),
    tapMs: msOrNull(session.milestones.wda_tap_ms),
    typeMs: msOrNull(session.milestones.wda_type_ms),
    clearMs: msOrNull(session.milestones.wda_clear_ms),
    screenshotMs: msOrNull(session.milestones.wda_screenshot_ms),
    flowRuntimeMs: msOrNull(session.milestones.flow_runtime_ms),
    waitMs: msOrNull(session.milestones.wait_ms),
  };
}

export function wdaRecommendations(config: WdaConfig, session?: Session): WdaRecommendation[] {
  const timings = session ? wdaTimingSummary(session) : {};
  const out: WdaRecommendation[] = [];
  const hasPageSourceExcludedAttributes = 'pageSourceExcludedAttributes' in config.settings;
  if (timings.startupWaitMs != null && timings.startupWaitMs > 30_000)
    out.push({
      setting: 'reduceMotion',
      value: true,
      reason: 'WDA startup/idle wait is slow; reduce motion can lower XCTest idle delays.',
      failureCode: 'WDA_APP_NOT_IDLE',
    });
  if ((timings.waitMs != null && timings.waitMs > 20_000) || (timings.sourceMs != null && timings.sourceMs > 10_000))
    out.push({
      setting: 'snapshotMaxDepth',
      value: config.settings.snapshotMaxDepth ?? 30,
      reason: 'Large/slow snapshots detected; cap snapshot depth for deeply nested accessibility trees.',
      failureCode: 'WDA_HIERARCHY_TOO_LARGE',
    });
  if (timings.findElementMs != null && timings.findElementMs > 10_000)
    out.push({
      setting: 'pageSourceExcludedAttributes',
      value: config.settings.pageSourceExcludedAttributes ?? 'visible,accessible',
      reason: 'Slow WDA element lookup detected; prefer accessibility id/predicate/class chain and keep page-source attributes lean.',
      failureCode: 'WDA_SOURCE_SLOW',
    });
  else if (!hasPageSourceExcludedAttributes)
    out.push({
      setting: 'pageSourceExcludedAttributes',
      value: 'visible,accessible',
      reason: 'Avoid expensive page-source attributes unless a flow explicitly needs them.',
      failureCode: 'WDA_SOURCE_SLOW',
    });
  if (!('maxTypingFrequency' in config.settings))
    out.push({
      setting: 'maxTypingFrequency',
      value: 30,
      reason: 'Expose a conservative typing frequency for apps with flaky text entry.',
    });
  if (!('respectSystemAlerts' in config.settings))
    out.push({ setting: 'respectSystemAlerts', value: true, reason: 'System alerts can block interaction; make alert handling explicit.' });
  return out;
}
