#!/usr/bin/env node
// Entry point. No subcommand (or `serve`) = run as the stdio MCP server. Subcommands are CLI
// helpers (init/scan/suite/verify/report); --help/--version print and exit; anything else is an
// error (exit 2) rather than a silently hanging stdio server. See src/cli/main.ts.

import module from 'node:module';
import { parseCommand, USAGE } from './cli/main.js';
import { SWIPIUM_VERSION } from './version.js';
import { log } from './lib/logger.js';

// Node's on-disk compile cache (Node >= 22.1) speeds up every later start, in particular the
// server module graph loaded below with import(); a no-op where unsupported.
try {
  module.enableCompileCache?.();
} catch {
  // best-effort
}

async function main(): Promise<void> {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${SWIPIUM_VERSION}\n`);
    return;
  }
  if (parsed.kind === 'unknown') {
    process.stderr.write(`swipium: unknown command "${parsed.cmd}"\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.kind === 'serve') {
    // startServer() puts the Android SDK tools on PATH (GUI MCP clients don't inherit the shell PATH).
    const { startServer } = await import('./server.js');
    await startServer();
    return;
  }

  const { cmd, rest } = parsed;
  if (cmd === 'init') {
    const { runInit } = await import('./cli/init.js');
    await runInit(rest);
    return;
  }
  if (cmd === 'scan') {
    const { runScan } = await import('./cli/scan.js');
    await runScan(rest);
    return;
  }
  if (cmd === 'suite') {
    const { runSuite } = await import('./cli/suite.js');
    await runSuite(rest);
    return;
  }
  if (cmd === 'verify') {
    const { runVerify } = await import('./cli/verify.js');
    await runVerify();
    return;
  }
  if (cmd === 'report') {
    const { runReport } = await import('./cli/report.js');
    process.exitCode = await runReport(rest);
    return;
  }
  if (cmd === 'gc') {
    const { runGc } = await import('./cli/gc.js');
    process.exitCode = await runGc(rest);
    return;
  }
}

main().catch((err) => {
  log('error', 'fatal', { err: String(err?.stack ?? err) });
  process.exit(1);
});
