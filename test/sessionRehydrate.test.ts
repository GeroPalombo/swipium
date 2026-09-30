// SWIP-13: secrets are (deliberately) never persisted, so a session rehydrated after a server
// restart has an empty redaction set. When the persisted state shows prior secret-bearing
// activity, the reloaded session must carry redactionDegraded so qa_report can disclose it.
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded (dynamic import below).

import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-test-home-'));
process.env.HOME = fakeHome;

const { SessionStore } = await import('../src/session/store.js');

const projectRoot = mkdtempSync(join(tmpdir(), 'swipium-test-proj-'));

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('session rehydration redaction flag (SWIP-13)', () => {
  it('flags a restored session that had secrets; never a live or secret-free one', () => {
    const store = new SessionStore();

    const withSecret = store.create(projectRoot);
    store.setInput(withSecret, 'SWIPIUM_TEST_PASSWORD', 'hunter22', true, 'needs_input:credentials');
    store.markAuth(withSecret, { loginPerformed: true, loginPerformedAt: Date.now() });

    const withoutSecret = store.create(projectRoot);
    store.setInput(withoutSecret, 'SWIPIUM_TEST_EMAIL', 'qa@example.com', false, 'needs_input:credentials');

    // A live (non-restarted) session is never flagged — its secret set is intact.
    expect(withSecret.redactionDegraded).toBeUndefined();
    expect(withoutSecret.redactionDegraded).toBeUndefined();
    expect(withSecret.secrets.has('hunter22')).toBe(true);

    store.flushAll();

    // A fresh store instance simulates a server restart: state.json reloads, secrets do not.
    const restarted = new SessionStore();
    const reloadedWith = restarted.get(withSecret.id);
    const reloadedWithout = restarted.get(withoutSecret.id);
    expect(reloadedWith?.secrets.size).toBe(0);
    expect(reloadedWith?.redactionDegraded).toBe(true);
    expect(reloadedWithout?.redactionDegraded).toBeUndefined();
  });
});
