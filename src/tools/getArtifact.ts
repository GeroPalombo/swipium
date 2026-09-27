// qa_get_artifact — portable fallback for clients without MCP resource support.
// To protect the context budget (review #7), images default to METADATA (uri/mime/size);
// fetch pixels explicitly with mode:"inline". Text defaults to inline.

import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError } from '../lib/result.js';
import type { SessionStore } from '../session/store.js';

/** Images → metadata by default (large); text → inline. Explicit mode always wins. */
export function chooseMode(mime: string, mode?: 'metadata' | 'inline'): 'metadata' | 'inline' {
  return mode ?? (mime.startsWith('image/') ? 'metadata' : 'inline');
}

export function registerGetArtifact(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_get_artifact',
    {
      title: 'Get an artifact',
      description:
        'Fetch a session artifact by swipium://session/<id>/<kind>/<name> URI (screenshots, reports, dumps, logs) when the ' +
        'client lacks MCP resources. Images return metadata by default; mode:"inline" returns the pixels.',
      inputSchema: { uri: z.string(), mode: z.enum(['metadata', 'inline']).optional() },
    },
    async ({ uri, mode }): Promise<CallToolResult> => {
      const found = sessions.findArtifact(uri);
      if (!found) {
        return qaError({
          what: `Unknown artifact ${uri}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['List artifacts via qa_report, or check the URI.'],
        });
      }
      const { rec } = found;
      const resolved = chooseMode(rec.mime, mode);
      const partialNote =
        rec.redaction === 'partial' ? `\n⚠ redaction partial: ${rec.redactionNote ?? 'some secret values were not redacted.'}` : '';
      try {
        if (resolved === 'metadata') {
          const bytes = statSync(rec.path).size;
          const meta = {
            uri: rec.uri,
            mime: rec.mime,
            kind: rec.kind,
            bytes,
            path: rec.path,
            redaction: rec.redaction ?? null,
            ...(rec.redactionNote ? { redactionNote: rec.redactionNote } : {}),
            hint: rec.mime.startsWith('image/') ? 'pass mode:"inline" to fetch the image bytes' : 'pass mode:"inline" to fetch contents',
          };
          return {
            content: [{ type: 'text', text: `${rec.uri}${partialNote}\n${JSON.stringify(meta, null, 2)}` }],
            structuredContent: meta,
          };
        }
        if (rec.mime.startsWith('image/')) {
          return { content: [{ type: 'image', data: readFileSync(rec.path).toString('base64'), mimeType: rec.mime }] };
        }
        const text = readFileSync(rec.path, 'utf8');
        // Partial redaction (very short secrets left unscrubbed): the caveat travels with the
        // content as a separate block so the artifact text itself stays byte-exact.
        return {
          content: [{ type: 'text', text }, ...(partialNote ? [{ type: 'text' as const, text: partialNote.trim() }] : [])],
        };
      } catch (e) {
        return qaError({
          what: `Could not read artifact: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['The file may have been cleaned up.'],
        });
      }
    },
  );
}
