// Schema-hash freshness (Phase 3.3 Milestone A). A version bump tells a HUMAN the server changed,
// but a client running a pre-upgrade build with the same tool COUNT can still look fresh after a
// behavior/schema/description change (the 3.2.1 problem). The schema hash is a content fingerprint
// of the registered tool surface (names + descriptions + input-parameter keys), so an agent/client
// can detect "same count, different surface" and know to restart.

import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface ToolSurfaceEntry {
  name: string;
  description: string;
  inputKeys: string[];
}

/** Deterministic hash of the tool surface (order-independent). */
export function computeSchemaHash(entries: ToolSurfaceEntry[]): string {
  const normalized = entries
    .map((e) => ({ name: e.name, description: e.description, inputKeys: [...e.inputKeys].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

/**
 * Best-effort normalized descriptor of a single zod input field (Phase 3.3 §5 deeper hash). Encodes
 * the type, enum options, optionality, and array/record element types so a NESTED change (e.g. a new
 * enum value or a string>number switch) shifts the hash even when the field name is unchanged.
 * Uses zod 4's public schema classes and accessors only; the descriptor strings are the ones zod 3
 * produced, so the hash did not move with the zod major. Falls back to 'field' on any surprise.
 * The hash stays stable, never throws.
 */
export function describeZodField(schema: unknown, depth = 0): string {
  if (depth > 4 || !(schema instanceof z.ZodType)) return 'field';
  try {
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return `${describeZodField(schema.unwrap(), depth + 1)}?`;
    if (schema instanceof z.ZodDefault) return `${describeZodField(schema.removeDefault(), depth + 1)}=def`;
    if (schema instanceof z.ZodEnum) return `enum(${schema.options.map(String).sort().join('|')})`;
    if (schema instanceof z.ZodArray) return `array<${describeZodField(schema.element, depth + 1)}>`;
    if (schema instanceof z.ZodRecord) return `record<${describeZodField(schema.valueType, depth + 1)}>`;
    if (schema instanceof z.ZodUnion) return `union(${schema.options.map((o: unknown) => describeZodField(o, depth + 1)).join('|')})`;
    if (schema instanceof z.ZodObject) return `obj{${Object.keys(schema.shape).sort().join(',')}}`;
    return String(schema.type).toLowerCase() || 'field';
  } catch {
    return 'field';
  }
}

let _hash: string | undefined;

/** Set once after the server registers all tools. */
export function setSchemaHash(hash: string): void {
  _hash = hash;
}

/** The current tool-surface hash, or 'unknown' if the server has not been built yet. */
export function getSchemaHash(): string {
  return _hash ?? 'unknown';
}
