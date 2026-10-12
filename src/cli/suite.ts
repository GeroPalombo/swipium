// `swipium suite <lint|compile|init>`. `lint` audits generated page objects for
// brittle locators; `init` prints how to bootstrap a suite (generation needs a recorded run,
// which is a live MCP session, so the CLI points the user at it rather than guessing).

import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { lintSuitePages } from '../suite/lint.js';
import { compileSuite, flowSlug, writeCompiledFlow } from '../suite/compile.js';
import { parseFlow } from '../flows/schema.js';

function resolveRoot(arg?: string): string {
  if (!arg) return process.cwd();
  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}

/** Compile a suite into runnable Flow V2 files under .swipium/flows + .swipium/compiled. A flows/
 *  file edited by hand since the last compile is kept (new output > <slug>.yaml.new) unless force. */
function compileToFlows(root: string, suiteRel?: string, force = false): { ok: boolean; slugs: string[]; lines: string[] } {
  const result = compileSuite(root, suiteRel ?? 'suites/smoke.yaml');
  const lines: string[] = [];
  if (result.errors.length && result.flows.length === 0) {
    return { ok: false, slugs: [], lines: [`No suite to compile: ${result.errors.join('; ')}`] };
  }
  const slugs: string[] = [];
  let allOk = true;
  for (const f of result.flows) {
    const slug = flowSlug(f.name);
    const parse = f.yaml ? parseFlow(f.yaml) : { errors: ['empty'] };
    const ok = !!f.yaml && parse.errors.length === 0 && f.errors.length === 0;
    if (ok) {
      const w = writeCompiledFlow(root, slug, f.yaml, { force });
      slugs.push(slug);
      lines.push(
        w.kept
          ? `! ${f.name}: .swipium/flows/${slug}.yaml was edited by hand, kept it; new output > .swipium/flows/${slug}.yaml.new (pass --force to overwrite)`
          : `✓ ${f.name} > .swipium/flows/${slug}.yaml${w.replaced ? ' (replaced previous compiled flow)' : ''}`,
      );
    } else {
      allOk = false;
      lines.push(`✗ ${f.name}: ${[...f.errors, ...parse.errors].join('; ')}`);
    }
  }
  return { ok: allOk, slugs, lines };
}

const SUITE_USAGE =
  'Usage: swipium suite <lint|compile|init> [--suite suites/smoke.yaml] [--force] [--strict] [projectRoot]\n' +
  '  lint exit codes: 0 no errors (warnings allowed unless --strict), 1 errors (or warnings with --strict), 2 no suite\n' +
  '  compile exit codes: 0 all compiled, 2 nothing compiled or a test failed to compile\n' +
  '  compile keeps hand-edited .swipium/flows/<slug>.yaml (writes <slug>.yaml.new); --force overwrites\n';

/** Flags each subcommand accepts; anything else is a usage error (a typo'd --strict must not pass CI). */
const SUITE_FLAGS: Record<string, string[]> = { lint: ['--strict'], compile: ['--suite', '--force'], init: [] };

export async function runSuite(args: string[]): Promise<void> {
  const sub = args[0];
  const known = sub ? SUITE_FLAGS[sub] : undefined;
  const unknown = known
    ? args.slice(1).find((a, i, rest) => a.startsWith('-') && !known.includes(a) && rest[i - 1] !== '--suite')
    : undefined;
  if (unknown) {
    process.stderr.write(`swipium suite ${sub}: unknown option ${unknown}\n\n${SUITE_USAGE}`);
    process.exitCode = 2;
    return;
  }
  // The positional projectRoot: skip flags and the value that follows --suite.
  const root = resolveRoot(args.find((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--suite'));
  if (sub && sub !== 'init' && !existsSync(root)) {
    process.stdout.write(`Project root not found: ${root}\n`);
    process.exitCode = 2;
    return;
  }

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
    // Exit codes: 0 clean (warnings allowed), 1 errors, or any finding with --strict; 2 no suite.
    const strict = args.includes('--strict');
    process.exitCode = res.items.some((i) => i.severity === 'error' || strict) ? 1 : 0;
    return;
  }

  if (sub === 'compile') {
    const suiteRel = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : undefined;
    const r = compileToFlows(root, suiteRel, args.includes('--force'));
    r.lines.forEach((l) => process.stdout.write(l + '\n'));
    process.exitCode = r.ok && r.slugs.length ? 0 : 2;
    return;
  }

  if (sub === 'init') {
    process.stdout.write(
      [
        'Swipium suites are generated from a recorded run (durable selectors > guesswork):',
        '  1. Start the MCP server and a session (qa_start_session).',
        '  2. Drive the app with qa_act (or qa_smoke). Every action is recorded.',
        '  3. qa_generate target:"suite" writes .swipium/{pages,tests,suites,testcases,locators}.',
        '  4. swipium suite lint: audit locator durability before committing.',
        '  5. swipium suite compile: POM > runnable Flow V2 under .swipium/flows.',
        '  6. Execute compiled flows through qa_flow_run from an MCP session.',
        '',
      ].join('\n'),
    );
    process.exitCode = 0;
    return;
  }

  process.stdout.write(SUITE_USAGE);
  process.exitCode = 2;
}
