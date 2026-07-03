// `swipium suite <lint|compile|init>`. `lint` audits generated page objects for
// brittle locators; `init` prints how to bootstrap a suite (generation needs a recorded run,
// which is a live MCP session — the CLI points the user at it rather than guessing).

import { isAbsolute, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { lintSuitePages } from '../suite/lint.js';
import { compileSuite } from '../suite/compile.js';
import { parseFlow } from '../flows/schema.js';

function resolveRoot(arg?: string): string {
  if (!arg) return process.cwd();
  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}

/** Compile a suite into runnable Flow V2 files under .swipium/flows + .swipium/compiled. */
function compileToFlows(root: string, suiteRel?: string): { ok: boolean; slugs: string[]; lines: string[] } {
  const result = compileSuite(root, suiteRel ?? 'suites/smoke.yaml');
  const lines: string[] = [];
  if (result.errors.length && result.flows.length === 0) {
    return { ok: false, slugs: [], lines: [`No suite to compile: ${result.errors.join('; ')}`] };
  }
  const flowsDir = join(root, '.swipium', 'flows');
  const compiledDir = join(root, '.swipium', 'compiled');
  mkdirSync(flowsDir, { recursive: true });
  mkdirSync(compiledDir, { recursive: true });
  const slugs: string[] = [];
  let allOk = true;
  for (const f of result.flows) {
    const slug = f.name.replace(/[^\w.-]+/g, '-');
    const parse = f.yaml ? parseFlow(f.yaml) : { errors: ['empty'] };
    const ok = !!f.yaml && parse.errors.length === 0 && f.errors.length === 0;
    if (ok) {
      writeFileSync(join(flowsDir, `${slug}.yaml`), f.yaml);
      writeFileSync(join(compiledDir, `${slug}.flow.yaml`), f.yaml);
      slugs.push(slug);
      lines.push(`✓ ${f.name} → .swipium/flows/${slug}.yaml`);
    } else {
      allOk = false;
      lines.push(`✗ ${f.name}: ${[...f.errors, ...parse.errors].join('; ')}`);
    }
  }
  return { ok: allOk, slugs, lines };
}

export async function runSuite(args: string[]): Promise<void> {
  const sub = args[0];
  const root = resolveRoot(args.find((a, i) => i > 0 && !a.startsWith('--')));

  if (sub === 'lint') {
    const res = lintSuitePages(root);
    if (!res.exists) {
      process.stdout.write(`No .swipium/pages under ${root}. Generate a suite first (qa_generate target:"suite" via the MCP server).\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`Suite lint: ${res.pageCount} page object(s), ${res.items.length} finding(s)\n`);
    for (const i of res.items) {
      process.stdout.write(`${i.severity.toUpperCase()} ${i.page}.${i.element}: ${i.message}\n`);
    }
    process.exitCode = res.items.some((i) => i.severity === 'error') ? 1 : 0;
    return;
  }

  if (sub === 'compile') {
    const suiteRel = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : undefined;
    const r = compileToFlows(root, suiteRel);
    r.lines.forEach((l) => process.stdout.write(l + '\n'));
    process.exitCode = r.ok && r.slugs.length ? 0 : 2;
    return;
  }

  if (sub === 'init') {
    process.stdout.write(
      [
        'Swipium suites are generated from a recorded run (durable selectors > guesswork):',
        '  1. Start the MCP server and a session (qa_start_session).',
        '  2. Drive the app with qa_act (or qa_smoke) — every action is recorded.',
        '  3. qa_generate target:"suite" → writes .swipium/{pages,tests,suites,testcases,locators}.',
        '  4. swipium suite lint — audit locator durability before committing.',
        '  5. swipium suite compile — POM → runnable Flow V2 under .swipium/flows.',
        '  6. Execute compiled flows through qa_flow_run from an MCP session.',
        '',
      ].join('\n'),
    );
    process.exitCode = 0;
    return;
  }

  process.stdout.write('Usage: swipium suite <lint|compile|init> [--suite suites/smoke.yaml] [projectRoot]\n');
  process.exitCode = 2;
}
