// Grep gate: Swipium talks to the MCP SDK (and zod) through public API only. Any `._name` member
// access in src/ is a private-internals dependency that breaks silently on an SDK upgrade (the
// old tools/call shim patched `server.server._requestHandlers`). Python helper names inside the
// generated-test emitter are text, not TypeScript member access, and are the only allowlisted hits.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
// lib/schemaHash.ts reads zod 3 `_def` (zod, not the SDK) until the zod 4 move replaces it.
const ALLOWED_FILES = new Set(['automationGen/pythonEmitter.ts', 'lib/schemaHash.ts']);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('no private SDK / zod internals in src/', () => {
  it('has no underscore member access outside the allowlist', () => {
    const hits: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (ALLOWED_FILES.has(rel)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
          if (/\.\s*_[A-Za-z]\w*/.test(line) || /\[\s*['"]_[A-Za-z]\w*['"]\s*\]/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('never names the SDK request-handler table', () => {
    for (const file of tsFiles(SRC)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/_requestHandlers|_registeredTools/);
  });
});
