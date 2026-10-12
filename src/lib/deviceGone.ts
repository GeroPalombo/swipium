// Device-gone classification: the bound emulator/simulator disappeared (killed, shut down,
// adb lost it). Every tool that touches the device should report this as NO_DEVICE with
// "re-boot / re-bind" guidance instead of SNAPSHOT_FAILED / UNKNOWN / a "healthy" verdict, and
// must not count it toward the visual-fallback snapshot-failure budget.

const DEVICE_GONE_RE =
  /device '[^']*' not found|device not found|no devices\/emulators found|device '[^']*' offline|error: device offline|device still connecting|Invalid device: [0-9A-F-]{8,}|Unable to lookup in current state: Shutdown|current state: Shutdown/i;

/** Does this error (or message) say the bound device is no longer reachable? */
export function isDeviceGoneError(error: unknown): boolean {
  if (error == null) return false;
  const msg = typeof error === 'string' ? error : String((error as Error)?.message ?? error);
  return DEVICE_GONE_RE.test(msg);
}

/** Recovery steps for a device that disappeared mid-session. */
export function deviceGoneNextSteps(device?: string): string[] {
  const which = device ? ` (${device})` : '';
  return [
    `The session's device${which} is no longer online (killed, shut down, or adb lost it). Nothing on it can be observed or changed.`,
    "Re-boot the session's own emulator/simulator (qa_prepare_target / qa_prepare_ios_target with the same AVD or simulator), then re-launch the app.",
    'Do not retry this call until the device is back: retrying cannot succeed.',
  ];
}
