// qa_network: iOS simulators have no airplane-mode control (typed BACKEND_UNSUPPORTED instead of a
// raw driver error), and a toggle that fails must not leave a restore record claiming Swipium
// changed the network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDriver, buttonScreen, harness, structured } from './actFixFake.js';

class FailingAirplaneDriver extends FakeDriver {
  async setAirplane(): Promise<void> {
    throw new Error("cmd: Can't find service: connectivity");
  }
}

class IosLikeDriver extends FakeDriver {
  // @ts-expect-error — the fake pretends to be a WDA-backed driver for the platform check
  readonly kind = 'wda' as const;
}

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('network-toggle');
});
afterAll(async () => {
  await h.close();
});

async function approved(sessionId: string, action: string) {
  const first = structured(await h.call('qa_network', { sessionId, action }));
  expect(first.requiresConsent).toBe(true);
  return structured(await h.call('qa_network', { sessionId, action, consentId: first.consentId, approve: true }));
}

describe('qa_network', () => {
  it('refuses on a non-Android driver with BACKEND_UNSUPPORTED', async () => {
    const id = await h.start(new IosLikeDriver(buttonScreen('Home', 2)));
    const r = structured(await h.call('qa_network', { sessionId: id, action: 'status' }));
    expect(r.failureCode).toBe('BACKEND_UNSUPPORTED');
  });

  it('a failed toggle leaves no restore record', async () => {
    const id = await h.start(new FailingAirplaneDriver(buttonScreen('Home', 2)));
    const r = await approved(id, 'offline');
    expect(r.ok).toBeFalsy();
    expect(h.sessions.get(id)!.network).toBeUndefined();
    const status = structured(await h.call('qa_network', { sessionId: id, action: 'status' }));
    expect(status.changedBySwipium).toBe(false);
  });
});
