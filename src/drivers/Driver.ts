// Shared automation contract. Android adb, iOS simctl, and WDA-backed drivers plug in behind
// this interface so tool code can stay backend-neutral.

export interface SnapshotElement {
  ref: string; // @e1, @e2 …
  role: string; // class / inferred role
  label?: string; // content-desc
  id?: string; // resource-id
  text?: string;
  bounds: [number, number, number, number]; // x1,y1,x2,y2
  clickable: boolean;
  focused?: boolean;
  secure?: boolean; // password / secure-text field — value must be masked
}

export type NativeSelectorStrategy = 'accessibility id' | 'name' | 'predicate string' | 'class chain';

export interface Driver {
  readonly kind: 'direct' | 'remote' | 'simulator' | 'wda';
  listDevices(): Promise<string[]>;
  useDevice(serial: string): void;
  currentDevice(): string | undefined;

  installApp(apkPath: string): Promise<void>;
  uninstallApp?(pkg: string): Promise<void>;
  isInstalled(pkg: string): Promise<boolean>;
  isRunning(pkg: string): Promise<boolean>;
  launchApp(pkg: string): Promise<void>;
  launchAppWithArgs?(pkg: string, args: Record<string, unknown>): Promise<void>;
  terminateApp(pkg: string): Promise<void>;
  clearData(pkg: string): Promise<void>;
  /** Soft keyboard currently shown? (dumpsys input_method mInputShown). */
  imeShown(): Promise<boolean>;
  /** Dump the last `lines` of logcat (optionally only lines matching `grep`). Evidence, not inference. */
  logcat(lines: number, grep?: string): Promise<string>;
  /** Read airplane-mode flag (global setting). */
  airplaneOn(): Promise<boolean>;
  /** Toggle airplane mode via `cmd connectivity airplane-mode`. */
  setAirplane(on: boolean): Promise<void>;
  /** Foreground package/activity owner — basis of the system/app/foreign classifier. */
  foregroundOwner(): Promise<string>;

  screenshot(): Promise<Buffer>;
  /** Raw uiautomator XML (parsing → @eN refs happens in the snapshot module, M3). */
  dumpXml(): Promise<string>;

  tapXY(x: number, y: number): Promise<void>;
  /** Press-and-hold at a point for `ms` (a same-point swipe) — RN often ignores instant taps. */
  pressXY(x: number, y: number, ms: number): Promise<void>;
  /** Backend-native element lookup when a flow carries a platform selector string. */
  tapBySelector?(using: NativeSelectorStrategy, value: string): Promise<void>;
  typeBySelector?(using: NativeSelectorStrategy, value: string, text: string): Promise<void>;
  clearBySelector?(using: NativeSelectorStrategy, value: string): Promise<void>;
  existsBySelector?(using: NativeSelectorStrategy, value: string): Promise<boolean>;
  inputText(text: string): Promise<void>;
  /** Clear the focused field (move to end, delete ~n chars in one keyevent batch). */
  clearFocusedText(approxLen?: number): Promise<void>;
  pressKey(key: 'back' | 'home' | 'enter'): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void>;
  /** `adb reverse tcp:8081 tcp:8081` so a debug RN/Expo build can reach Metro. */
  adbReverseMetro(port?: number): Promise<void>;
  /** Physical screen size in px (from `wm size`). */
  screenSize(): Promise<{ width: number; height: number } | null>;
  /** Screen density in dpi (from `wm density`). */
  screenDensity(): Promise<number | null>;
  openUrl(url: string): Promise<void>;
  /** Disable window/transition/animator scales to remove a class of flakiness. */
  disableAnimations(): Promise<void>;
}
