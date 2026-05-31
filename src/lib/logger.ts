// Structured logging to STDERR only.
// CRITICAL: on the stdio transport, stdout must carry pure JSON-RPC. Anything
// written to stdout corrupts the MCP stream. All diagnostics go to stderr.

type Level = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ?? {}) });
  process.stderr.write(line + '\n');
}
