// Suite linting (`swipium suite lint`): flag page objects whose locators are
// brittle (coordinate-only), copy/locale-fragile (text), or dynamic-looking. Reads the generated
// .swipium/pages/*.page.yaml; shared by the suite CLI.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compileTest, loadPages } from './compile.js';

export interface SuiteLintItem {
  page: string;
  element: string;
  severity: 'error' | 'warning';
  code?:
    | 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER'
    | 'ANDROID_MISSING_RESOURCE_ID'
    | 'DYNAMIC_TEXT_LOCATOR'
    | 'COORDINATE_ONLY'
    | 'YAML_PARSE_ERROR'
    | 'UNRESOLVED_REFERENCE';
  message: string;
}

export interface SuiteLintResult {
  pagesDir: string;
  exists: boolean;
  pageCount: number;
  items: SuiteLintItem[];
}

export function lintSuitePages(root: string): SuiteLintResult {
  const pagesDir = join(root, '.swipium', 'pages');
  if (!existsSync(pagesDir)) return { pagesDir, exists: false, pageCount: 0, items: [] };

  const items: SuiteLintItem[] = [];
  let pageCount = 0;
  for (const f of readdirSync(pagesDir)) {
    if (!f.endsWith('.page.yaml')) continue;
    pageCount++;
    let doc: Record<string, unknown>;
    try {
      doc = parseYaml(readFileSync(join(pagesDir, f), 'utf8')) as Record<string, unknown>;
    } catch (e) {
      items.push({
        page: f,
        element: '(file)',
        severity: 'error',
        code: 'YAML_PARSE_ERROR',
        message: `could not parse page YAML: ${yamlErrorText(e)}`,
      });
      continue;
    }
    const pageName = (doc?.name as string) ?? f;
    const elements = (doc?.elements as Record<string, Record<string, unknown>>) ?? {};
    for (const [name, el] of Object.entries(elements)) {
      const durability = el.durability as string | undefined;
      const hasLocator = el['accessibility id'] || el['resource-id'] || el.text || el.name;
      const readinessCode = typeof el.readinessCode === 'string' ? (el.readinessCode as SuiteLintItem['code']) : undefined;
      if (durability === 'brittle' || !hasLocator) {
        items.push({
          page: pageName,
          element: name,
          severity: 'error',
          code: readinessCode ?? 'COORDINATE_ONLY',
          message: (el.remediation as string) ?? 'no durable locator (coordinate-only). Add a testID/accessibilityIdentifier',
        });
      } else if (durability === 'semi' || el.text) {
        const androidOnly = Array.isArray(doc?.platforms) && doc.platforms.length === 1 && doc.platforms[0] === 'android';
        const code =
          readinessCode ??
          ((el.text || el.name) && !el['accessibility id']
            ? androidOnly
              ? 'ANDROID_MISSING_RESOURCE_ID'
              : 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER'
            : undefined);
        items.push({
          page: pageName,
          element: name,
          severity: 'warning',
          code,
          message: (el.remediation as string) ?? 'text/locale-fragile selector. Add an accessibilityIdentifier/testID for CI-stable replay',
        });
      }
      if (typeof el.text === 'string' && /\d{3,}|[0-9a-f]{8,}/i.test(el.text)) {
        items.push({
          page: pageName,
          element: name,
          severity: 'warning',
          code: 'DYNAMIC_TEXT_LOCATOR',
          message: `selector "${el.text}" looks dynamic (contains digits/ids). Prefer a stable identifier`,
        });
      }
    }
  }
  items.push(...lintSuiteTests(root));
  return { pagesDir, exists: true, pageCount, items };
}

/** First line of a YAML parser error (it carries "at line L, column C"). */
function yamlErrorText(e: unknown): string {
  return String((e as Error)?.message ?? e).split('\n')[0];
}

/** LOG-21 / E2E-14: lint the POM tests too, with the same reference checks `suite compile` runs
 *  (unknown page, element without a usable locator) plus coordinate-only taps. */
function lintSuiteTests(root: string): SuiteLintItem[] {
  const testsDir = join(root, '.swipium', 'tests');
  if (!existsSync(testsDir)) return [];
  const items: SuiteLintItem[] = [];
  const pages = loadPages(root);
  for (const f of readdirSync(testsDir)) {
    if (!/\.ya?ml$/i.test(f)) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parseYaml(readFileSync(join(testsDir, f), 'utf8')) as Record<string, unknown>;
    } catch (e) {
      items.push({
        page: f,
        element: '(file)',
        severity: 'error',
        code: 'YAML_PARSE_ERROR',
        message: `could not parse test YAML: ${yamlErrorText(e)}`,
      });
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const compiled = compileTest(doc, pages);
    for (const err of new Set(compiled.errors))
      items.push({ page: f, element: '(test)', severity: 'error', code: 'UNRESOLVED_REFERENCE', message: err });
    const steps = Array.isArray(doc.steps) ? (doc.steps as Array<Record<string, unknown>>) : [];
    steps.forEach((s, i) => {
      if (s && typeof s === 'object' && (s.action === 'tapAt' || (s.action === 'tap' && !s.element && s.coords)))
        items.push({
          page: f,
          element: `step ${i + 1}`,
          severity: 'warning',
          code: 'COORDINATE_ONLY',
          message: 'coordinate tap is brittle (screen size/orientation). Add a testID/accessibilityIdentifier and tap the element',
        });
    });
  }
  return items;
}
