// Tool input schemas as Swipium serves them. Every tool is registered with a raw zod shape; the
// server turns it into ONE strict zod object (undeclared top-level keys are rejected, never
// silently stripped) that both validates tools/call arguments (src/server.ts, before the handler
// runs) and produces the advertised tools/list JSON schema. Owning both ends keeps the wire
// surface independent of SDK-version defaults.

import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

export type ToolInputShape = z.ZodRawShape;
export type ToolInputSchema = z.ZodObject<z.ZodRawShape, 'strict'>;

/** The strict object for a tool's raw input shape (no shape = no parameters). */
export function strictToolSchema(shape: ToolInputShape | undefined): ToolInputSchema {
  return z.object(shape ?? {}).strict();
}

/** tools/list `inputSchema` for a tool: JSON schema of the strict object, without the per-schema
 * `$schema` dialect key (~2.8 KB of repetition across the tool list). */
export function toolInputJsonSchema(schema: ToolInputSchema): Record<string, unknown> {
  const json = toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' });
  delete json.$schema;
  return json;
}

export interface ToolArgIssue {
  path: string;
  message: string;
}

/** Longest argument key name / validation path echoed back in an error (a key name is caller input). */
export const MAX_ECHOED_KEY_CHARS = 100;
/** Most unknown keys / validation issues listed individually in an error. */
export const MAX_ECHOED_KEYS = 20;

export function echoKey(k: string): string {
  return k.length > MAX_ECHOED_KEY_CHARS ? `${k.slice(0, MAX_ECHOED_KEY_CHARS)}...[${k.length} chars]` : k;
}

/** A zod message can quote caller input (record keys, unrecognized keys). */
function capIssueMessage(m: string): string {
  return m.length > 300 ? `${m.slice(0, 300)}...` : m;
}

/** Dotted path with array indexes in brackets (`steps[0].text`); '(arguments)' for the root. */
function issuePath(path: ReadonlyArray<PropertyKey>): string {
  if (!path.length) return '(arguments)';
  return path.reduce<string>(
    (acc, seg, i) => (typeof seg === 'number' ? `${acc}[${seg}]` : i === 0 ? String(seg) : `${acc}.${String(seg)}`),
    '',
  );
}

export type ToolArgsCheck = { ok: true; data: Record<string, unknown> } | { ok: false; issues: ToolArgIssue[]; total: number };

/** Validate a tools/call `arguments` object against the tool's strict schema. Issues are capped
 * (count, path and message length) because they echo caller input. */
export function checkToolArgs(schema: ToolInputSchema, args: unknown): ToolArgsCheck {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  const all = parsed.error.issues;
  const issues = all
    .slice(0, MAX_ECHOED_KEYS)
    .map((i) => ({ path: echoKey(issuePath(i.path)), message: capIssueMessage(String(i.message)) }));
  return { ok: false, issues, total: all.length };
}
