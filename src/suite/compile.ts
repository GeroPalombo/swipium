// POM → Flow V2 compiler (hardening P0.4). Generated POM suites reference page-object elements by
// name; this resolves those refs against the page objects and emits Flow V2 YAML that parseFlow()
// accepts and qa_flow_run / `swipium ci` can execute. Without this, a generated suite is only
// documentation — with it, a recorded run becomes a runnable, CI-usable flow.
//
// PURE: reads YAML files, no device. The compiler output is validated by the caller via parseFlow().

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { waitForVisibleGuard } from '../flows/waitGuards.js';

export interface CompiledFlow {
  name: string;
  yaml: string;
  variables: string[];
  errors: string[];
}

export interface CompileSuiteResult {
  suite: string;
  flows: CompiledFlow[];
  errors: string[];
}

type PageDoc = { name?: string; elements?: Record<string, Record<string, unknown>> };

/** Load all page objects under .swipium/pages, keyed by their declared `name`. */
export function loadPages(root: string): Map<string, PageDoc> {
  const dir = join(root, '.swipium', 'pages');
  const out = new Map<string, PageDoc>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.page.yaml')) continue;
    try {
      const doc = parseYaml(readFileSync(join(dir, f), 'utf8')) as PageDoc;
      if (doc?.name) out.set(doc.name, doc);
    } catch {
      /* skip unparseable page */
    }
  }
  return out;
}

/** Turn a page element's locator into a Flow V2 selector string (mirrors flow generate). */
export function elementSelector(el: Record<string, unknown> | undefined): string | null {
  if (!el) return null;
  if (typeof el['accessibility id'] === 'string') return `accessibility id=${el['accessibility id']}`;
  // Android resource id → `id=<value>`: the Flow V2 runner resolves this via resolveTarget({ id }).
  // (A bare `resource-id=` prefix is NOT parsed by the runner and would fall back to a text match.)
  if (typeof el['resource-id'] === 'string') return `id=${el['resource-id']}`;
  if (typeof el.name === 'string') return `name=${el.name}`;
  if (typeof el.predicate === 'string') return `predicate string=${el.predicate}`;
  if (typeof el['class chain'] === 'string') return `class chain=${el['class chain']}`;
  if (typeof el.text === 'string') return el.text; // bare text selector
  if (typeof el.fallbackText === 'string') return el.fallbackText;
  return null;
}

interface PomStep {
  page?: string;
  element?: string;
  action?: string;
  text?: string;
  secret?: boolean;
  key?: string;
  direction?: string;
  url?: string;
  coords?: [number, number];
}

/** Compile one POM test doc into a Flow V2 flow object + variables + per-step errors. */
export function compileTest(testDoc: Record<string, unknown>, pages: Map<string, PageDoc>): { flow: Record<string, unknown>; variables: string[]; errors: string[] } {
  const errors: string[] = [];
  const variables = new Set<string>();
  const steps: Array<string | Record<string, unknown>> = ['prepareTarget'];

  const resolveSel = (s: PomStep): string | null => {
    if (!s.element) return null;
    const page = s.page ? pages.get(s.page) : undefined;
    if (!page) {
      errors.push(`step references unknown page "${s.page}"`);
      return null;
    }
    const el = page.elements?.[s.element];
    const sel = elementSelector(el);
    if (!sel) errors.push(`page "${s.page}" has no usable locator for element "${s.element}"`);
    return sel;
  };

  const rawSteps = (testDoc.steps as PomStep[]) ?? [];
  rawSteps.forEach((s, i) => {
    const collectVars = (t?: string) => {
      if (t) for (const m of t.matchAll(/\$\{([^}]+)\}/g)) variables.add(m[1]);
    };
    switch (s.action) {
      case 'tap':
        if (s.element) {
          const sel = resolveSel(s);
          if (sel) steps.push(waitForVisibleGuard(sel), { tap: sel });
        } else if (s.coords) {
          steps.push({ tapAt: s.coords });
        } else {
          errors.push(`step ${i}: tap has neither element nor coords`);
        }
        break;
      case 'tapAt':
        if (s.coords) steps.push({ tapAt: s.coords });
        break;
      case 'inputText': {
        collectVars(s.text);
        const sel = s.element ? resolveSel(s) : null;
        if (s.element && sel) steps.push(waitForVisibleGuard(sel), { inputText: { into: sel, text: s.text ?? '', ...(s.secret ? { secret: true } : {}) } });
        else steps.push({ inputText: s.text ?? '' });
        break;
      }
      case 'press':
        steps.push({ press: s.key ?? 'back' });
        break;
      case 'swipe':
        steps.push({ swipe: s.direction ?? 'up' });
        break;
      case 'scrollTo': {
        const sel = resolveSel(s);
        if (sel) steps.push({ scrollTo: sel });
        break;
      }
      case 'openUrl':
        if (s.url) steps.push({ openUrl: s.url });
        break;
      case 'assertVisible':
        if (s.text) steps.push(waitForVisibleGuard(s.text), { assertVisible: s.text });
        break;
      default:
        errors.push(`step ${i}: unknown action "${s.action}"`);
    }
  });

  const flow: Record<string, unknown> = { name: (testDoc.name as string) ?? 'compiled' };
  if (testDoc.appId) flow.appId = testDoc.appId;
  if (testDoc.budgetProfile) flow.budgetProfile = testDoc.budgetProfile;
  flow.steps = steps;
  return { flow, variables: [...variables], errors };
}

/** Load a POM test file (tests/*.smoke.yaml) and compile it to Flow V2 YAML. */
export function compileTestFile(root: string, testRel: string, pages?: Map<string, PageDoc>): CompiledFlow {
  const abs = join(root, '.swipium', testRel.replace(/^\.swipium\//, ''));
  if (!existsSync(abs)) return { name: testRel, yaml: '', variables: [], errors: [`test file not found: ${testRel}`] };
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(readFileSync(abs, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return { name: testRel, yaml: '', variables: [], errors: [`could not parse ${testRel}: ${String((e as Error).message ?? e)}`] };
  }
  const compiled = compileTest(doc, pages ?? loadPages(root));
  const header = [
    '# Compiled by Swipium qa_suite_compile from a POM test — runnable via qa_flow_run / `swipium ci`.',
    ...(compiled.variables.length ? [`# variables: ${compiled.variables.join(', ')}`] : []),
  ].join('\n');
  return { name: (doc.name as string) ?? testRel, yaml: `${header}\n${stringify(compiled.flow)}`, variables: compiled.variables, errors: compiled.errors };
}

/** Compile every test referenced by a suite file (default .swipium/suites/smoke.yaml). */
export function compileSuite(root: string, suiteRel = 'suites/smoke.yaml'): CompileSuiteResult {
  const abs = join(root, '.swipium', suiteRel.replace(/^\.swipium\//, ''));
  if (!existsSync(abs)) return { suite: suiteRel, flows: [], errors: [`suite not found: ${suiteRel}`] };
  let doc: { tests?: string[] };
  try {
    doc = parseYaml(readFileSync(abs, 'utf8')) as { tests?: string[] };
  } catch (e) {
    return { suite: suiteRel, flows: [], errors: [`could not parse suite: ${String((e as Error).message ?? e)}`] };
  }
  const tests = doc.tests ?? [];
  if (!tests.length) return { suite: suiteRel, flows: [], errors: ['suite has no tests'] };
  const pages = loadPages(root);
  const flows = tests.map((t) => compileTestFile(root, t, pages));
  return { suite: suiteRel, flows, errors: [] };
}
