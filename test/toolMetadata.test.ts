import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { SERVER_INSTRUCTIONS } from '../src/tools/agent.js';

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

// Internal planning labels must never leak into agent-visible text.
const INTERNAL_LABEL = /\b(SWIP-\d+|SWIPIUM-REQ-\d+|OPP-\d+|REQ-\d+|PHASE\d|Phase \d|DESIGN §)/;

/** Tools that must advertise readOnlyHint:true (each handler was reviewed: no device/app/project
 * mutation — see the classification table in src/lib/toolAnnotations.ts). */
const READ_ONLY = [
  'qa_status',
  'qa_job_status',
  'qa_explain_blocker',
  'qa_get_artifact',
  'qa_doctor',
  'qa_resolve_target',
  'qa_resolve_artifact',
  'qa_device_info',
  'qa_snapshot',
  'qa_inspect',
  'qa_check_health',
  'qa_wait',
  'qa_app_map_read',
  'qa_app_map_query',
  'qa_app_map_feature_scope',
  'qa_suite_read',
  'qa_suite_lint',
  'qa_flow_check',
];
/** Tools whose purpose includes wiping/overwriting user-visible state. */
const DESTRUCTIVE = ['qa_app_control', 'qa_ios', 'qa_suite_update', 'qa_app_map_update'];
/** Spot-check: these mutate (device, evidence, or project files) and must never claim read-only. */
const MUTATING = ['qa_act', 'qa_screenshot', 'qa_visual', 'qa_report', 'qa_generate', 'qa_issue_log', 'qa_test_this', 'qa_build'];

describe('tool metadata lint', () => {
  it('every public tool has honest, well-formed metadata', async () => {
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'metadata-lint', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    const instructions = client.getInstructions();
    await client.close();

    expect(tools.length).toBeGreaterThan(0);
    // Server instructions: present, concise, and pointing at the real first call + polling tool.
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions!.length).toBeLessThanOrEqual(2000);
    expect(instructions).toContain('qa_test_this');
    expect(instructions).toContain('qa_job_status');
    expect(INTERNAL_LABEL.test(instructions!)).toBe(false);
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
      // No internal planning labels anywhere agent-visible (description or any param description).
      const visible = JSON.stringify({ d: tool.description, s: tool.inputSchema });
      expect(visible.match(INTERNAL_LABEL)?.[0], `${tool.name} leaks an internal label`).toBeUndefined();
    }
  });

  it('every tool carries MCP annotations (local-only, reviewed read-only/destructive hints)', async () => {
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'annotation-lint', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    await client.close();

    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const tool of tools) {
      const a = tool.annotations;
      expect(a, `${tool.name} has no annotations`).toBeTruthy();
      expect(a!.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
      expect(typeof a!.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
      if (!a!.readOnlyHint) {
        // Spec defaults are destructive + non-idempotent — mutating tools must say so explicitly.
        expect(typeof a!.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean');
        expect(typeof a!.idempotentHint, `${tool.name} idempotentHint`).toBe('boolean');
      }
      expect(tool.title, `${tool.name} title`).toBeTruthy();
    }
    for (const name of READ_ONLY) expect(byName.get(name)?.annotations?.readOnlyHint, `${name} should be read-only`).toBe(true);
    for (const name of DESTRUCTIVE) expect(byName.get(name)?.annotations?.destructiveHint, `${name} should be destructive`).toBe(true);
    for (const name of MUTATING) expect(byName.get(name)?.annotations?.readOnlyHint, `${name} must not be read-only`).toBe(false);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual([...DESTRUCTIVE].sort());
  });
});
