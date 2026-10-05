// Tool input schemas as Swipium serves them. Every tool is registered with a raw zod shape; the
// server turns it into ONE strict zod object (undeclared top-level keys are rejected, never
// silently stripped) that both validates tools/call arguments (src/server.ts, before the handler
// runs) and produces the advertised tools/list JSON schema. Owning both ends keeps the wire
// surface independent of SDK-version and zod-version defaults.

import { z } from 'zod';

export type ToolInputShape = z.ZodRawShape;
export type ToolInputSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;

/** The strict object for a tool's raw input shape (no shape = no parameters). */
export function strictToolSchema(shape: ToolInputShape | undefined): ToolInputSchema {
  return z.strictObject(shape ?? {});
}

type Json = Record<string, unknown>;

/** zod 4's implicit safe-integer bounds on `.int()`; they carry no information for a caller. */
const SAFE_INT_BOUNDS: ReadonlyArray<[string, number]> = [
  ['minimum', Number.MIN_SAFE_INTEGER],
  ['maximum', Number.MAX_SAFE_INTEGER],
];

/**
 * Canonical wire shape of one schema node (recursively), so tools/list stays what clients have
 * seen since 2.0 whatever zod / SDK version generates it:
 *  - an object with `properties` and no `additionalProperties` gets `additionalProperties: false`
 *    (nested objects strip undeclared keys; zod 4 only says so for strict objects);
 *  - a loose object's `additionalProperties: {}` is written `true` (records keep `{}`);
 *  - zod 4's implicit `.int()` safe-integer bounds and `propertyNames: {type:"string"}` on records
 *    (JSON keys are always strings) are dropped;
 *  - `description` is the last key (zod 4 emits it first).
 */
function canonicalNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonicalNode);
  if (!node || typeof node !== 'object') return node;
  const src = node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'description') continue;
    if (src.type === 'integer' && SAFE_INT_BOUNDS.some(([key, bound]) => k === key && v === bound)) continue;
    if (k === 'propertyNames' && isPlainObject(v) && Object.keys(v).length === 1 && v.type === 'string') continue;
    if (k === 'additionalProperties' && 'properties' in src && isPlainObject(v) && Object.keys(v).length === 0) {
      out[k] = true;
      continue;
    }
    // `properties` / `$defs` are maps of name > schema, not schema nodes themselves.
    out[k] =
      (k === 'properties' || k === '$defs' || k === 'definitions') && isPlainObject(v)
        ? Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, canonicalNode(sub)]))
        : canonicalNode(v);
  }
  if (isPlainObject(out.properties) && !('additionalProperties' in out)) out.additionalProperties = false;
  if ('description' in src) out.description = src.description;
  return out;
}

function isPlainObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** tools/list `inputSchema` for a tool: draft-07 JSON schema of the strict object (input side),
 * in canonical shape (canonicalNode) and without the per-schema `$schema` dialect key (~2.8 KB of
 * repetition across the tool list). */
export function toolInputJsonSchema(schema: ToolInputSchema): Json {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Json;
  delete json.$schema;
  return canonicalNode(json) as Json;
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

/** Type name of a received value, as the validation messages have always worded it. */
function receivedType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : 'number';
  return typeof v;
}

const quoteValue = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v));

/** Per-parse zod error map keeping the 2.x wording of the common argument errors ("uri: Required",
 * "Expected string, received number", "Invalid enum value. Expected 'a' | 'b', received 'c'"), so
 * the INVALID_ARGUMENT `what` text does not change with the zod major. Anything else keeps zod's
 * own message. */
function argumentErrorMessage(iss: z.core.$ZodRawIssue): string | undefined {
  const input = iss.input;
  switch (iss.code) {
    case 'invalid_type':
      if (input === undefined) return 'Required';
      if (iss.expected === 'int')
        return typeof input === 'number' ? 'Expected integer, received float' : `Expected number, received ${receivedType(input)}`;
      return `Expected ${iss.expected}, received ${receivedType(input)}`;
    case 'invalid_value':
      if (iss.inst instanceof z.ZodEnum)
        return `Invalid enum value. Expected ${iss.values.map(quoteValue).join(' | ')}, received ${quoteValue(input)}`;
      if (iss.inst instanceof z.ZodLiteral && iss.values.length === 1)
        return `Invalid literal value, expected ${JSON.stringify(iss.values[0])}`;
      return undefined;
    case 'too_small':
    case 'too_big': {
      const small = iss.code === 'too_small';
      const bound = small ? iss.minimum : iss.maximum;
      const inclusive = iss.inclusive !== false;
      if (iss.origin === 'number') return `Number must be ${small ? 'greater' : 'less'} than ${inclusive ? `or equal to ${bound}` : bound}`;
      if (iss.origin === 'string') return `String must contain ${small ? 'at least' : 'at most'} ${bound} character(s)`;
      if (iss.origin === 'array') return `Array must contain ${small ? 'at least' : 'at most'} ${bound} element(s)`;
      return undefined;
    }
    default:
      return undefined;
  }
}

export type ToolArgsCheck = { ok: true; data: Record<string, unknown> } | { ok: false; issues: ToolArgIssue[]; total: number };

/** Validate a tools/call `arguments` object against the tool's strict schema. Issues are capped
 * (count, path and message length) because they echo caller input. */
export function checkToolArgs(schema: ToolInputSchema, args: unknown): ToolArgsCheck {
  const parsed = schema.safeParse(args ?? {}, { error: argumentErrorMessage });
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  const all = parsed.error.issues;
  const issues = all
    .slice(0, MAX_ECHOED_KEYS)
    .map((i) => ({ path: echoKey(issuePath(i.path)), message: capIssueMessage(String(i.message)) }));
  return { ok: false, issues, total: all.length };
}
