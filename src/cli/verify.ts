// `swipium verify`: programmatic proxy for "does the server start and do its tools
// inject?". Spawns dist/index.js as a stdio MCP server via the SDK client, lists tools,
// asserts the full Phase-0 surface is present, and calls qa_doctor. This is the same
// JSON-RPC path the real clients use. It's the closest automatable check to the in-client test.

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { TOOL_NAMES, PROMPT_NAMES } from '../version.js';
import { VERIFY_CHILD_FLAG } from './main.js';

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

const EXPECTED = [...TOOL_NAMES];

export const VERIFY_USAGE = `Usage: swipium verify
  Start the server over stdio (as an MCP client would), list its tools and prompts, and run qa_doctor.
  Exit status: 0 OK, 1 the server did not start, tools are missing, qa_doctor errored, or the
  Node.js runtime is unsupported (failed qa_doctor checks are listed either way).
`;

interface DoctorCheck {
  name?: string;
  ok?: boolean;
  optional?: boolean;
  detail?: string;
  fix?: string;
}

export async function runVerify(args: string[] = []): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(VERIFY_USAGE);
    return;
  }
  if (args.length) {
    process.stderr.write(`swipium verify: unknown option ${args[0]}\n\n${VERIFY_USAGE}`);
    process.exitCode = 2;
    return;
  }
  // VERIFY_CHILD_FLAG: this throwaway server skips the orphan adopt / reap sweep.
  const transport = new StdioClientTransport({ command: process.execPath, args: [SELF, VERIFY_CHILD_FLAG] });
  const client = new Client({ name: 'swipium-verify', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const missing = EXPECTED.filter((t) => !names.includes(t));

    // Prompts are the third MCP capability, so confirm they inject too (best-effort: a client
    // that doesn't support prompts will throw, which we tolerate).
    let promptNames: string[] = [];
    try {
      const { prompts } = await client.listPrompts();
      promptNames = prompts.map((p) => p.name);
    } catch {
      /* prompts unsupported by this transport/client: not fatal */
    }
    const missingPrompts = [...PROMPT_NAMES].filter((p) => !promptNames.includes(p));

    let doctorRan = false;
    let schemaHash = 'unknown';
    let doctorReady: boolean | undefined;
    let failedChecks: DoctorCheck[] = [];
    try {
      const d = await client.callTool({ name: 'qa_doctor', arguments: {} });
      doctorRan = !d.isError;
      const sc = d.structuredContent as { schemaHash?: string; ready?: boolean; checks?: DoctorCheck[] } | undefined;
      if (sc?.schemaHash) schemaHash = sc.schemaHash;
      doctorReady = sc?.ready;
      failedChecks = (sc?.checks ?? []).filter((c) => c && c.ok === false && !c.optional);
    } catch {
      /* doctor failure is reported below */
    }
    await client.close();

    if (missing.length) {
      console.log(`❌ verify FAILED: missing tools: ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    // An unsupported Node runtime (node check fails) is a verify failure, not a ✅; other
    // failed required doctor checks (adb, xcodebuild, devices…) are listed as warnings.
    const nodeFailed = failedChecks.some((c) => c.name === 'node');
    const ok = doctorRan && !nodeFailed;
    console.log(
      `${ok ? (failedChecks.length || doctorReady === false ? '⚠ verify OK with warnings' : '✅ verify OK') : '❌ verify FAILED'}: server starts, ${names.length} tools inject (all ${EXPECTED.length} expected present), schema ${schemaHash}, qa_doctor ${doctorRan ? 'ran' : 'ERRORED'}${doctorReady === false ? ' (environment NOT ready)' : ''}.`,
    );
    for (const c of failedChecks) console.log(`  [fail] ${c.name}: ${c.detail ?? ''}${c.fix ? ` -> ${c.fix}` : ''}`);
    console.log(`tools: ${names.join(', ')}`);
    console.log(
      missingPrompts.length
        ? `⚠ prompts: ${promptNames.length}/${PROMPT_NAMES.length} present (missing: ${missingPrompts.join(', ')})`
        : `prompts: all ${PROMPT_NAMES.length} present (${promptNames.join(', ')})`,
    );
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.log(`❌ verify FAILED: could not start/inspect the server: ${String(e)}`);
    process.exitCode = 1;
  }
}
