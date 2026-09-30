// qa_snapshot's post-restart reattach note is platform-aware (rehydrateNote(session)): an iOS
// session is told to relaunch with qa_prepare_ios_target, not the Android qa_prepare_target.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeDriver, buttonScreen, harness, textOf } from './actFixFake.js';

vi.mock('../src/session/attach.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session/attach.js')>();
  return {
    ...actual,
    // Report every attach as a post-restart rehydrate.
    getDriver: async (session: Parameters<typeof actual.getDriver>[0]) => {
      const res = await actual.getDriver(session);
      return res.driver ? { ...res, rehydrated: true } : res;
    },
  };
});

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('smokefix-rehydrate');
});
afterAll(async () => {
  await h.close();
});

describe('qa_snapshot rehydrate note', () => {
  it('names qa_prepare_ios_target for an iOS (simulator-UDID) session', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    h.sessions.get(id)!.device = '190EA878-5D54-416C-B858-E60588B0DAF9';
    const text = textOf(await h.call('qa_snapshot', { sessionId: id }));
    expect(text).toContain('reattached the device transport');
    expect(text).toContain('qa_prepare_ios_target');
  });

  it('names qa_prepare_target for an Android session', async () => {
    const id = await h.start(new FakeDriver(buttonScreen('Home', 3)));
    h.sessions.get(id)!.device = 'emulator-5554';
    const text = textOf(await h.call('qa_snapshot', { sessionId: id }));
    expect(text).toContain('relaunch with qa_prepare_target)');
  });
});
