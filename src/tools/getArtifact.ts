// qa_get_artifact: portable fallback for clients without MCP resource support.
// To protect the context budget (review #7), images and other binaries (recordings) default to
// METADATA (uri/mime/size/path); fetch bytes explicitly with mode:"inline". Text defaults to inline.
// Both this tool and resources/read apply the same size caps (head, or tail for logs, + marker).

import { z } from 'zod';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { McpServer, CallToolResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { qaError } from '../lib/result.js';
import type { ArtifactRecord, SessionStore } from '../session/store.js';

/** resources/read size caps. Binary (images, recordings) over the cap is not inlined at all
 * (base64 would be ~1.33x on top); text over the cap returns the head (or the tail, for logs)
 * with a marker. qa_get_artifact { mode:"metadata" } still reports the size and local path. */
export const RESOURCE_BINARY_MAX_BYTES = 8 * 1024 * 1024;
export const RESOURCE_TEXT_MAX_BYTES = 1024 * 1024;

/** Text-like mimes are returned as `text`; everything else as a base64 `blob`. */
export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || /json|xml|yaml|javascript|csv|svg/.test(mime);
}

function readSlice(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Byte length of the UTF-8 sequence a lead byte starts (1 for ASCII or a stray byte). */
function utf8SeqLen(lead: number): number {
  if (lead >= 0xf0 && lead <= 0xf7) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

/** Drop a multibyte character cut in half at the END of a head slice. Exported for tests. */
export function trimUtf8End(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0 || buf[i] < 0x80) return buf;
  return i + utf8SeqLen(buf[i]) > buf.length ? buf.subarray(0, i) : buf;
}

/** Skip continuation bytes (0x80-0xBF) at the START of a tail slice. Exported for tests. */
export function trimUtf8Start(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && i < 3 && (buf[i] & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

/** Logs keep the TAIL when capped (the end is where failures are): log kinds (logcat, wda-log,
 * build-log...) and any *.log file (Metro / WDA start logs are stored with kind metro / wda). */
export function isLogArtifact(rec: Pick<ArtifactRecord, 'path' | 'kind'>): boolean {
  return /log/i.test(rec.kind) || /\.log$/i.test(rec.path);
}

/** A text artifact capped at `textMax` bytes: the whole file when it fits, otherwise the head
 * (or the tail, for logs) cut on a UTF-8 character boundary, plus a marker naming the local file. */
export function readCappedText(
  rec: Pick<ArtifactRecord, 'path' | 'kind'>,
  textMax: number,
  via: 'resources/read' | 'qa_get_artifact',
): { text: string; truncated: boolean; bytes: number } {
  const size = statSync(rec.path).size;
  if (size <= textMax) return { text: readFileSync(rec.path, 'utf8'), truncated: false, bytes: size };
  const tail = isLogArtifact(rec);
  const raw = readSlice(rec.path, tail ? size - textMax : 0, textMax);
  const body = (tail ? trimUtf8Start(raw) : trimUtf8End(raw)).toString('utf8');
  const marker =
    `[swipium: truncated, showing the ${tail ? 'last' : 'first'} ${textMax} of ${size} bytes (${via} cap; ` +
    `resources/read and qa_get_artifact apply the same cap). Read the local file for the rest: ${rec.path}]`;
  return { text: tail ? `${marker}\n${body}` : `${body}\n${marker}`, truncated: true, bytes: size };
}

/**
 * Contents for resources/read of an artifact, size-capped (the old handler base64'd or inlined
 * the whole file, however big). Logs keep the TAIL (the end is where failures are), everything
 * else the HEAD. Exported for tests (limits are injectable).
 */
export function readArtifactResource(
  href: string,
  rec: Pick<ArtifactRecord, 'path' | 'mime' | 'kind'>,
  limits: { binaryMax?: number; textMax?: number } = {},
): ReadResourceResult {
  const binaryMax = limits.binaryMax ?? RESOURCE_BINARY_MAX_BYTES;
  const textMax = limits.textMax ?? RESOURCE_TEXT_MAX_BYTES;
  if (!isTextMime(rec.mime)) {
    const size = statSync(rec.path).size;
    if (size <= binaryMax) return { contents: [{ uri: href, mimeType: rec.mime, blob: readFileSync(rec.path).toString('base64') }] };
    return { contents: [{ uri: href, mimeType: 'text/plain', text: binaryOverCapNote(href, rec, size, binaryMax, 'resources/read') }] };
  }
  return { contents: [{ uri: href, mimeType: rec.mime, text: readCappedText(rec, textMax, 'resources/read').text }] };
}

function binaryOverCapNote(
  href: string,
  rec: Pick<ArtifactRecord, 'path' | 'mime'>,
  size: number,
  binaryMax: number,
  via: 'resources/read' | 'qa_get_artifact',
): string {
  return (
    `[swipium: ${rec.mime} artifact is ${size} bytes, over the ${binaryMax}-byte ${via} cap, so it is not inlined. ` +
    `Local file: ${rec.path}. qa_get_artifact { uri: "${href}", mode: "metadata" } reports size and path.]`
  );
}

/** Text defaults to inline; images and every other non-text mime (video/mp4 recordings, zips)
 * default to metadata. Explicit mode always wins. */
export function chooseMode(mime: string, mode?: 'metadata' | 'inline'): 'metadata' | 'inline' {
  return mode ?? (isTextMime(mime) ? 'inline' : 'metadata');
}

export function registerGetArtifact(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_get_artifact',
    {
      title: 'Get an artifact',
      description:
        'Fetch a session artifact by swipium://session/<id>/<kind>/<name> URI (screenshots, reports, dumps, logs) when the ' +
        'client lacks MCP resources. Text is inline (over 1 MB: the head, or the tail for logs). Images and other ' +
        'binaries (recordings) return metadata by default; mode:"inline" returns the bytes.',
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
            hint: rec.mime.startsWith('image/')
              ? 'pass mode:"inline" to fetch the image bytes'
              : isTextMime(rec.mime)
                ? 'pass mode:"inline" to fetch contents'
                : `binary (${rec.mime}): open the local path; mode:"inline" returns it base64 up to ${RESOURCE_BINARY_MAX_BYTES} bytes`,
          };
          return {
            content: [{ type: 'text', text: `${rec.uri}${partialNote}\n${JSON.stringify(meta, null, 2)}` }],
            structuredContent: meta,
          };
        }
        if (!isTextMime(rec.mime)) {
          const size = statSync(rec.path).size;
          if (size > RESOURCE_BINARY_MAX_BYTES)
            return {
              content: [{ type: 'text', text: binaryOverCapNote(rec.uri, rec, size, RESOURCE_BINARY_MAX_BYTES, 'qa_get_artifact') }],
            };
          const data = readFileSync(rec.path).toString('base64');
          if (rec.mime.startsWith('image/')) return { content: [{ type: 'image', data, mimeType: rec.mime }] };
          // Not an image (video/mp4, zip...): an embedded blob resource, never a UTF-8 decode of the bytes.
          return { content: [{ type: 'resource', resource: { uri: rec.uri, mimeType: rec.mime, blob: data } }] };
        }
        const { text } = readCappedText(rec, RESOURCE_TEXT_MAX_BYTES, 'qa_get_artifact');
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
