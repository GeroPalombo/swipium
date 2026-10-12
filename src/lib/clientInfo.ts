import type { Implementation, McpServer } from '@modelcontextprotocol/server';

/** Client identity seen on per-request `_meta` (protocol 2026-07-28 connections carry no
 * `initialize`, and the stdio entry does not backfill getClientVersion()). */
const requestClientInfo = new WeakMap<McpServer, Implementation>();

export function rememberClientInfo(server: McpServer, info: Implementation): void {
  requestClientInfo.set(server, info);
}

/** The connected client's name/version: the `initialize` clientInfo (2025 era), else the
 * clientInfo of the latest 2026-07-28 request. Used by qa_doctor and tests. */
export function clientInfoOf(server: McpServer): Implementation | undefined {
  return server.server.getClientVersion() ?? requestClientInfo.get(server);
}
