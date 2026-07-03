// Code-aware feature index (SWIPIUM-REQ-03, foundation from SWIPIUM-REQ-01). A deterministic,
// LLM-free static index over the project's source so a natural-language feature request can be
// mapped to concrete code: screen/component/service/hook symbols, navigation route names, and
// per-file token sets. Pure logic lives in tokenize/extractSymbols/extractRoutes (unit-tested
// without a filesystem); buildFeatureIndex walks the tree and applies them.
//
// v1 is intentionally deterministic (Non-Goals): regex + name heuristics, not semantic analysis.
// The schema carries tokens so synonym/locale expansion can happen at query time later.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

export type SymbolKind = 'screen' | 'component' | 'service' | 'hook' | 'function' | 'class' | 'constant';

export interface SourceSymbol {
  name: string;
  kind: SymbolKind;
  file: string; // path relative to root
  line: number;
  tokens: string[]; // lowercased word tokens split out of the name
}

export interface RouteRef {
  route: string; // e.g. "/weather", "WeatherAnalysis", "myapp://weather"
  file: string;
  line: number;
  tokens: string[];
}

export interface SourceFileEntry {
  file: string; // relative path
  base: string; // basename without extension
  tokens: string[]; // tokens from the filename
}

export interface FeatureIndex {
  root: string;
  symbols: SourceSymbol[];
  routes: RouteRef[];
  files: SourceFileEntry[];
  scannedFiles: number;
  truncated: boolean; // hit the maxFiles cap — coverage is partial
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.swift', '.kt', '.java', '.dart', '.vue']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.expo',
  '.gradle',
  'Pods',
  'DerivedData',
  'vendor',
  '.swipium',
  '__snapshots__',
  '.cache',
  'tmp',
  '.idea',
  '.vscode',
]);

/** Split an identifier (camelCase / PascalCase / snake_case / kebab-case) into lowercase word tokens. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord boundary
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
}

/** Classify a symbol by conventional name suffixes/prefixes — deterministic, English-leaning v1. */
export function classifySymbol(name: string): SymbolKind {
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/(Screen|Page|View|Activity|Fragment|Route)$/.test(name)) return 'screen';
  if (/(Service|Api|Client|Repository|Store|Manager|Provider|Controller|Analyzer|Engine)$/.test(name)) return 'service';
  if (/(Component|Card|Button|List|Modal|Sheet|Header|Footer|Item|Row|Tile|Widget)$/.test(name)) return 'component';
  if (/^[A-Z]/.test(name)) return 'component'; // PascalCase default → likely a component/class
  return 'function';
}

/** Extract declared symbol names from a source file's text (JS/TS/Swift/Kotlin/Java/Dart). PURE. */
export function extractSymbols(text: string): Array<{ name: string; kind: SymbolKind; line: number }> {
  const out: Array<{ name: string; kind: SymbolKind; line: number }> = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  const patterns: RegExp[] = [
    // JS/TS declarations
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|React\.|memo\(|forwardRef\(|styled)/,
    /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    // Swift / Kotlin / Java
    /(?:struct|protocol|extension)\s+([A-Z][\w]*)/,
    /(?:fun|func)\s+([A-Za-z_][\w]*)/,
    // Dart / Kotlin widgets
    /(?:Widget|StatelessWidget|StatefulWidget)\s+([A-Z][\w]*)/,
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1];
      const key = `${name}@${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, kind: classifySymbol(name), line: i + 1 });
    }
  }
  return out;
}

/** Extract navigation route / deep-link names from a source file's text. PURE. */
export function extractRoutes(text: string): Array<{ route: string; line: number }> {
  const out: Array<{ route: string; line: number }> = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  const patterns: RegExp[] = [
    /\bpath\s*:\s*['"`]([^'"`]+)['"`]/g, // react-router / vue-router { path: '/weather' }
    /\b(?:name|routeName|screen)\s*:\s*['"`]([A-Za-z][^'"`]*)['"`]/g, // { name: 'WeatherAnalysis' }
    /<(?:Stack|Tab|Drawer|NativeStack)?\.?Screen\b[^>]*\bname\s*=\s*['"`]([^'"`]+)['"`]/g, // RN <Stack.Screen name="Weather" />
    /navigation\.(?:navigate|push|replace)\(\s*['"`]([^'"`]+)['"`]/g, // navigation.navigate('Weather')
    /(?:Link|NavLink|router\.push)\(?\s*[^'"`]*['"`](\/[A-Za-z][^'"`]*)['"`]/g, // router.push('/weather')
    /['"`]([a-z][\w.+-]*:\/\/[^'"`\s]+)['"`]/g, // deep links myapp://weather
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i]))) {
        const route = m[1];
        if (!route || route.length > 80) continue;
        const key = `${route}@${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ route, line: i + 1 });
      }
    }
  }
  return out;
}

/** Tokenize a route string into searchable terms (drops scheme/slashes/params). */
function routeTokens(route: string): string[] {
  return tokenize(route.replace(/^[a-z]+:\/\//i, '').replace(/[/:?#&=]/g, ' '));
}

/**
 * Walk the project tree and build the static feature index. Reads files (best-effort) and applies
 * the pure extractors. Skips build/vendor dirs and caps the file count to keep context bounded.
 */
export function buildFeatureIndex(root: string, opts: { maxFiles?: number; maxBytesPerFile?: number } = {}): FeatureIndex {
  const maxFiles = opts.maxFiles ?? 4000;
  const maxBytes = opts.maxBytesPerFile ?? 512 * 1024;
  const symbols: SourceSymbol[] = [];
  const routes: RouteRef[] = [];
  const files: SourceFileEntry[] = [];
  let scannedFiles = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (scannedFiles >= maxFiles) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (scannedFiles >= maxFiles) {
        truncated = true;
        return;
      }
      if (name.startsWith('.') && name !== '.') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
      } else if (st.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!SOURCE_EXT.has(ext)) continue;
        if (/\.(d\.ts|test\.[tj]sx?|spec\.[tj]sx?)$/.test(name)) continue; // skip declarations + tests
        if (st.size > maxBytes) continue;
        const rel = relative(root, full);
        const base = basename(name, ext);
        files.push({ file: rel, base, tokens: tokenize(base) });
        scannedFiles++;
        let text: string;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        for (const s of extractSymbols(text)) {
          symbols.push({ name: s.name, kind: s.kind, file: rel, line: s.line, tokens: tokenize(s.name) });
        }
        for (const r of extractRoutes(text)) {
          routes.push({ route: r.route, file: rel, line: r.line, tokens: routeTokens(r.route) });
        }
      }
    }
  };

  if (existsSync(root)) walk(root);
  return { root, symbols, routes, files, scannedFiles, truncated };
}
