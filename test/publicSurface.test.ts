import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { CAPABILITY_GROUPS } from '../src/tools/capabilities.js';
import { SWIPIUM_VERSION, TOOL_COUNT, TOOL_NAMES } from '../src/version.js';

const forbiddenTools = [
  'qa_ticket_intake',
  'qa_test_ticket',
  'qa_ios_real_doctor',
  'qa_prepare_ios_real_target',
  'qa_certification',
  'qa_mobile_audit',
  'qa_appium',
  'qa_maestro_import',
  'qa_maestro_export',
  'qa_assert_ai_visual',
];

describe('public v1 tool surface', () => {
  it('exposes only the documented v1 tools', async () => {
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'surface-test', version: '0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    const listed = tools.map((tool) => tool.name).sort();
    const doctor = tools.find((tool) => tool.name === 'qa_doctor') as { inputSchema?: { properties?: Record<string, unknown> } } | undefined;
    await client.close();

    expect(SWIPIUM_VERSION).toBe('1.0.1');
    expect(TOOL_COUNT).toBe(TOOL_NAMES.length);
    expect(listed).toEqual([...TOOL_NAMES].sort());
    expect(doctor?.inputSchema?.properties?.platform).toBeTruthy();
    for (const name of forbiddenTools) expect(listed).not.toContain(name);
  });

  it('keeps qa_capabilities in lockstep with the public surface', () => {
    const grouped = CAPABILITY_GROUPS.flatMap((group) => group.tools.map((tool) => tool.name));
    expect([...grouped].sort()).toEqual([...TOOL_NAMES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
