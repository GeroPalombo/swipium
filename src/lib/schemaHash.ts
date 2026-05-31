// Schema-hash freshness (Phase 3.3 Milestone A). A version bump tells a HUMAN the server changed,
// but a client running a pre-upgrade build with the same tool COUNT can still look fresh after a
// behavior/schema/description change (the 3.2.1 problem). The schema hash is a content fingerprint
// of the registered tool surface — names + descriptions + input-parameter keys — so an agent/client
// can detect "same count, different surface" and know to restart.

import { createHash } from 'node:crypto';

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
 * enum value or a string→number switch) shifts the hash even when the field name is unchanged.
 * Falls back to 'field' on any introspection surprise — the hash stays stable, never throws.
 */
export function describeZodField(schema: unknown, depth = 0): string {
  if (depth > 4 || !schema || typeof schema !== 'object') return 'field';
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return 'field';
  const typeName = String(def.typeName ?? '');
  try {
    switch (typeName) {
      case 'ZodOptional':
      case 'ZodNullable':
        return `${describeZodField(def.innerType, depth + 1)}?`;
      case 'ZodDefault':
        return `${describeZodField(def.innerType, depth + 1)}=def`;
      case 'ZodEnum':
        return `enum(${[...((def.values as string[]) ?? [])].sort().join('|')})`;
      case 'ZodNativeEnum':
        return `nenum(${Object.values((def.values as Record<string, unknown>) ?? {}).sort().join('|')})`;
      case 'ZodArray':
        return `array<${describeZodField(def.type, depth + 1)}>`;
      case 'ZodRecord':
        return `record<${describeZodField(def.valueType, depth + 1)}>`;
      case 'ZodUnion':
        return `union(${((def.options as unknown[]) ?? []).map((o) => describeZodField(o, depth + 1)).join('|')})`;
      case 'ZodObject': {
        const shape = typeof def.shape === 'function' ? (def.shape as () => Record<string, unknown>)() : (def.shape as Record<string, unknown>) ?? {};
        return `obj{${Object.keys(shape).sort().join(',')}}`;
      }
      default:
        return typeName.replace(/^Zod/, '').toLowerCase() || 'field';
    }
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
