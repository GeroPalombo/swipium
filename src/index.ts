#!/usr/bin/env node
// Entry point. Default = run as the stdio MCP server. `init <client>` = setup helper.

import { startServer } from './server.js';
import { runInit } from './cli/init.js';
import { runVerify } from './cli/verify.js';
import { runScan } from './cli/scan.js';
import { runSuite } from './cli/suite.js';
import { log } from './lib/logger.js';

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'init') {
    await runInit(rest);
    return;
  }
  if (cmd === 'scan') {
    await runScan(rest);
    return;
  }
  if (cmd === 'suite') {
    await runSuite(rest);
    return;
  }
  if (cmd === 'verify') {
    await runVerify();
    return;
  }
  await startServer();
}

main().catch((err) => {
  log('error', 'fatal', { err: String(err?.stack ?? err) });
  process.exit(1);
});
