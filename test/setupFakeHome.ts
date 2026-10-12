// Hermetic HOME for every test file: point HOME / USERPROFILE at a fresh temp dir
// before any test module (and so any src module) is imported, so nothing writes into the real
// ~/.swipium (runs, projects.json, registry.json, processes.json). Files that need their own fake
// HOME still set it at their top, which simply overrides this one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
