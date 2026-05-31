// Failure taxonomy (PHASE3-PLAN §4.3 / roadmap §6). Every failure Swipium can detect maps to a
// stable code with: a bucket (so qa_report can group failures the way a developer triages them),
// a severity, a default retry-safety, and an actionable recovery line. This turns "something
// failed" into "this class of failure, here's whether to retry, here's the fix" — the
// structured/actionable error practice, applied to mobile QA.
//
// Buckets (what a developer does about it):
//   app_bug        — the app is broken; fix the app.
//   environment    — device/toolchain/network/build setup; fix the environment.
//   missing_data   — a precondition / test account / fixture is absent; provide it.
//   mcp_limitation — automation couldn't proceed (opaque UI, stale ref, overlay); adjust approach.
//   unsafe_refused — a guardrail intentionally refused a destructive action; expected, not a bug.

export type FailureBucket = 'app_bug' | 'environment' | 'missing_data' | 'mcp_limitation' | 'unsafe_refused';

// Likely owner of a failure (roadmap §10): who acts to fix it. Distinct from the bucket,
// which is how a developer triages it. `swipium` = Swipium can often fix it itself.
export type FailureOwner = 'app' | 'environment' | 'swipium' | 'user';

export type FailureCode =
  // app_bug
  | 'NATIVE_CRASH'
  | 'ANR'
  | 'ERROR_BOUNDARY'
  | 'REDBOX'
  | 'LOGBOX'
  | 'BACKEND_ERROR'
  | 'BLANK_SCREEN'
  | 'INFINITE_SPINNER'
  | 'ASSERTION_FAILED'
  // environment
  | 'NO_DEVICE'
  | 'NO_ARTIFACT'
  | 'INVALID_FLOW'
  | 'WRONG_ARCH'
  | 'INSTALL_FAILED'
  | 'BUNDLE_ID_NOT_FOUND'
  | 'SIMULATOR_RUNTIME_MISSING'
  | 'SIMULATOR_BOOT_FAILED'
  | 'SIMULATOR_BOOT_TIMEOUT'
  | 'EMULATOR_BOOT_FAILED'
  | 'DEVICE_NOT_READY'
  | 'MULTIPLE_DEVICES'
  | 'DEV_SERVER_DOWN'
  | 'NETWORK_SERVICE_UNAVAILABLE'
  | 'NETWORK_OFFLINE'
  | 'WRONG_FOREGROUND'
  | 'WDA_UNREACHABLE'
  | 'WDA_BUILD_FAILED'
  | 'WDA_SIGNING_FAILED'
  | 'WDA_START_FAILED'
  | 'WDA_SESSION_FAILED'
  | 'WDA_SOURCE_SLOW'
  | 'WDA_APP_NOT_IDLE'
  | 'WDA_HIERARCHY_TOO_LARGE'
  | 'WDA_XPATH_REFUSED'
  | 'WDA_MAIN_THREAD_BUSY'
  | 'WDA_PORT_CONFLICT'
  | 'STALE_WDA_DEVICE'
  | 'PERMISSION_DIALOG'
  | 'NATIVE_ALERT'
  | 'SEED_FAILED'
  | 'ARTIFACT_PATH_UNWRITABLE'
  | 'REPORT_UPLOAD_SKIPPED'
  | 'SECRET_ARTIFACT_IN_EVIDENCE'
  | 'VISUAL_MASKING_STATUS_MISSING'
  | 'EVIDENCE_RETENTION_UNDECLARED'
  // missing_data
  | 'AUTH_GATE'
  | 'MISSING_FIXTURE'
  | 'MISSING_SECRET'
  // mcp_limitation
  | 'VISUAL_ONLY_SCREEN'
  | 'VISUAL_LOCATOR_DRIFT'
  | 'SNAPSHOT_FAILED'
  | 'SNAPSHOT_TOO_DEEP'
  | 'UI_IDLE_TIMEOUT'
  | 'STALE_REF'
  | 'INVALID_SELECTOR'
  | 'AMBIGUOUS_SELECTOR'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_HITTABLE'
  | 'KEYBOARD_OBSTRUCTION'
  | 'TEXT_INPUT_UNSUPPORTED'
  | 'WEBVIEW_UNAVAILABLE'
  | 'ANIMATION_IDLE_BLOCKED'
  | 'NO_CHANGE_LOOP'
  | 'OVERLAY_OBSTRUCTION'
  | 'STALE_CLIENT'
  | 'BACKEND_UNSUPPORTED'
  // unsafe_refused
  | 'BUNDLE_LOSS_REFUSED'
  | 'DESTRUCTIVE_REFUSED'
  | 'GIT_SCOPE_FORBIDDEN'
  | 'UNSAFE_ACTION_REFUSED'
  // --- roadmap §10: project detection ---
  | 'NOT_MOBILE_PROJECT'
  | 'MONOREPO_TARGET_AMBIGUOUS'
  | 'PROJECT_ROOT_EMPTY'
  | 'UNSUPPORTED_FRAMEWORK'
  // --- roadmap §10: artifact resolution / install ---
  | 'NO_BUILD_ARTIFACT'
  | 'MULTIPLE_ARTIFACTS_AMBIGUOUS'
  | 'ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL'
  | 'BUNDLETOOL_MISSING'
  | 'AAB_NEEDS_BUNDLETOOL'
  | 'AAB_BUILD_APKS_FAILED'
  | 'AAB_DEVICE_SPEC_FAILED'
  | 'AAB_INSTALL_FAILED'
  | 'APK_ARCH_INCOMPATIBLE'
  | 'ANDROID_MIN_SDK_INCOMPATIBLE'
  | 'ANDROID_SIGNATURE_CONFLICT'
  | 'ANDROID_SIGNING_FAILED'
  | 'IPA_INSTALL_UNSUPPORTED'
  | 'IPA_NEEDS_REAL_DEVICE'
  | 'IPA_SIGNING_REQUIRED'
  | 'IOS_APP_WRONG_ARCH'
  | 'IOS_SIMULATOR_APP_MISSING'
  // --- Dev2 plan §6: iOS real-device lane ---
  | 'REAL_DEVICE_NOT_CONNECTED'
  | 'REAL_DEVICE_UDID_NOT_PROVISIONED'
  | 'REAL_DEVICE_BUNDLE_ID_MISMATCH'
  | 'REAL_DEVICE_TEAM_MISMATCH'
  // --- roadmap §10: build-from-source ---
  | 'BUILD_COMMAND_UNAVAILABLE'
  | 'BUILD_FAILED'
  | 'BUILD_TIMED_OUT'
  | 'DEPENDENCY_INSTALL_REQUIRED'
  | 'EXPO_PREBUILD_REQUIRED'
  | 'GRADLE_FAILED'
  | 'XCODEBUILD_FAILED'
  | 'FLUTTER_BUILD_FAILED'
  // --- roadmap §10: runtime ---
  | 'METRO_REQUIRED'
  | 'METRO_FAILED'
  | 'DEVICE_BOOT_FAILED'
  | 'APP_LAUNCH_FAILED'
  // --- roadmap §10: automation / durability ---
  | 'MISSING_DURABLE_LOCATOR'
  | 'COORDINATE_ONLY_FLOW'
  | 'VISUAL_ONLY_ASSERTION'
  | 'AUTH_REQUIRED'
  | 'MISSING_TEST_DATA'
  // fallback
  | 'UNKNOWN';

export interface FailureInfo {
  bucket: FailureBucket;
  severity: 'low' | 'medium' | 'high';
  /** Default retry-safety: transient/observation failures are safe to retry; app bugs and
   *  mutating/looping failures are NOT (blind retry hides the bug or duplicates side effects). */
  retrySafe: boolean;
  summary: string;
  recovery: string;
  /** Likely owner of the fix (roadmap §10). Optional — defaults are derived from the bucket
   *  by `failureOwner()`; set explicitly where it differs from the bucket default. */
  owner?: FailureOwner;
  /** Whether Swipium can plausibly resolve this itself (roadmap §3.4 "can Swipium fix this?"). */
  selfFixable?: boolean;
}

export const FAILURES: Record<FailureCode, FailureInfo> = {
  NATIVE_CRASH: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'Native process crashed', recovery: 'Capture the crash log (qa_check_health) and fix the crash; do not blindly retry.' },
  ANR: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'App not responding (ANR)', recovery: 'Main thread is blocked — profile the slow work; retrying will not help.' },
  ERROR_BOUNDARY: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'App error screen / error boundary', recovery: 'A render/runtime error surfaced to the user — inspect logs and fix the failing screen.' },
  REDBOX: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'Framework red-box error', recovery: 'A fatal JS/runtime error — read the error text; often a bad bundle or thrown error.' },
  LOGBOX: { bucket: 'app_bug', severity: 'medium', retrySafe: true, summary: 'Framework warning overlay', recovery: 'Non-fatal warning(s) — dismiss with qa_clear_overlay; review before release.' },
  BACKEND_ERROR: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'Backend/error surface shown to the user', recovery: 'An error toast/banner/HTTP-error screen appeared — check the API response and error handling.' },
  BLANK_SCREEN: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'Blank/empty screen', recovery: 'Nothing rendered — check for a failed initial fetch, missing data state, or a swallowed error.' },
  INFINITE_SPINNER: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'Stuck loading indicator', recovery: 'A loading state never resolved — check the pending request/timeout handling.' },
  ASSERTION_FAILED: { bucket: 'app_bug', severity: 'high', retrySafe: false, summary: 'Expected UI was not present', recovery: 'The asserted text/element was missing — either a real regression or the flow needs updating for a UI change.' },

  NO_DEVICE: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'No online device or bootable emulator', recovery: 'Boot/create a device (qa_doctor), then qa_prepare_target.' },
  NO_ARTIFACT: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'No installable app artifact found', recovery: 'Provide an APK path (qa_prepare_target { apk }) or place one under the project.' },
  INVALID_FLOW: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Flow file is missing or invalid', recovery: 'Fix the flow YAML or pass a valid --flow/--flow-yaml before rerunning CI.' },
  WRONG_ARCH: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'App architecture does not match the target device', recovery: 'Use an app artifact built for this target. For iOS simulator, provide a simulator-SDK .app; for Android, use a device/emulator whose ABI matches the APK.' },
  INSTALL_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'App install failed', recovery: 'Check the surfaced reason (storage, signature mismatch, min-SDK, corrupt artifact) and fix it.' },
  BUNDLE_ID_NOT_FOUND: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Bundle identifier was not found on the device', recovery: 'Confirm the app is installed for this simulator/device and that the configured bundle id is correct.' },
  SIMULATOR_RUNTIME_MISSING: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'No usable iOS simulator runtime/device is installed', recovery: 'Install an iOS simulator runtime in Xcode, create an iPhone simulator, then retry qa_ios list/boot.' },
  SIMULATOR_BOOT_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'iOS simulator failed to boot', recovery: 'Retry boot, free host resources, erase the simulator if policy allows it, or choose another simulator runtime.' },
  SIMULATOR_BOOT_TIMEOUT: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'iOS simulator boot timed out', recovery: 'Check Simulator/Xcode health, free host resources, or boot a known-good simulator before retrying.' },
  EMULATOR_BOOT_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Emulator failed to boot', recovery: 'Retry boot, free resources, or pick a different AVD (qa_doctor).' },
  DEVICE_NOT_READY: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Device exists but is not ready for automation', recovery: 'Wait for the device to finish booting/unlocking, then rerun the preflight or select a ready device explicitly.' },
  MULTIPLE_DEVICES: { bucket: 'environment', severity: 'medium', retrySafe: true, summary: 'More than one device is online', recovery: 'Pass an explicit device to qa_prepare_target so the target is unambiguous.' },
  DEV_SERVER_DOWN: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Dev/bundler server not reachable', recovery: 'Start the dev server so a debug build can fetch its bundle.' },
  NETWORK_SERVICE_UNAVAILABLE: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Required network service is unavailable', recovery: 'Start the required service, fix the URL, or remove it from ci.requiredServices before rerunning CI.' },
  NETWORK_OFFLINE: { bucket: 'environment', severity: 'medium', retrySafe: true, summary: 'Device is offline', recovery: 'Restore connectivity before network-dependent flows.' },
  WRONG_FOREGROUND: { bucket: 'environment', severity: 'medium', retrySafe: true, summary: 'A different app is in the foreground', recovery: 'Relaunch the app under test with qa_prepare_target.' },
  WDA_UNREACHABLE: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'WebDriverAgent is unreachable or did not return UI source', recovery: 'Check qa_wda status/logs, restart WDA, and confirm it is attached to the intended device.' },
  WDA_BUILD_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'WebDriverAgent build failed', recovery: 'Open the WDA build log artifact, fix the Xcode build error, then retry qa_wda build.' },
  WDA_SIGNING_FAILED: { bucket: 'environment', severity: 'high', retrySafe: false, summary: 'WebDriverAgent signing/provisioning failed', recovery: 'Configure a valid development team, certificate, provisioning profile, and trusted device before retrying WDA build.' },
  WDA_START_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'WebDriverAgent did not start', recovery: 'Check qa_wda logs/status, confirm the target device is booted/trusted, and restart WDA.' },
  WDA_SESSION_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'WebDriverAgent session creation failed', recovery: 'Confirm WDA is paired with the intended device and that the app bundle id is installed, then retry attach.' },
  WDA_SOURCE_SLOW: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'WDA page-source retrieval is slow', recovery: 'Tune snapshot depth/attributes, avoid XPath, and reduce large accessibility hierarchies where possible.' },
  WDA_APP_NOT_IDLE: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'WDA/XCTest is waiting for app idle', recovery: 'Reduce animations, fix main-thread work, or add app-side idling hooks so XCTest can interact reliably.' },
  WDA_HIERARCHY_TOO_LARGE: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'WDA accessibility hierarchy is too large or deep', recovery: 'Limit snapshot depth/children and simplify accessibility trees on complex screens.' },
  WDA_XPATH_REFUSED: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, summary: 'XPath locator refused for WDA reliability', recovery: 'Use accessibility id, predicate string, or class chain; Swipium does not generate XPath for iOS.' },
  WDA_MAIN_THREAD_BUSY: { bucket: 'app_bug', severity: 'medium', retrySafe: true, summary: 'App main thread appears busy during WDA automation', recovery: 'Profile main-thread work, loading states, and animations; WDA tuning cannot fully fix app-side non-idleness.' },
  WDA_PORT_CONFLICT: { bucket: 'environment', severity: 'medium', retrySafe: true, summary: 'WebDriverAgent port is already in use or points at the wrong server', recovery: 'Stop the stale process or choose a different WDA port, then verify /status before attaching.' },
  STALE_WDA_DEVICE: { bucket: 'environment', severity: 'high', retrySafe: false, summary: 'WDA appears bound to a different device than the session target', recovery: 'Stop the stale WDA process or start a new session for the intended UDID; do not reuse ambiguous device mappings.' },
  PERMISSION_DIALOG: { bucket: 'environment', severity: 'medium', retrySafe: false, summary: 'Runtime permission dialog is visible', recovery: 'Handle the permission prompt deliberately, or pre-grant permissions only when policy allows it.' },
  NATIVE_ALERT: { bucket: 'environment', severity: 'medium', retrySafe: false, summary: 'Native alert is visible', recovery: 'Inspect/dismiss the alert intentionally before continuing the flow.' },
  SEED_FAILED: { bucket: 'environment', severity: 'medium', retrySafe: true, summary: 'Seeding a precondition failed (setup, not an app bug)', recovery: 'Fix the fixture seed (deep link/script/api) and re-run the flow; this is a setup failure, not an app defect.' },
  ARTIFACT_PATH_UNWRITABLE: { bucket: 'environment', severity: 'high', retrySafe: true, summary: 'Artifact or report output path is not writable', recovery: 'Create the output directory, fix permissions, or point --json/--report/--junit/--artifacts-dir at a writable location.' },
  REPORT_UPLOAD_SKIPPED: { bucket: 'environment', severity: 'medium', retrySafe: true, summary: 'CI report upload or publication was skipped', recovery: 'Use if: always()/equivalent artifact upload steps and upload the full Swipium run directory even when tests fail.' },
  SECRET_ARTIFACT_IN_EVIDENCE: { bucket: 'unsafe_refused', severity: 'high', retrySafe: false, owner: 'user', summary: 'Certification evidence references a secret-bearing artifact', recovery: 'Remove .env/private-key/provisioning/service-account files from evidence and replace them with redacted derived proof.' },
  VISUAL_MASKING_STATUS_MISSING: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, owner: 'user', summary: 'Visual/OCR/AI evidence does not declare screenshot masking status', recovery: 'Record lane.privacy.screenshotMasking or manifest.privacy.screenshotMasking before using visual/OCR/AI evidence for certification.' },
  EVIDENCE_RETENTION_UNDECLARED: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, owner: 'user', summary: 'Evidence bundle has no artifact retention policy', recovery: 'Declare artifact retention in the CI manifest or .swipium config so reviewers know how long screenshots/logs/reports are kept.' },

  AUTH_GATE: { bucket: 'missing_data', severity: 'medium', retrySafe: false, summary: 'Login required, no usable credentials', recovery: 'Provide a test account (a fixture with a testAccount, plus TEST_EMAIL/TEST_PASSWORD).' },
  MISSING_FIXTURE: { bucket: 'missing_data', severity: 'medium', retrySafe: false, summary: 'A required precondition/fixture is absent', recovery: 'Create the declared required state, or run a setup step, then re-run.' },
  MISSING_SECRET: { bucket: 'missing_data', severity: 'medium', retrySafe: false, summary: 'Required secret or flow variable is missing', recovery: 'Provide the variable through the CI environment, --secret-file, SWIPIUM_SECRET_FILE, or .swipium/secrets.json; never inline secrets in flows.' },

  VISUAL_ONLY_SCREEN: { bucket: 'mcp_limitation', severity: 'low', retrySafe: false, summary: 'Screen has no usable UI tree (canvas/map/webview)', recovery: 'Use qa_screenshot, coordinate taps, and qa_assert_visual.' },
  VISUAL_LOCATOR_DRIFT: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'Visual/OCR locator drifted', recovery: 'Refresh the screenshot crop/OCR confidence and add a fallback structured locator where the UI tree exposes one.' },
  SNAPSHOT_FAILED: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'Could not capture the UI tree', recovery: 'Retry; after repeated failures Swipium switches to visual-fallback.' },
  SNAPSHOT_TOO_DEEP: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'UI snapshot was too deep or slow to retrieve reliably', recovery: 'Narrow the screen state, reduce UI complexity, or use visual assertions for this screen.' },
  UI_IDLE_TIMEOUT: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'UI did not become idle before timeout', recovery: 'Wait for animations/network work to settle or add a targeted wait before interacting.' },
  STALE_REF: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'Element ref is stale (screen changed)', recovery: 'Re-run qa_snapshot to refresh refs, then retry.' },
  INVALID_SELECTOR: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'Selector syntax or strategy is invalid', recovery: 'Fix the selector syntax/strategy; for iOS WDA use accessibility id, name, predicate string, or class chain.' },
  AMBIGUOUS_SELECTOR: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, summary: 'Selector matched more than one element', recovery: 'Add a more precise locator with class/text/bounds hints or a unique testID/accessibility identifier; Swipium will not fall back to coordinates silently.' },
  ELEMENT_NOT_FOUND: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'Target element not found', recovery: 'Re-snapshot and check the selector; the element may be off-screen (scroll) or renamed (UI change).' },
  ELEMENT_NOT_HITTABLE: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'Element exists but is not hittable', recovery: 'Inspect for overlays, disabled state, off-screen bounds, or use scroll/clear overlay before retrying.' },
  KEYBOARD_OBSTRUCTION: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'Keyboard is covering the target', recovery: 'Dismiss the keyboard or press enter/back before interacting with the covered element.' },
  TEXT_INPUT_UNSUPPORTED: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, summary: 'Backend cannot safely type this text value', recovery: 'Use ASCII-safe fixture data, configure a Unicode-safe backend, or tune WDA/Appium typing settings before replay.' },
  WEBVIEW_UNAVAILABLE: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'WebView context or content is unavailable to native automation', recovery: 'Use visual assertions, add accessibility identifiers around the web content, or wait for the WebView to finish loading.' },
  ANIMATION_IDLE_BLOCKED: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'Animation prevented UI idle', recovery: 'Wait for the animation to finish or disable/reduce animations in the test environment.' },
  NO_CHANGE_LOOP: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, summary: 'Repeated actions changed nothing', recovery: 'Likely wrong coordinates, a disabled control, an overlay, or an auth wall — stop and inspect.' },
  OVERLAY_OBSTRUCTION: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'An overlay is covering the target', recovery: 'Clear it with qa_clear_overlay (keyboard/dialog/banner), then retry.' },
  STALE_CLIENT: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: true, summary: 'MCP client is running an old server build', recovery: 'Restart the client so it reloads the current Swipium build.' },
  BACKEND_UNSUPPORTED: { bucket: 'mcp_limitation', severity: 'low', retrySafe: false, summary: 'Operation not supported by the current backend', recovery: 'For structured iOS tap/type/snapshot, attach WebDriverAgent with qa_wda. Without WDA, use qa_assert_visual and qa_ios lifecycle/deep links.' },

  BUNDLE_LOSS_REFUSED: { bucket: 'unsafe_refused', severity: 'low', retrySafe: false, summary: 'Refused a clear/reset that would wipe a debug bundle', recovery: 'Expected guardrail — use a release build for clean-state tests, or run destructive steps last.' },
  DESTRUCTIVE_REFUSED: { bucket: 'unsafe_refused', severity: 'low', retrySafe: false, summary: 'Refused a destructive action pending consent', recovery: 'Expected guardrail — approve the consent prompt only if you intend the side effect.' },
  GIT_SCOPE_FORBIDDEN: { bucket: 'unsafe_refused', severity: 'low', retrySafe: false, owner: 'user', summary: 'Git command refused because Git is outside Swipium scope', recovery: 'Run Git operations yourself outside Swipium; configure QA seed/provider commands to use non-Git executables.' },
  UNSAFE_ACTION_REFUSED: { bucket: 'unsafe_refused', severity: 'low', retrySafe: false, owner: 'user', summary: 'Refused an unsafe action (purchase/delete/send) during exploration', recovery: 'Expected guardrail — explicitly allow this action class (e.g. allowDestructive) only if you intend its side effect.' },

  // --- roadmap §10: project detection ---
  NOT_MOBILE_PROJECT: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'user', summary: 'No supported mobile project found at the resolved root', recovery: 'Pass an explicit projectRoot that contains an Expo/RN/native-Android/native-iOS/Flutter app, or run from inside one.' },
  MONOREPO_TARGET_AMBIGUOUS: { bucket: 'environment', severity: 'medium', retrySafe: true, owner: 'user', summary: 'Monorepo has multiple app targets — none chosen', recovery: 'Specify which app/package to test (projectRoot or target) so Swipium does not guess.' },
  PROJECT_ROOT_EMPTY: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'user', summary: 'Project root is empty', recovery: 'Run inside a project directory or pass projectRoot to a real app.' },
  UNSUPPORTED_FRAMEWORK: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'user', summary: 'Project framework is not supported', recovery: 'Swipium supports Expo, bare React Native, native Android, native iOS, and Flutter. File a request for other frameworks.' },

  // --- roadmap §10: artifact resolution / install ---
  NO_BUILD_ARTIFACT: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'swipium', selfFixable: true, summary: 'No installable build artifact (APK/AAB/IPA/.app) found', recovery: 'Build from source, pass an explicit artifact path, or drop a build under the project.' },
  MULTIPLE_ARTIFACTS_AMBIGUOUS: { bucket: 'environment', severity: 'medium', retrySafe: true, owner: 'user', summary: 'Multiple candidate artifacts found — none clearly newest/best', recovery: 'Pass an explicit artifact path, or accept the ranked top candidate Swipium proposes.' },
  ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL: { bucket: 'environment', severity: 'medium', retrySafe: true, owner: 'user', summary: 'Best artifact is outside the project root', recovery: 'Re-run with allowOutsideRoot:true to use an artifact from a download/DerivedData path outside the project.' },
  BUNDLETOOL_MISSING: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'bundletool is required but not installed', recovery: 'Install bundletool (brew install bundletool), set $BUNDLETOOL_JAR, or build an installable APK directly.' },
  AAB_NEEDS_BUNDLETOOL: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'Only a .aab exists and bundletool is not installed', recovery: 'Install bundletool (brew install bundletool) so Swipium can build an installable universal APK set, or build an APK directly.' },
  AAB_BUILD_APKS_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'bundletool build-apks failed for the .aab', recovery: 'Open the bundletool log, confirm the keystore/signing config, and retry; or build a universal APK directly.' },
  AAB_DEVICE_SPEC_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'bundletool could not build a device-specific APK set for the connected device', recovery: 'Confirm the device is online (adb), retry the connected-device build, or fall back to a universal APK set.' },
  AAB_INSTALL_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'bundletool install-apks failed', recovery: 'Confirm the device ABI/min-SDK match the generated APK set; check the install log and retry.' },
  APK_ARCH_INCOMPATIBLE: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'APK native ABIs do not match the target device', recovery: 'Use an APK built for the device ABI (or an emulator whose ABI matches), or build a universal APK.' },
  ANDROID_MIN_SDK_INCOMPATIBLE: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'environment', summary: "APK minSdkVersion is higher than the device's API level", recovery: 'Install on a device/emulator whose API level meets the APK minSdk, or lower minSdkVersion in the build and rebuild. Retrying the same install will not help.' },
  ANDROID_SIGNATURE_CONFLICT: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'swipium', selfFixable: true, summary: 'Installed app was signed with a different key (signature conflict)', recovery: 'Uninstall the existing app (adb uninstall <package>) then reinstall; the new build is signed with a different key. This wipes the app data on that device.' },
  ANDROID_SIGNING_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'Android signing failed for the APK set', recovery: 'Provide a valid debug/release keystore, or let bundletool use the default debug keystore for emulator installs.' },
  IPA_INSTALL_UNSUPPORTED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'environment', summary: 'Installing a .ipa is not supported in this environment', recovery: 'Use a simulator-SDK .app for the simulator, or install the .ipa on a real device via Apple tooling (Xcode/devicectl).' },
  IPA_NEEDS_REAL_DEVICE: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'user', summary: 'A .ipa targets a real device, not the simulator', recovery: 'Connect a provisioned real device, or build a simulator .app for simulator testing.' },
  IPA_SIGNING_REQUIRED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'user', summary: 'Installing this app on a real device requires signing', recovery: 'Configure a development team, certificate, and provisioning profile, then re-sign/rebuild the .ipa.' },
  IOS_APP_WRONG_ARCH: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'iOS .app was built for the wrong destination', recovery: 'Provide a simulator-SDK .app for the simulator (iphonesimulator), or a device build for a real device.' },
  IOS_SIMULATOR_APP_MISSING: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'swipium', selfFixable: true, summary: 'No simulator-compatible .app found', recovery: 'Build an iOS simulator app, or pass an explicit simulator .app path.' },

  // --- Dev2 plan §6: iOS real-device lane ---
  REAL_DEVICE_NOT_CONNECTED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'user', summary: 'No eligible connected real iOS device for a real-device run', recovery: 'Connect an iPhone/iPad over USB, unlock it, trust this Mac, and enable Developer Mode, then retry.' },
  REAL_DEVICE_UDID_NOT_PROVISIONED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'user', summary: "Target device UDID is not in the artifact's provisioning profile", recovery: "Add the device UDID to the provisioning profile (or use an automatic-signing development build) and re-sign the .ipa, then retry." },
  REAL_DEVICE_BUNDLE_ID_MISMATCH: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'user', summary: 'Artifact bundle id does not match the provisioning profile / target', recovery: 'Sign the .ipa with a provisioning profile whose app id matches the bundle id under test, then retry.' },
  REAL_DEVICE_TEAM_MISMATCH: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'user', summary: 'Signing team does not match the provisioning profile team', recovery: 'Re-sign the .ipa so the codesign team identifier matches the provisioning profile team, then retry.' },

  // --- roadmap §10: build-from-source ---
  BUILD_COMMAND_UNAVAILABLE: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'No build command is available for this framework/platform', recovery: 'Install the required toolchain (Gradle/Xcode/Flutter/Expo CLI) or provide a prebuilt artifact.' },
  BUILD_FAILED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'app', selfFixable: false, summary: 'Build from source failed', recovery: 'Open the build log artifact, fix the compile/config error, then re-run the build. A build failure is NOT a test failure.' },
  BUILD_TIMED_OUT: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'Build exceeded its time budget', recovery: 'Increase the build timeout, warm caches, or build once manually then re-run Swipium against the artifact.' },
  DEPENDENCY_INSTALL_REQUIRED: { bucket: 'environment', severity: 'medium', retrySafe: true, owner: 'environment', summary: 'Dependencies must be installed before building', recovery: 'Run the project install step (npm/yarn/pnpm install, pod install, flutter pub get), then re-run the build.' },
  EXPO_PREBUILD_REQUIRED: { bucket: 'environment', severity: 'medium', retrySafe: true, owner: 'swipium', selfFixable: true, summary: 'Expo project has no native android/ios directories', recovery: 'Run `npx expo prebuild` (or build with `npx expo run:*` which prebuilds) before a native build.' },
  GRADLE_FAILED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'app', summary: 'Gradle build failed', recovery: 'Open the Gradle log artifact and fix the reported error (SDK/dependency/compile), then retry.' },
  XCODEBUILD_FAILED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'app', summary: 'xcodebuild failed', recovery: 'Open the xcodebuild log artifact and fix the reported error (scheme/signing/compile), then retry.' },
  FLUTTER_BUILD_FAILED: { bucket: 'environment', severity: 'high', retrySafe: false, owner: 'app', summary: 'flutter build failed', recovery: 'Open the flutter build log artifact and fix the reported error, then retry.' },

  // --- roadmap §10: runtime ---
  METRO_REQUIRED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'swipium', selfFixable: true, summary: 'A debug RN/Expo build needs Metro running', recovery: 'Start the bundler so the debug build can fetch its JS bundle.' },
  METRO_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'Metro/dev server failed to start or stay healthy', recovery: 'Check the Metro log artifact (port in use, dependency error), free the port, then restart.' },
  DEVICE_BOOT_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'swipium', selfFixable: true, summary: 'Emulator/simulator failed to boot', recovery: 'Retry boot, free host resources, or pick a different AVD/simulator runtime.' },
  APP_LAUNCH_FAILED: { bucket: 'environment', severity: 'high', retrySafe: true, owner: 'environment', summary: 'App was installed but failed to launch', recovery: 'Confirm the bundle/app id, check the device log for the launch error, and verify Metro (for debug builds) is reachable.' },

  // --- roadmap §10: automation / durability ---
  MISSING_DURABLE_LOCATOR: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, owner: 'app', summary: 'A UI element has no durable locator (no testID/accessibilityIdentifier/resource-id)', recovery: 'Add an accessibilityIdentifier (iOS) / testID / resource-id to the element so automation is stable; coordinate fallback is brittle.' },
  COORDINATE_ONLY_FLOW: { bucket: 'mcp_limitation', severity: 'medium', retrySafe: false, owner: 'app', summary: 'Flow relies on coordinate taps (brittle)', recovery: 'Add testIDs/accessibility identifiers to the tapped elements, then regenerate the flow for durable selectors.' },
  VISUAL_ONLY_ASSERTION: { bucket: 'mcp_limitation', severity: 'low', retrySafe: false, owner: 'swipium', summary: 'Verification was visual-only, not structurally asserted', recovery: 'Treat as weaker evidence — add structured assertions where the UI tree is available; keep the screenshot as evidence.' },
  AUTH_REQUIRED: { bucket: 'missing_data', severity: 'medium', retrySafe: false, owner: 'user', summary: 'Login required to reach this workflow', recovery: 'Provide test credentials (TEST_EMAIL/TEST_PASSWORD via a secret file), or accept pre-login-only coverage.' },
  MISSING_TEST_DATA: { bucket: 'missing_data', severity: 'medium', retrySafe: false, owner: 'user', summary: 'Required test data/fixture is missing', recovery: 'Seed or provide the required state (account, record, entitlement), then re-run; do not fake coverage.' },

  UNKNOWN: { bucket: 'mcp_limitation', severity: 'low', retrySafe: true, summary: 'Unclassified failure', recovery: 'Inspect the message; consider filing it so the taxonomy can cover it.' },
};

/** Default owner derived from the failure bucket, unless the entry sets one explicitly (§10). */
const OWNER_BY_BUCKET: Record<FailureBucket, FailureOwner> = {
  app_bug: 'app',
  environment: 'environment',
  missing_data: 'user',
  mcp_limitation: 'swipium',
  unsafe_refused: 'user',
};

/** Likely owner of a failure code's fix (roadmap §10). */
export function failureOwner(code: FailureCode): FailureOwner {
  const info = FAILURES[code];
  return info.owner ?? OWNER_BY_BUCKET[info.bucket];
}

/** Whether Swipium can plausibly fix this itself (roadmap §3.4). */
export function isSelfFixable(code: FailureCode): boolean {
  return FAILURES[code].selfFixable ?? false;
}

/** Map a deterministic health finding kind (oracle) to a failure code. */
export function failureForFindingKind(kind: string): FailureCode {
  switch (kind) {
    case 'native_crash': return 'NATIVE_CRASH';
    case 'anr': return 'ANR';
    case 'wrong_foreground_app': return 'WRONG_FOREGROUND';
    case 'wda_unreachable': return 'WDA_UNREACHABLE';
    case 'permission_dialog': return 'PERMISSION_DIALOG';
    case 'native_alert': return 'NATIVE_ALERT';
    case 'rn_redbox': return 'REDBOX';
    case 'rn_logbox_error': return 'LOGBOX';
    case 'app_error_boundary': return 'ERROR_BOUNDARY';
    case 'webview_error': return 'ERROR_BOUNDARY';
    case 'unknown_error_surface': return 'BACKEND_ERROR';
    default: return 'UNKNOWN';
  }
}

/** Map a qa_note category to a bucket (for outcomes recorded by the agent). */
export function bucketForNoteCategory(category?: string): FailureBucket {
  switch (category) {
    case 'app_bug': return 'app_bug';
    case 'missing_test_data': return 'missing_data';
    case 'destructive_refused': return 'unsafe_refused';
    case 'mcp_limitation': return 'mcp_limitation';
    default: return 'mcp_limitation';
  }
}

export const ALL_BUCKETS: FailureBucket[] = ['app_bug', 'environment', 'missing_data', 'mcp_limitation', 'unsafe_refused'];

// qaFail lives here (not in result.ts) so the taxonomy is the single source of a failure's
// retry-safety + recovery. Tools emit `qaFail('CODE')` and inherit the registry defaults.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError } from '../lib/result.js';

export function qaFail(
  code: FailureCode,
  opts: { what?: string; changedState?: boolean; nextSteps?: string[]; extra?: Record<string, unknown> } = {},
): CallToolResult {
  const info = FAILURES[code];
  return qaError(
    {
      what: opts.what ?? info.summary,
      changedState: opts.changedState ?? false,
      retrySafe: info.retrySafe,
      nextSteps: opts.nextSteps ?? [info.recovery],
      failureCode: code,
    },
    // owner + bucket + canSwipiumFix travel with every typed failure (§3.4 / §10) so an agent
    // can route the blocker (app dev vs environment vs user input) without a second lookup.
    { bucket: info.bucket, owner: failureOwner(code), canSwipiumFix: isSelfFixable(code), ...(opts.extra ?? {}) },
  );
}
