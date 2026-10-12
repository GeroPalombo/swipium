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

/** Longest slug used as one path component. Filesystems cap a component at 255 bytes, and a raw
 *  ENAMETOOLONG from a long title/name broke suites for good. */
export const MAX_FILE_SLUG = 80;

/** Cap a filename slug: unchanged when short, else a prefix plus a short stable hash of the whole. */
export function capSlug(slug: string, max = MAX_FILE_SLUG): string {
  if (slug.length <= max) return slug;
  const h = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `${slug.slice(0, max - 9).replace(/[-_.]+$/, '')}-${h}`;
}
