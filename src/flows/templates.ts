import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GeneratedFlowTemplate {
  path: string;
  content: string;
  executable?: boolean;
}

export interface FlowTemplateInitResult {
  files: Array<{ path: string; written: boolean; skipped: boolean }>;
}

const FLOW_TEMPLATES: Record<string, string> = {
  'launch-smoke.yaml': `name: launch_smoke
mode: auto
budgetProfile: guardrail
setup:
  - prepareTarget
steps:
  - waitForIdle: 8000
  - screenshot: "launch evidence"
  - assertVisual: "App launched without a native crash, red screen, or blocking error dialog."
`,
  'login-smoke.yaml': `name: login_smoke
mode: structured
budgetProfile: full_smoke
fixtures:
  - test_account
setup:
  - prepareTarget
steps:
  - waitForVisible: "Email"
  - inputText:
      into: "Email"
      text: "\${TEST_EMAIL}"
  - inputText:
      into: "Password"
      text: "\${TEST_PASSWORD}"
      secret: true
  - tap: "Sign in"
  - waitForVisible:
      text: "Home"
      timeoutMs: 12000
  - assertVisible: "Home"
`,
  'ios-wda-smoke.yaml': `name: ios_wda_smoke
mode: structured
budgetProfile: full_smoke
setup:
  - prepareTarget
steps:
  - waitForVisible:
      text: "accessibility id=login_email_field"
      timeoutMs: 12000
  - screenshot: "iOS WDA launch evidence"
  - tap: "accessibility id=login_email_field"
  - inputText:
      into: "accessibility id=login_email_field"
      text: "\${TEST_EMAIL}"
  - inputText:
      into: "accessibility id=login_password_field"
      text: "\${TEST_PASSWORD}"
      secret: true
  - tap: "accessibility id=login_continue_button"
  - waitForVisible:
      text: "accessibility id=home_title"
      timeoutMs: 12000
  - assertVisible: "accessibility id=home_title"
`,
  'offline-smoke.yaml': `name: offline_smoke
mode: structured
budgetProfile: guardrail
setup:
  - prepareTarget
teardown:
  - networkOnline
steps:
  - networkOffline
  - waitForIdle: 5000
  - assertVisible: "Offline"
  - networkOnline
  - waitForIdle: 5000
`,
  'permission-smoke.yaml': `name: permission_smoke
mode: structured
budgetProfile: guardrail
setup:
  - prepareTarget
steps:
  - tap: "Continue"
  - waitForVisible:
      text: "Allow"
      timeoutMs: 8000
  - screenshot: "permission prompt"
  - note:
      outcome: pass
      reason: "Runtime permission prompt appeared and was captured for deliberate handling."
`,
  'deep-link-smoke.yaml': `name: deep_link_smoke
mode: auto
budgetProfile: guardrail
steps:
  - openUrl: "\${TEST_DEEP_LINK}"
  - waitForIdle: 8000
  - screenshot: "deep link evidence"
  - assertVisual: "Deep link opened the expected destination."
`,
  'saved-item-persistence.yaml': `name: saved_item_persistence
mode: structured
budgetProfile: full_smoke
setup:
  - prepareTarget
steps:
  - tap: "Save"
  - waitForVisible: "Saved"
  - restartApp
  - waitForVisible: "Saved"
  - assertVisible: "Saved"
`,
  'visual-map-canvas-smoke.yaml': `name: visual_map_canvas_smoke
mode: visual
budgetProfile: visual_smoke
setup:
  - prepareTarget
steps:
  - waitForIdle: 8000
  - screenshot: "visual surface evidence"
  - assertVisual: "Map, chart, canvas, or other visual-only surface rendered expected primary content."
`,
};

function smokePack(): string {
  return `name: smoke
flows:
  - launch-smoke
  - login-smoke
  - ios-wda-smoke
  - offline-smoke
  - permission-smoke
  - deep-link-smoke
  - saved-item-persistence
  - visual-map-canvas-smoke
parallel: false
`;
}

export function flowTemplateFiles(root: string): GeneratedFlowTemplate[] {
  const flowsDir = join(root, '.swipium', 'flows');
  const packDir = join(root, '.swipium', 'packs');
  return [
    ...Object.entries(FLOW_TEMPLATES).map(([name, content]) => ({ path: join(flowsDir, name), content })),
    { path: join(packDir, 'smoke.yaml'), content: smokePack() },
  ];
}

export function initFlowTemplates(root: string, opts: { force?: boolean } = {}): FlowTemplateInitResult {
  const files = flowTemplateFiles(root).map((f) => {
    if (existsSync(f.path) && !opts.force) return { path: f.path, written: false, skipped: true };
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    if (f.executable) chmodSync(f.path, 0o755);
    return { path: f.path, written: true, skipped: false };
  });
  return { files };
}
