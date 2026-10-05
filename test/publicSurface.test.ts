import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { CAPABILITY_GROUPS } from '../src/core/capabilityGroups.js';
import { REMOVED_TOOLS, STALE_CLIENT_HINT, SWIPIUM_VERSION, TOOL_COUNT, TOOL_NAMES } from '../src/version.js';

const forbiddenTools = [
  'qa_ticket_intake',
  'qa_test_ticket',
  'qa_ios_real_doctor',
  'qa_prepare_ios_real_target',
  'qa_certification',
  'qa_appium',
  'qa_automation_run',
  'qa_device_matrix',
  'qa_run_matrix',
  'qa_ci',
  'qa_assert_ai_visual',
  // Deleted dead modules: report history, state profiles, automation validate.
  'qa_report_compare',
  'qa_report_trend',
  'qa_state_prepare',
  'qa_state_verify',
  'qa_state_teardown',
  'qa_automation_validate',
  // Deferred pre-1.5.0 surface (src/tools/deferred/, kept for potential revival).
  'qa_screen_info',
  'qa_permissions',
  'qa_seed',
  'qa_locator_suggest',
  // Folded into qa_visual mode:"find_text".
  'qa_visual_find_text',
  // Consolidated in 1.6.0 (see REMOVED_TOOLS for the replacement of each).
  ...Object.keys(REMOVED_TOOLS),
];

describe('public tool surface', () => {
  it('exposes only the documented tools', async () => {
    const { server } = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'surface-test', version: '0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    const listed = tools.map((tool) => tool.name).sort();
    const doctor = tools.find((tool) => tool.name === 'qa_doctor') as
      { inputSchema?: { properties?: Record<string, unknown> } } | undefined;
    await client.close();

    expect(SWIPIUM_VERSION).toBe('2.1.2');
    expect(TOOL_COUNT).toBe(TOOL_NAMES.length);
    expect(listed).toEqual([...TOOL_NAMES].sort());
    expect(doctor?.inputSchema?.properties?.platform).toBeTruthy();
    for (const name of forbiddenTools) expect(listed).not.toContain(name);
  });

  it('keeps CAPABILITY_GROUPS (qa_status orientation) in lockstep with the public surface', () => {
    const grouped = CAPABILITY_GROUPS.flatMap((group) => group.tools);
    expect([...grouped].sort()).toEqual([...TOOL_NAMES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('the stale-client hint names every removed tool', () => {
    for (const name of Object.keys(REMOVED_TOOLS)) expect(STALE_CLIENT_HINT).toContain(name);
  });

  // docs/tools.md is the human-facing contract: exactly one table row per public tool, no row for a
  // removed tool, and the stated count matches TOOL_COUNT.
  it('docs/tools.md documents exactly the public surface', () => {
    const full = readFileSync(join(import.meta.dirname, '..', 'docs', 'tools.md'), 'utf8');
    // The migration table legitimately names removed tools; everything above it is the live surface.
    const doc = full.slice(0, full.indexOf('## Migrating from'));
    expect(full).toContain('## Migrating from');
    const rows = [...doc.matchAll(/^\| `(qa_[a-z_]+)` \|/gm)].map((m) => m[1]);
    expect([...rows].sort()).toEqual([...TOOL_NAMES].sort());
    expect(new Set(rows).size).toBe(rows.length);
    expect(doc).toContain(`exposes ${TOOL_COUNT} public MCP tools`);
    const migration = full.slice(full.indexOf('## Migrating from'));
    for (const removed of Object.keys(REMOVED_TOOLS)) {
      expect(rows).not.toContain(removed);
      expect(migration, `migration table must cover ${removed}`).toContain(`\`${removed}`);
    }
  });

  // Dead-module gate: a module directly under src/tools/ that server.ts never
  // imports registers nothing yet still ships in dist/ — exactly the rot this repo already
  // accumulated once. Every .ts file directly under src/tools/ (non-recursive; deferred/
  // is the sanctioned parking lot and excluded from the build) must be imported by server.ts.
  it('every module directly under src/tools/ is imported by server.ts', () => {
    const root = join(import.meta.dirname, '..');
    const serverSource = readFileSync(join(root, 'src', 'server.ts'), 'utf8');
    const imported = new Set([...serverSource.matchAll(/from '\.\/tools\/([\w-]+)\.js'/g)].map((m) => m[1]));
    const modules = readdirSync(join(root, 'src', 'tools'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name.replace(/\.ts$/, ''));
    expect(modules.length).toBeGreaterThan(0);
    const orphans = modules.filter((m) => !imported.has(m));
    expect(
      orphans,
      `src/tools/ modules not imported by server.ts — delete them or move them to src/tools/deferred/: ${orphans.join(', ')}`,
    ).toEqual([]);
  });
});
