// `swipium scan [path]`: inspect a project and scaffold its .swipium/.
// Merges the scan result into .swipium/config.json (generated keys are refreshed; the user's own keys
// such as ios.wda.*, ocrCommand, visualMaskCommand are kept, SET-1), and scaffolds .swipium/fixtures.json
// (only if absent, never clobbers user fixtures) and .swipium/flows/. Ends with a clear
// ready | partial | blocked summary and the exact missing items.
// Pass --check / --dry-run / --no-write to inspect without writing project files. Nothing is
// written when the project is BLOCKED (a scaffold for a non-app directory is just litter), nor
// on --help.
//
// CLI path, not the MCP server, so writing to stdout is fine here, and defaulting to cwd is
// fine (the no-cwd rule is for the stdio server, which has no meaningful working directory).

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanProject, type ProjectScan } from '../context/scan.js';

const FIXTURES_TEMPLATE = {
  _doc: 'Declared preconditions for QA runs. An unmet requiredState reads as "blocked + setup", not a failure. A fixture with a testAccount (or a login/auth name) marks credentials available for login_smoke.',
  fixtures: [] as unknown[],
};

const FLOWS_README = `# Swipium flows

Put repeatable tests here as \`*.yaml\`. Each flow is picked up by \`qa_resolve_target include:["plan"]\` as a candidate
workflow; validate one with \`qa_flow_check\` and run it with \`qa_flow_run\` from an MCP session.
`;

export const SCAN_USAGE = [
  'Usage: swipium scan [path] [--check | --dry-run | --no-write]',
  '',
  'Inspect a mobile app project (default: current directory) and print READY / PARTIAL / BLOCKED',
  'with the exact missing items. When not BLOCKED it scaffolds .swipium/ (the scan result is merged',
  'into config.json, keeping your own keys; fixtures.json and flows/ are created only if absent).',
  'Exit status: 0 READY/PARTIAL, 1 BLOCKED, 2 bad path/usage.',
  '',
  '  --check, --dry-run, --no-write   inspect only; write no files',
  '  -h, --help                       show this help',
  '',
].join('\n');

/** A previous config.json appId that the scan must keep: a non-empty appId that differs from the
 *  detected one and that the user set (README promises scan keeps it). An appId whose appIdSource
 *  names a scan source (app.json, gradle, Info.plist, apk-badging) was written by an earlier scan, so
 *  it is refreshed instead of going stale when the app id changes, unless it no longer equals the
 *  `scanAppId` that scan stored next to it (the user hand-edited appId and kept appIdSource).
 *  Null when there is none. */
export function keptConfigAppId(prev: Record<string, unknown> | null, scan: ProjectScan): string | null {
  const prevId = prev && typeof prev.appId === 'string' ? prev.appId.trim() : '';
  const source = prev?.appIdSource;
  const handEdited = typeof prev?.scanAppId === 'string' && prev.scanAppId !== prevId;
  const userSet = source === undefined || source === null || source === 'config.json' || handEdited;
  return prevId && userSet && prevId !== scan.appId ? prevId : null;
}

/** An appId from an earlier scan that this scan replaces (written by scan, now detected differently).
 *  Printed so a hand edit in an older config (no scanAppId yet) is never replaced silently. */
export function replacedScanAppId(prev: Record<string, unknown> | null, scan: ProjectScan): string | null {
  const prevId = prev && typeof prev.appId === 'string' ? prev.appId.trim() : '';
  return prevId && scan.appId && prevId !== scan.appId && !keptConfigAppId(prev, scan) ? prevId : null;
}

/** Merge a fresh scan into an existing config.json object: scan (generated) keys are refreshed,
 *  every other key is the user's and is kept; a user-set appId survives the scan too (SET-1).
 *  `scanAppId` records what the scan detected, so a later hand edit of appId is recognized. */
export function mergeScanIntoConfig(prev: Record<string, unknown> | null, scan: ProjectScan): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(prev ?? {}), ...scan, scanAppId: scan.appId };
  const keptAppId = keptConfigAppId(prev, scan);
  if (keptAppId) {
    merged.appId = keptAppId;
    merged.appIdSource = 'config.json';
  }
  return merged;
}

/** Existing config.json: `{ value }` (null when absent) or `{ error }` when it is not a JSON object. */
function readExistingConfig(p: string): { value: Record<string, unknown> | null; error?: string } {
  if (!existsSync(p)) return { value: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null, error: 'not a JSON object' };
    return { value: parsed as Record<string, unknown> };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run `swipium scan`; returns the process exit code (0 ready/partial, 1 blocked, 2 bad path/usage). */
export async function runScan(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(SCAN_USAGE);
    return 0;
  }
  const unknown = args.find((arg) => arg.startsWith('-') && !['--check', '--dry-run', '--no-write'].includes(arg));
  if (unknown) {
    process.stderr.write(`swipium scan: unknown option ${unknown}\n\n${SCAN_USAGE}`);
    return 2;
  }
  const checkOnly = args.some((arg) => arg === '--check' || arg === '--dry-run' || arg === '--no-write');
  const rootArg = args.find((arg) => arg.trim() && !arg.startsWith('-'));
  const root = resolve(rootArg?.trim() || process.cwd());
  if (!existsSync(root)) {
    process.stdout.write(`Path not found: ${root}\n`);
    return 2;
  }

  process.stdout.write(`Scanning ${root} …\n`);
  const scan = await scanProject(root);
  const blocked = scan.readiness === 'blocked';
  const write = !checkOnly && !blocked;

  const swipiumDir = join(root, '.swipium');
  const configPath = join(swipiumDir, 'config.json');
  const fixturesPath = join(swipiumDir, 'fixtures.json');
  const flowsDir = join(swipiumDir, 'flows');
  const fixturesNote = existsSync(fixturesPath) ? 'kept existing' : 'created (empty template)';
  const existing = readExistingConfig(configPath);
  const keptAppId = keptConfigAppId(existing.value, scan);
  const replacedAppId = replacedScanAppId(existing.value, scan);
  const userKeys = existing.value
    ? Object.keys(existing.value).filter((k) => k !== 'scanAppId' && (!(k in scan) || (k === 'appId' && keptAppId)))
    : [];
  const configNote = existing.error
    ? `left unchanged: it is not valid JSON (${existing.error}); fix it and rerun`
    : existing.value
      ? `scan result merged${userKeys.length ? `, kept your keys: ${userKeys.join(', ')}` : ''}`
      : 'created';
  if (write) {
    mkdirSync(swipiumDir, { recursive: true });

    // config.json: the scan result is MERGED in (SET-1). It is also the user's configuration
    // (ios.wda.*, ocrCommand, visualMaskCommand…, read via loadProjectConfig), so their keys are kept,
    // and a file that doesn't parse is never overwritten.
    if (!existing.error) writeFileSync(configPath, JSON.stringify(mergeScanIntoConfig(existing.value, scan), null, 2));

    // fixtures.json: scaffold only if absent (don't clobber the user's declared preconditions).
    if (!existsSync(fixturesPath)) {
      writeFileSync(fixturesPath, JSON.stringify(FIXTURES_TEMPLATE, null, 2));
    }

    // flows/: scaffold the directory + a README if empty.
    mkdirSync(flowsDir, { recursive: true });
    mkdirSync(join(swipiumDir, 'packs'), { recursive: true }); // flow packs (release suites)
    const flowsReadme = join(flowsDir, 'README.md');
    if (!existsSync(flowsReadme)) writeFileSync(flowsReadme, FLOWS_README);
  }

  const icon = scan.readiness === 'ready' ? '✅' : scan.readiness === 'partial' ? '⚠️' : '⛔';
  const lines = [
    '',
    `${icon} ${scan.readiness.toUpperCase()}`,
    `framework: ${scan.framework}${scan.monorepo ? ' (monorepo, pick a target)' : ''}`,
    keptAppId
      ? `appId: ${keptAppId} (kept from config.json${scan.appId ? `; scan detected ${scan.appId}, remove appId from config.json to use it` : ''})`
      : `appId: ${scan.appId ?? 'unknown'}${scan.appIdSource ? ` (via ${scan.appIdSource})` : ''}${
          replacedAppId && write && !existing.error
            ? `; replaced appId ${replacedAppId} in config.json (written by an earlier scan from ${String(existing.value?.appIdSource)}; to keep your own appId, remove appIdSource)`
            : ''
        }`,
    `artifacts: ${scan.apks.length} apk, ${scan.ipas.length} ipa, ${scan.appBundles.length} .app${scan.installed === true ? ' · app installed' : scan.installed === false ? ' · app NOT installed' : ''}`,
    `devices: online=[${scan.devices.androidOnline.join(', ')}] avds=[${scan.devices.avds.join(', ')}]`,
    `metro needed: ${scan.metroNeed}  ·  fresh_start safe: ${scan.freshStartSafe}  ·  likely auth: ${scan.likelyAuth}${scan.authSignals.length ? ` (${scan.authSignals.join(', ')})` : ''}`,
    `recommended profile: ${scan.recommendedProfile}`,
  ];
  if (scan.missing.length) {
    lines.push('', scan.readiness === 'blocked' ? 'to fix:' : 'notes:');
    // The shared detector speaks MCP ("projectRoot"); on the CLI the root is the scan path.
    const cliHint = 'Point scan at your app directory (`swipium scan <path>`)';
    for (const m of scan.missing) lines.push(` - ${m.replace(/Pass (an explicit projectRoot|the app directory as projectRoot)/, cliHint)}`);
  }
  lines.push(
    '',
    ...(write
      ? [
          `${existing.error ? 'skipped:' : 'wrote: '} ${configPath} (${configNote})`,
          `${existing.error ? 'wrote:  ' : '        '}${fixturesPath} (${fixturesNote})`,
          `        ${flowsDir}/`,
        ]
      : blocked
        ? ['blocked: no files written']
        : [
            'check mode: no files written',
            `would write: ${configPath} (${configNote})`,
            `             ${fixturesPath} (${fixturesNote})`,
            `             ${flowsDir}/`,
          ]),
    `git scope: scan does not edit .gitignore (Swipium adds .swipium/ to a Git repo's .gitignore the first time it writes the app map or issue ledger)`,
    '',
    write
      ? 'Next: in your agent, call qa_test_this { mode: "execute" }, or qa_start_session, then qa_resolve_target { sessionId, include: ["plan"] } for READY/BLOCKED/UNSAFE workflows.'
      : blocked
        ? 'Next: fix the items above and rerun `swipium scan` (or point it at your app directory: `swipium scan <path>`).'
        : 'Next: rerun without --check when you are ready to create Swipium project files, or use qa_resolve_target { include: ["context"] } for read-only MCP inspection.',
    '',
  );
  process.stdout.write(lines.join('\n'));
  return blocked ? 1 : 0;
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
