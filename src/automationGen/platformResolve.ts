// Platform of the device a session actually ran on — the second link in the generated-suite platform
// resolution chain: explicit `platform` arg → session device platform → project profile → android.
// Pure (reads only the session's driver kind / device id), so it also works on a rehydrated session.

import type { Session } from '../session/store.js';

/** iOS simulator UDID (UUID). */
const IOS_SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
/** Physical iOS device UDID: modern `00008030-001A2B3C4D5E6F7A` or legacy 40-hex. */
const IOS_DEVICE_UDID_RE = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/i;

export type DevicePlatform = 'android' | 'ios';

/** The live driver kind is authoritative (simulator/WDA ⇒ iOS, direct adb ⇒ Android); without a
 *  driver fall back to the device id shape — iOS UDIDs vs adb serials (emulator-5554, R58M…, ip:port). */
export function sessionDevicePlatform(s: Pick<Session, 'device' | 'driver'> | undefined): DevicePlatform | undefined {
  if (!s) return undefined;
  const kind = s.driver?.kind;
  if (kind === 'simulator' || kind === 'wda') return 'ios';
  if (kind === 'direct') return 'android';
  const d = s.device?.trim();
  if (!d) return undefined;
  return IOS_SIMULATOR_UDID_RE.test(d) || IOS_DEVICE_UDID_RE.test(d) ? 'ios' : 'android';
}

/** Default SWIPIUM_PLATFORM baked into generated capabilities/conftest: the profile's resolved
 *  primary platform (or its default backend); a bare model (tests/previews) falls back to android
 *  unless the model is iOS-only. */
export function defaultPlatformOf(
  profile: { primaryPlatform?: DevicePlatform; defaultBackend?: string } | undefined,
  model: { platforms: { android: boolean; ios: boolean } },
): DevicePlatform {
  if (profile?.primaryPlatform) return profile.primaryPlatform;
  if (profile?.defaultBackend === 'appium-xcuitest') return 'ios';
  if (profile?.defaultBackend === 'appium-uiautomator2') return 'android';
  return model.platforms.ios && !model.platforms.android ? 'ios' : 'android';
}
