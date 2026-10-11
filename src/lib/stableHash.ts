// One stable content hash: sha256 hex of JSON with object keys sorted (localeCompare), recursively.
// Arrays keep their order.

import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b))) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(value)) ?? '')
    .digest('hex');
}
