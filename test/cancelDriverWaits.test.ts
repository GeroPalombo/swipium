// Driver-level waits unwind on cancel instead of running to their timeout:
//  - the Android agent dumper's socket request (agentRequest) honours the call's abort signal
//  - waitForAppRender's poll pause is the cancellable sleep

import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { agentRequest } from '../src/drivers/androidDumper.js';
import { waitForAppRender } from '../src/snapshot/renderWait.js';
import { runWithSignal } from '../src/lib/abortScope.js';
import type { Driver } from '../src/drivers/Driver.js';

describe('agentRequest cancellation', () => {
  it('rejects with CancelledError as soon as the signal aborts, and destroys the socket', async () => {
    const sockets: Socket[] = [];
    const server = createServer((s) => sockets.push(s)); // accepts, never answers
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    try {
      const ac = new AbortController();
      const started = Date.now();
      const p = agentRequest(port, 'DUMP 250 2000', 10_000, ac.signal);
      setTimeout(() => ac.abort(), 50);
      await expect(p).rejects.toMatchObject({ name: 'CancelledError' });
      expect(Date.now() - started).toBeLessThan(2000);
      await expect(agentRequest(port, 'PING', 1000, ac.signal)).rejects.toMatchObject({ name: 'CancelledError' }); // already aborted
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});

describe('waitForAppRender cancellation', () => {
  it('a cancel during the poll pause ends the wait at once', async () => {
    const blank = '<hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]"/></hierarchy>';
    const d = { kind: 'direct', dumpXml: async () => blank } as unknown as Driver;
    const ac = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ac.signal, () => waitForAppRender(d, { timeoutMs: 20_000, pollMs: 5_000 }));
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: 'CancelledError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
