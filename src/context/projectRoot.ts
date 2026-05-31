// Resolve the project root WITHOUT trusting the server cwd (DESIGN §2, review #1).
// Order: explicit arg → MCP roots (the proper mechanism) → needs-input.

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ResolvedRoot {
  root?: string;
  source: 'arg' | 'mcp-roots' | 'none';
  hint?: string;
}

export async function resolveProjectRoot(server: McpServer, explicit?: string): Promise<ResolvedRoot> {
  // 1) explicit arg wins (must be an absolute, existing directory)
  if (explicit && explicit.trim()) {
    const p = explicit.trim();
    if (!isAbsolute(p)) {
      return { source: 'none', hint: `projectRoot must be an absolute path, got "${p}".` };
    }
    if (existsSync(p) && statSync(p).isDirectory()) {
      return { root: p, source: 'arg' };
    }
    return { source: 'none', hint: `Path not found or not a directory: ${p}` };
  }

  // 2) MCP roots (workspace the client exposed)
  try {
    const caps = server.server.getClientCapabilities?.();
    if (caps?.roots) {
      const res = await server.server.listRoots();
      const fileRoot = res.roots?.find((r) => typeof r.uri === 'string' && r.uri.startsWith('file://'));
      if (fileRoot) {
        const p = fileURLToPath(fileRoot.uri);
        if (existsSync(p) && statSync(p).isDirectory()) {
          return { root: p, source: 'mcp-roots' };
        }
      }
    }
  } catch {
    // client doesn't support roots, or the call failed — fall through to needs-input
  }

  // 3) ask
  return {
    source: 'none',
    hint: 'No workspace root exposed by the client. Call qa_start_session with projectRoot="/absolute/path/to/app".',
  };
}
