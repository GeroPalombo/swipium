// Identifier safety for the generated JS/TS and Python suites (H4). Recorded element/page names
// come from arbitrary app copy ("Continue", "Return", "2FA code", "class", "登录"), so every name
// that becomes a class, field, attribute or method in generated source is sanitized here:
//   - Latin diacritics transliterated first (asciiFold: "Configuración" → "Configuracion"), then
//     remaining non-ASCII / punctuation stripped; empty → a stable fallback (element, element2, …);
//   - a leading digit gets a prefix (2FACode → el2FACode / el_2fa_code);
//   - language keywords / reserved words get a trailing underscore (continue → continue_);
//   - names that would shadow a BaseScreen member (tap, find, driver, …) are suffixed too;
//   - collisions are deduped deterministically in declaration order (name, name2, name3, …).
// Pure — no I/O.

import type { AppiumScreen, AppiumSuiteModel } from './appiumModel.js';

/** Thrown when a recorded step cannot be expressed as real generated code. Generation fails with
 *  this message instead of emitting a silent no-op (driver.swipe(0,0,0,0) / pass / a comment). */
export class UnemittableStepError extends Error {
  readonly code = 'UNEMITTABLE_STEP';
  constructor(message: string) {
    super(message);
    this.name = 'UnemittableStepError';
  }
}

/** ECMAScript reserved words + strict-mode / TypeScript-sensitive words. */
export const JS_RESERVED: ReadonlySet<string> = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'arguments',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
]);

/** Python hard keywords (keyword.kwlist). Soft keywords (match/case/type/_) are valid identifiers. */
export const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/** Transliterate to ASCII where Unicode allows it: NFKD, then drop combining marks
 *  ("Configuración" → "Configuracion", "Überblick" → "Uberblick", "ﬁle" → "file"). Scripts with no
 *  ASCII decomposition ("登录") pass through unchanged and are stripped by the sanitizers. Applied
 *  before EVERY class / module / file / member name derivation so they stay consistent
 *  (without it "ó" became a word break: configuraci_nscreen.py next to configuraci_n2_screen.py). */
export function asciiFold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

function words(s: string): string[] {
  return asciiFold(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** PascalCase from arbitrary text (ASCII letters/digits only); '' when nothing survives. */
export function pascalWords(s: string): string {
  return asciiFold(s)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

/** snake_case from arbitrary text (ASCII letters/digits only); '' when nothing survives. */
export function snakeWords(s: string): string {
  return words(s).join('_').toLowerCase();
}

/** Deterministic de-duplicating allocator: first come keeps the base, later ones get 2, 3, …
 *  A name that clashes with a RESERVED member (e.g. BaseScreen.tap) is suffixed with `_` first
 *  (tap → tap_), matching the keyword convention; only then numbered. */
export class NameAllocator {
  private readonly used: Set<string>;
  private readonly reserved: Set<string>;
  constructor(
    reserved: Iterable<string> = [],
    private readonly normalize: (s: string) => string = (s) => s,
  ) {
    this.reserved = new Set([...reserved].map(normalize));
    this.used = new Set(this.reserved);
  }
  alloc(base: string, sep = ''): string {
    const root = this.reserved.has(this.normalize(base)) ? `${base}_` : base;
    let name = root;
    let n = 2;
    while (this.used.has(this.normalize(name))) name = `${root}${sep}${n++}`;
    this.used.add(this.normalize(name));
    return name;
  }
}

/** A camelCase JS identifier (field / variable). */
export function jsMemberName(raw: string, fallback = 'element'): string {
  const p = pascalWords(raw);
  let id = p ? p[0].toLowerCase() + p.slice(1) : fallback;
  if (/^[0-9]/.test(id)) id = `el${id}`;
  if (JS_RESERVED.has(id)) id = `${id}_`;
  return id;
}

/** A PascalCase JS/Python class name. */
export function className(raw: string, fallback = 'Screen'): string {
  let id = pascalWords(raw) || fallback;
  if (/^[0-9]/.test(id)) id = `Screen${id}`;
  if (JS_RESERVED.has(id) || PY_KEYWORDS.has(id)) id = `${id}_`;
  return id;
}

/** A snake_case Python identifier (attribute / module / variable). */
export function pyName(raw: string, fallback = 'element'): string {
  let id = snakeWords(raw) || fallback;
  if (/^[0-9]/.test(id)) id = `el_${id}`;
  if (PY_KEYWORDS.has(id)) id = `${id}_`;
  return id;
}

/** True for a plain JS identifier usable after a dot / as a bare object key. */
export function isJsIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

/** Collapse text onto one line so it is safe inside a `//` or `#` line comment. */
export function commentSafe(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');
}

export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export function checkDirection(dir: string | undefined, what: string): Direction {
  const d = (dir ?? '').toLowerCase();
  if ((DIRECTIONS as readonly string[]).includes(d)) return d as Direction;
  throw new UnemittableStepError(
    `cannot emit ${what}: direction ${JSON.stringify(dir)} is not one of up/down/left/right — fix the recorded step and regenerate`,
  );
}

export const SUPPORTED_KEYS = ['back', 'home', 'enter'] as const;

export function checkKey(key: string | undefined): string {
  const k = (key ?? 'back').toLowerCase();
  if ((SUPPORTED_KEYS as readonly string[]).includes(k)) return k;
  throw new UnemittableStepError(
    `cannot emit press step: key ${JSON.stringify(key)} is not supported by the generated suite (supported: ${SUPPORTED_KEYS.join(', ')})`,
  );
}

/** Screens referenced by steps but absent from model.screens still need (empty) classes, or the
 *  generated test would import a module that does not exist. */
export function screensOf(model: AppiumSuiteModel): AppiumScreen[] {
  const out = [...model.screens];
  for (const s of model.steps) {
    if (!out.some((sc) => sc.className === s.screen)) out.push({ className: s.screen, pageName: s.screen, elements: [] });
  }
  return out;
}
