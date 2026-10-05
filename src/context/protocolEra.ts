// Which MCP protocol era an McpServer instance serves. Under serveStdio (src/server.ts) the era is
// fixed per instance when it is built: 'legacy' (2025-06-18 / 2025-11-25, `initialize` handshake)
// or 'modern' (2026-07-28, `server/discover` + per-request `_meta`). Modern instances have no
// server-to-client requests (roots/list, elicitation/create, sampling throw there), so the code
// that would send one asks here first. Keyed by object identity so tests can hand in fakes.

const modernServers = new WeakSet<object>();

/** Mark `server` (an McpServer, or anything standing in for one) as serving protocol 2026-07-28. */
export function markModernServer(server: object): void {
  modernServers.add(server);
}

/** True when `server` serves protocol 2026-07-28 (no server-to-client requests available). */
export function servesModernEra(server: object | undefined): boolean {
  return server !== undefined && server !== null && modernServers.has(server);
}
