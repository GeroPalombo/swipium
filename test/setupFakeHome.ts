// Hermetic HOME for every test file: point HOME / USERPROFILE at a fresh temp dir
// before any test module (and so any src module) is imported, so nothing writes into the real
// ~/.swipium (runs, projects.json, registry.json, processes.json). Files that need their own fake
// HOME still set it at their top, which simply overrides this one.
//
// The developer's own Swipium / Claude Code / Codex settings must not leak into tests either (a
// SWIPIUM_CONSENT_PREAPPROVE or SWIPIUM_MAX_WAIT_MS in the shell changes tool behaviour), so they
// are removed here; a test that needs one sets it itself. Opt-in switches for the test run are kept.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/** Variables that configure the test run itself (read only by tests), not Swipium. */
const TEST_RUN_SWITCHES = new Set([
  'SWIPIUM_SLOW_TESTS', // run the slow, host-load-sensitive tests (real npx, real processes)
  'SWIPIUM_DEVICE_SERIAL', // run the real-device dumper test against this serial
  'SWIPIUM_UPDATE_SKILL', // rewrite the shipped SKILL.md copies instead of failing on drift
]);
for (const name of Object.keys(process.env)) {
  if (TEST_RUN_SWITCHES.has(name)) continue;
  if (name.startsWith('SWIPIUM_') || name === 'CLAUDE_PROJECT_DIR' || name === 'CLAUDE_CONFIG_DIR' || name === 'CODEX_HOME') {
    delete process.env[name];
  }
}

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

// This setup file runs once per test file, so each file owns its own fakeHome and removing it
// after that file's tests (setup-file hooks run last) cannot affect another file.
afterAll(() => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // best-effort: a leftover temp dir is harmless
  }
});
