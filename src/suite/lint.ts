// Suite linting (roadmap §6 / §12 `swipium suite lint`) — flag page objects whose locators are
// brittle (coordinate-only), copy/locale-fragile (text), or dynamic-looking. Reads the generated
// .swipium/pages/*.page.yaml; shared by the suite CLI.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SuiteLintItem {
  page: string;
  element: string;
  severity: 'error' | 'warning';
  code?: 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER' | 'DYNAMIC_TEXT_LOCATOR' | 'COORDINATE_ONLY';
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
    } catch {
      items.push({ page: f, element: '(file)', severity: 'error', message: 'could not parse page YAML' });
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
          message: (el.remediation as string) ?? 'no durable locator (coordinate-only) — add a testID/accessibilityIdentifier',
        });
      } else if (durability === 'semi' || el.text) {
        const code =
          readinessCode ?? ((el.text || el.name) && !el['accessibility id'] ? 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER' : undefined);
        items.push({
          page: pageName,
          element: name,
          severity: 'warning',
          code,
          message:
            (el.remediation as string) ?? 'text/locale-fragile selector — add an accessibilityIdentifier/testID for CI-stable replay',
        });
      }
      if (typeof el.text === 'string' && /\d{3,}|[0-9a-f]{8,}/i.test(el.text)) {
        items.push({
          page: pageName,
          element: name,
          severity: 'warning',
          code: 'DYNAMIC_TEXT_LOCATOR',
          message: `selector "${el.text}" looks dynamic (contains digits/ids) — prefer a stable identifier`,
        });
      }
    }
  }
  return { pagesDir, exists: true, pageCount, items };
}
