// Lightweight text/symbol index over source files (SWIPIUM-REQ-01 "All frameworks: build a
// lightweight text/symbol index over source files for feature queries"). Dependency-free: it
// extracts exported/declared symbol names + a small token bag per file so qa_app_map_query can
// rank source candidates without re-reading the tree. Persisted under .swipium/app-map.index/.

import { basename } from 'node:path';
import { rel, readTextSafe } from './fsWalk.js';

export interface CodeSymbolFile {
  file: string; // relative path
  symbols: string[]; // exported/declared names (components, classes, functions, structs)
  tokens: string[]; // de-duped lowercase identifier tokens (capped)
  textTokens?: string[]; // de-duped visible copy tokens from string literals and JSX/XML text
}

export interface CodeIndex {
  schemaVersion: 1;
  generatedAt: string;
  files: CodeSymbolFile[];
}

const SYMBOL_RES: RegExp[] = [
  /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g,
  /export\s+(?:default\s+)?class\s+([A-Za-z0-9_]+)/g,
  /(?:^|\n)\s*(?:public\s+|final\s+|open\s+|abstract\s+)*(?:class|interface|object)\s+([A-Za-z0-9_]+)/g,
  /struct\s+([A-Za-z0-9_]+)\s*:/g,
  /(?:^|\n)\s*class\s+([A-Za-z0-9_]+)\s+extends\s+/g, // dart widgets
];

function extractSymbols(text: string): string[] {
  const out = new Set<string>();
  for (const re of SYMBOL_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (m[1]) out.add(m[1]);
  }
  return [...out].slice(0, 60);
}

function tokenize(text: string, limit = 40): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) {
    // split camelCase into sub-words so "WeatherAnalysisScreen" matches "weather"/"analysis"
    const word = m[0];
    const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
    for (const p of parts) if (p.length >= 3) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

function extractVisibleText(text: string): string {
  const chunks: string[] = [];
  for (const m of text.matchAll(/"([^"\\]{2,200})"|'([^'\\]{2,200})'|`([^`\\$]{2,200})`/g)) {
    const s = m[1] ?? m[2] ?? m[3];
    if (s && !s.includes('/') && !s.startsWith('@') && !s.startsWith('.')) chunks.push(s);
  }
  for (const m of text.matchAll(/>([^<>{}\n]{2,200})</g)) chunks.push(m[1]);
  return chunks.join(' ');
}

const STOP = new Set(['const', 'export', 'import', 'function', 'return', 'class', 'this', 'from', 'react', 'native', 'string', 'number', 'void', 'null', 'undefined', 'true', 'false', 'async', 'await']);

/** Build a code index from collected source files. Skips tests/specs and oversized files. */
export function buildCodeIndex(root: string, files: string[], generatedAt: string): CodeIndex {
  const out: CodeSymbolFile[] = [];
  for (const f of files) {
    const relPath = rel(root, f);
    if (/\.(test|spec|stories)\./.test(basename(f))) continue;
    const text = readTextSafe(f);
    if (!text || text.length > 400_000) continue;
    const symbols = extractSymbols(text);
    const tokens = tokenize(text).filter((t) => !STOP.has(t));
    const textTokens = tokenize(extractVisibleText(text), 160).filter((t) => !STOP.has(t));
    if (!symbols.length && !tokens.length && !textTokens.length) continue;
    out.push({ file: relPath, symbols, tokens, ...(textTokens.length ? { textTokens } : {}) });
    if (out.length >= 2000) break;
  }
  return { schemaVersion: 1, generatedAt, files: out };
}

/** Score a file against query terms. */
export function scoreFile(entry: CodeSymbolFile, terms: string[]): number {
  let score = 0;
  const symLower = entry.symbols.map((s) => s.toLowerCase());
  const textTokens = entry.textTokens ?? [];
  for (const t of terms) {
    if (symLower.some((s) => s.includes(t))) score += 3;
    if (entry.tokens.includes(t)) score += 1;
    if (entry.file.toLowerCase().includes(t)) score += 2;
    if (textTokens.includes(t)) score += 2;
  }
  return score;
}

export function fileMatchDimensions(entry: CodeSymbolFile, terms: string[]): string[] {
  const dims = new Set<string>();
  const symLower = entry.symbols.map((s) => s.toLowerCase());
  const textTokens = entry.textTokens ?? [];
  const fileLower = entry.file.toLowerCase();
  for (const t of terms) {
    if (symLower.some((s) => s.includes(t))) dims.add('component_name');
    if (entry.tokens.includes(t)) dims.add('identifier');
    if (fileLower.includes(t)) dims.add('file_name');
    if (textTokens.includes(t)) dims.add('visible_text');
  }
  return [...dims];
}
