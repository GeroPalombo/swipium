// Structured logging to STDERR only.
// CRITICAL: on the stdio transport, stdout must carry pure JSON-RPC. Anything
// written to stdout corrupts the MCP stream. All diagnostics go to stderr.
//
// SWIPIUM_LOG_LEVEL (debug | info | warn | error, default info) drops lines below the level.
// Read on every call (cheap) so a test or a long-lived process can change it at runtime.
// An unknown value falls back to info.

export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The active minimum level from SWIPIUM_LOG_LEVEL. */
export function currentLogLevel(): Level {
  const raw = process.env.SWIPIUM_LOG_LEVEL?.trim().toLowerCase();
  // Own keys only: `in` also matched inherited names (constructor, __proto__, toString), whose
  // RANK lookup is not a number, so every comparison was false and ALL logging went silent.
  return raw && Object.hasOwn(RANK, raw) ? (raw as Level) : 'info';
}

/** True when a line at `level` would be written (lets callers skip building debug metadata). */
export function logEnabled(level: Level): boolean {
  return RANK[level] >= RANK[currentLogLevel()];
}

export function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (!logEnabled(level)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ?? {}) });
  process.stderr.write(line + '\n');
}
