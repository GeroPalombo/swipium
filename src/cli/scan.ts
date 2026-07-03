// `swipium scan [path]` (PHASE3-PLAN §3.1) — inspect a project and scaffold its .swipium/.
// Writes .swipium/config.json (generated, overwritten), and scaffolds .swipium/fixtures.json
// (only if absent — never clobbers user fixtures) and .swipium/flows/. Ends with a clear
// ready | partial | blocked summary and the exact missing items.
// Pass --check / --dry-run / --no-write to inspect without writing project files.
//
// CLI path, not the MCP server — writing to stdout is fine here, and defaulting to cwd is
// fine (the no-cwd rule is for the stdio server, which has no meaningful working directory).

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanProject } from '../context/scan.js';

const FIXTURES_TEMPLATE = {
  _doc: 'Declared preconditions for QA runs. An unmet requiredState reads as "blocked + setup", not a failure. A fixture with a testAccount (or a login/auth name) marks credentials available for login_smoke.',
  fixtures: [] as unknown[],
};

const FLOWS_README = `# Swipium flows

Put repeatable tests here as \`*.yaml\`. Each flow is picked up by \`swipium plan\` and
\`qa_plan\` as a candidate workflow.
`;

export async function runScan(args: string[]): Promise<void> {
  const write = !args.some((arg) => arg === '--check' || arg === '--dry-run' || arg === '--no-write');
  const rootArg = args.find((arg) => arg.trim() && !arg.startsWith('--'));
  const root = resolve(rootArg?.trim() || process.cwd());
  if (!existsSync(root)) {
    process.stdout.write(`Path not found: ${root}\n`);
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`Scanning ${root} …\n`);
  const scan = await scanProject(root);

  const swipiumDir = join(root, '.swipium');
  const configPath = join(swipiumDir, 'config.json');
  const fixturesPath = join(swipiumDir, 'fixtures.json');
  const flowsDir = join(swipiumDir, 'flows');
  const fixturesNote = existsSync(fixturesPath) ? 'kept existing' : 'created (empty template)';
  if (write) {
    mkdirSync(swipiumDir, { recursive: true });

    // config.json — generated artifact, always refreshed.
    writeFileSync(configPath, JSON.stringify(scan, null, 2));

    // fixtures.json — scaffold only if absent (don't clobber the user's declared preconditions).
    if (!existsSync(fixturesPath)) {
      writeFileSync(fixturesPath, JSON.stringify(FIXTURES_TEMPLATE, null, 2));
    }

    // flows/ — scaffold the directory + a README if empty.
    mkdirSync(flowsDir, { recursive: true });
    mkdirSync(join(swipiumDir, 'packs'), { recursive: true }); // flow packs (release suites)
    const flowsReadme = join(flowsDir, 'README.md');
    if (!existsSync(flowsReadme)) writeFileSync(flowsReadme, FLOWS_README);
  }

  const icon = scan.readiness === 'ready' ? '✅' : scan.readiness === 'partial' ? '⚠️' : '⛔';
  const lines = [
    '',
    `${icon} ${scan.readiness.toUpperCase()}`,
    `framework: ${scan.framework}${scan.monorepo ? ' (monorepo — pick a target)' : ''}`,
    `appId: ${scan.appId ?? 'unknown'}${scan.appIdSource ? ` (via ${scan.appIdSource})` : ''}`,
    `artifacts: ${scan.apks.length} apk, ${scan.ipas.length} ipa, ${scan.appBundles.length} .app${scan.installed === true ? ' · app installed' : scan.installed === false ? ' · app NOT installed' : ''}`,
    `devices: online=[${scan.devices.androidOnline.join(', ')}] avds=[${scan.devices.avds.join(', ')}]`,
    `metro needed: ${scan.metroNeed}  ·  fresh_start safe: ${scan.freshStartSafe}  ·  likely auth: ${scan.likelyAuth}${scan.authSignals.length ? ` (${scan.authSignals.join(', ')})` : ''}`,
    `recommended profile: ${scan.recommendedProfile}`,
  ];
  if (scan.missing.length) {
    lines.push('', 'to fix:');
    for (const m of scan.missing) lines.push(` - ${m}`);
  }
  lines.push(
    '',
    write ? `wrote:  ${configPath}` : `check mode: no files written`,
    write ? `        ${fixturesPath} (${fixturesNote})` : `would write: ${configPath}`,
    write ? `        ${flowsDir}/` : `             ${fixturesPath} (${fixturesNote})`,
    ...(write ? [] : [`             ${flowsDir}/`]),
    `git scope: not touched (Swipium never edits .gitignore or runs Git)`,
    '',
    write
      ? 'Next: run `swipium plan` for READY/BLOCKED/UNSAFE workflows, or in an agent call qa_start_session then qa_plan.'
      : 'Next: rerun without --check when you are ready to create Swipium project files, or use qa_detect_context for read-only MCP inspection.',
    '',
  );
  process.stdout.write(lines.join('\n'));
}

/** Read a previously generated .swipium/config.json, if present. Used by qa_start_session. */
export function loadProjectConfig(root: string): Record<string, unknown> | null {
  const p = join(root, '.swipium', 'config.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
