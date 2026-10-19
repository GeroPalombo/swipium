// POM > Flow V2 compiler. Generated POM suites reference page-object elements by
// name; this resolves those refs against the page objects and emits Flow V2 YAML that parseFlow()
// accepts and qa_flow_run can execute. Without this, a generated suite is only
// documentation. With it, a recorded run becomes a runnable, CI-usable flow.
//
// Compilation reads YAML files only (no device); the output is validated by the caller via
// parseFlow(). writeCompiledFlow is the one writer, shared by the CLI and the MCP tools, and it
// never clobbers a hand-edited .swipium/flows file.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { waitForVisibleGuard } from '../flows/waitGuards.js';
import { capSlug } from '../lib/stableHash.js';
import { mkdirNoFollow, rmNoFollow, writeFileNoFollow } from '../lib/noFollowFs.js';

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
  // Android resource id > `id=<value>`: the Flow V2 runner resolves this via resolveTarget({ id }).
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
export function compileTest(
  testDoc: Record<string, unknown>,
  pages: Map<string, PageDoc>,
): { flow: Record<string, unknown>; variables: string[]; errors: string[] } {
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
          errors.push(`step ${i + 1}: tap has neither element nor coords`);
        }
        break;
      case 'tapAt':
        if (s.coords) steps.push({ tapAt: s.coords });
        break;
      case 'inputText': {
        collectVars(s.text);
        const sel = s.element ? resolveSel(s) : null;
        if (s.element && sel)
          steps.push(waitForVisibleGuard(sel), { inputText: { into: sel, text: s.text ?? '', ...(s.secret ? { secret: true } : {}) } });
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
      case 'restartApp':
        steps.push('restartApp');
        break;
      case 'visualCheck':
        // Visual judgement > evidence-capturing checkpoint (flow assertVisual), never a text assertion.
        steps.push({ assertVisual: s.text ?? 'visual checkpoint' });
        break;
      default:
        errors.push(`step ${i + 1}: unknown action "${s.action}"`);
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
    '# Compiled by Swipium qa_flow_compile from a POM test. Run it with qa_flow_run.',
    ...(compiled.variables.length ? [`# variables: ${compiled.variables.join(', ')}`] : []),
  ].join('\n');
  return {
    name: (doc.name as string) ?? testRel,
    yaml: `${header}\n${stringify(compiled.flow)}`,
    variables: compiled.variables,
    errors: compiled.errors,
  };
}

export interface WrittenCompiledFlow {
  /** .swipium/flows/<slug>.yaml (what qa_flow_run flow:"<slug>" and smoke runs pick up). */
  flowPath: string;
  /** .swipium/compiled/<slug>.flow.yaml: Swipium's own copy, always refreshed. */
  compiledPath: string;
  /** The flows/ file was hand-edited (differs from the last compiled copy), so it was kept and
   *  the new output went to `<slug>.yaml.new` instead. Pass force to overwrite. */
  kept?: boolean;
  newPath?: string;
  /** A previous compiled flow with different content was replaced. */
  replaced?: boolean;
}

/** File slug for a compiled flow name: word chars only, capped so a long test name can't hit ENAMETOOLONG. */
export function flowSlug(name: string): string {
  return capSlug(name.replace(/[^\w.-]+/g, '-'));
}

/** Write one compiled flow without clobbering hand edits: the flows/ copy is overwritten
 *  only when it is missing, unchanged since the last compile, or `force` is set. */
export function writeCompiledFlow(root: string, slug: string, yaml: string, opts: { force?: boolean } = {}): WrittenCompiledFlow {
  const flowsDir = join(root, '.swipium', 'flows');
  const compiledDir = join(root, '.swipium', 'compiled');
  // No-follow: a cloned repo can commit .swipium/, flows/ or compiled/ as a symlink out of the project.
  mkdirNoFollow(root, flowsDir);
  mkdirNoFollow(root, compiledDir);
  const flowPath = join(flowsDir, `${slug}.yaml`);
  const compiledPath = join(compiledDir, `${slug}.flow.yaml`);
  const read = (p: string): string | undefined => {
    try {
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
  const current = read(flowPath);
  const previousCompiled = read(compiledPath);
  const out: WrittenCompiledFlow = { flowPath, compiledPath };
  if (current !== undefined && current !== yaml && current !== previousCompiled && !opts.force) {
    out.kept = true;
    out.newPath = `${flowPath}.new`;
    writeFileNoFollow(root, out.newPath, yaml);
  } else {
    if (current !== undefined && current !== yaml) out.replaced = true;
    writeFileNoFollow(root, flowPath, yaml);
    // A `.new` left by an earlier "kept your edit" run is stale once flows/ holds the new output.
    rmNoFollow(root, `${flowPath}.new`);
  }
  writeFileNoFollow(root, compiledPath, yaml);
  return out;
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
