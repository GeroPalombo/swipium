import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

// Tool metadata lint (roadmap "Security And Trust Requirements / Add"). The MCP spec warns that
// tool descriptions are themselves an attack surface: clients may act on them, so they must be
// honest, non-manipulative, and well-formed. This test introspects the live tool surface.

// Phrases that would indicate a description trying to steer the agent rather than describe the tool.
const MANIPULATIVE = [
  'ignore previous',
  'ignore all previous',
  'disregard',
  'do not tell',
  "don't tell",
  'without telling',
  'system prompt',
  'as an ai',
];

describe('tool metadata lint', () => {
  it('every public tool has honest, well-formed metadata', async () => {
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'metadata-lint', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    await client.close();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      // Naming convention.
      expect(tool.name, `${tool.name} name`).toMatch(/^qa_[a-z_]+$/);
      // A real, descriptive description.
      const desc = (tool.description ?? '').trim();
      expect(desc.length, `${tool.name} description length`).toBeGreaterThanOrEqual(20);
      // No prompt-injection / manipulation in the description an agent may act on.
      const lower = desc.toLowerCase();
      for (const phrase of MANIPULATIVE) {
        expect(lower.includes(phrase), `${tool.name} contains manipulative phrase "${phrase}"`).toBe(false);
      }
      // A declared input schema (object) so clients can validate arguments.
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
      expect(tool.inputSchema?.type, `${tool.name} inputSchema.type`).toBe('object');
    }
  });
});
