// tools/list is loaded into the agent's context by clients that don't defer it (Codex loads every
// tool up front), so its size is a real cost. This pins a byte budget for the serialized list.
// 2.1.2 trimmed descriptions from ~69.8 KB to ~62.7 KB; the budget keeps ~5% headroom over that.
// If you add a tool or a long description, move the detail to docs/tools.md first; raise the
// budget only on purpose.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const TOOLS_LIST_BUDGET_BYTES = 66_000;
const MAX_TOOL_DESCRIPTION_CHARS = 400;

describe('tools/list size budget', () => {
  it(`serialized tools/list stays under ${TOOLS_LIST_BUDGET_BYTES} bytes`, async () => {
    const { server } = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'budget', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    await client.close();

    const total = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
    const biggest = tools
      .map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t), 'utf8') }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
      .map((t) => `${t.name}=${t.bytes}`)
      .join(', ');
    expect(total, `tools/list is ${total} bytes (largest: ${biggest})`).toBeLessThanOrEqual(TOOLS_LIST_BUDGET_BYTES);
    for (const t of tools) {
      expect((t.description ?? '').length, `${t.name} description; move detail to docs/tools.md`).toBeLessThanOrEqual(
        MAX_TOOL_DESCRIPTION_CHARS,
      );
    }
  });
});
