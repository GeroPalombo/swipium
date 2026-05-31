// `swipium verify` — programmatic proxy for "does the server start and do its tools
// inject?". Spawns dist/index.js as a stdio MCP server via the SDK client, lists tools,
// asserts the full Phase-0 surface is present, and calls qa_doctor. This is the same
// JSON-RPC path the real clients use — the closest automatable check to the in-client test.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { TOOL_NAMES, PROMPT_NAMES } from '../version.js';

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

const EXPECTED = [...TOOL_NAMES];

export async function runVerify(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SELF] });
  const client = new Client({ name: 'swipium-verify', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const missing = EXPECTED.filter((t) => !names.includes(t));

    // Prompts are the third MCP capability — confirm they inject too (best-effort: a client
    // that doesn't support prompts will throw, which we tolerate).
    let promptNames: string[] = [];
    try {
      const { prompts } = await client.listPrompts();
      promptNames = prompts.map((p) => p.name);
    } catch {
      /* prompts unsupported by this transport/client — not fatal */
    }
    const missingPrompts = [...PROMPT_NAMES].filter((p) => !promptNames.includes(p));

    let doctorRan = false;
    let schemaHash = 'unknown';
    try {
      const d = await client.callTool({ name: 'qa_doctor', arguments: {} });
      doctorRan = !d.isError;
      const sc = d.structuredContent as { schemaHash?: string } | undefined;
      if (sc?.schemaHash) schemaHash = sc.schemaHash;
    } catch {
      /* doctor failure is reported below */
    }
    await client.close();

    if (missing.length) {
      console.log(`❌ verify FAILED — missing tools: ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ verify OK — server starts, ${names.length} tools inject (all ${EXPECTED.length} expected present), schema ${schemaHash}, qa_doctor ${doctorRan ? 'ran' : 'ERRORED'}.`);
    console.log(`tools: ${names.join(', ')}`);
    console.log(
      missingPrompts.length
        ? `⚠ prompts: ${promptNames.length}/${PROMPT_NAMES.length} present (missing: ${missingPrompts.join(', ')})`
        : `prompts: all ${PROMPT_NAMES.length} present (${promptNames.join(', ')})`,
    );
    if (!doctorRan) process.exitCode = 1;
  } catch (e) {
    console.log(`❌ verify FAILED — could not start/inspect the server: ${String(e)}`);
    process.exitCode = 1;
  }
}
