// Vision Gap Fix 12 — full-suite timeout reliability. Some diagnostic tests (WDA/iOS device probing,
// the qa_ci certification doctor, device-matrix capability checks) intentionally exercise slow
// external-tool discovery paths that legitimately take a few seconds and, on a slower CI/dev host,
// exceed Vitest's 5s per-test default — producing spurious timeout failures under the default
// `npm test`. We raise the per-test + hook timeout to 30s so the documented default command is stable
// WITHOUT a manual `--testTimeout` override. This is a ceiling, not a sleep: a genuinely hung promise
// still fails (at 30s), so real hangs are NOT hidden — only host-speed sensitivity is absorbed.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
