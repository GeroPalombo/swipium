// `swipium report`: render a persisted Swipium session report as a CI artifact, WITHOUT an agent.
//
// An agent (Claude Code headless, etc.) drives the device through the MCP server and calls
// qa_report; that persists a deep-redacted report JSON as a session artifact under
// ~/.swipium/runs/<project-hash>/<session>/report/. This command finds that report for the
// project, renders junit | sarif | github-summary | markdown | json with the same exporters
// qa_report uses, and (with --fail-on-gate) turns the release-gate policy
// (.swipium/policy.json blockOn/warnOn/ignoreKnown) into the process exit code.
//
// Exit codes: 0 = written (gate passed or not checked), 1 = --fail-on-gate and the gate blocks,
// 2 = usage error / no persisted report found. runReport() returns the code; it never exits.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { reportPolicyVerdicts, toGithubSummary, toJUnit, toMarkdown, toSarif, type ReportData } from '../report/export.js';
import { applyPolicy, loadPolicy as loadReleasePolicy, policyFileProblem, policyUnknownKeys } from '../report/policy.js';
import { loadReport } from '../report/history.js';
import { resolveSarifSources } from '../report/sarifSources.js';

export const REPORT_FORMATS = ['junit', 'sarif', 'github-summary', 'markdown', 'json'] as const;
export type CliReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_USAGE = `Usage: swipium report --format <junit|sarif|github-summary|markdown|json> [options]

Render the report a Swipium session already produced (via the qa_report MCP tool) as a CI file.
Needs no device and no agent, only the session state Swipium persisted under ~/.swipium/runs.

Options:
  --format <fmt>     junit | sarif | github-summary | markdown | json   (required)
  --root <dir>       project root the session ran against (default: current directory)
  --session <id>     use this session id
  --latest           use the most recent session for the project that has a report (default)
  --report <file>    render this report JSON file directly (skips session lookup)
  --out <file>       write to a file instead of stdout (parent dirs are created)
  --max-age <min>    refuse (exit 2) a report older than this many minutes, so CI never publishes a
                     stale report from an earlier run when the agent step produced none
  --fail-on-gate     exit 1 when the release-gate policy (.swipium/policy.json) blocks
  -h, --help         show this help

Exit codes: 0 ok · 1 release gate blocked (with --fail-on-gate) · 2 usage error / invalid
.swipium/policy.json / no (fresh enough) report found.
`;

export interface ReportCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const defaultIo: ReportCliIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

interface ParsedArgs {
  format?: string;
  root?: string;
  session?: string;
  report?: string;
  out?: string;
  maxAge?: string;
  failOnGate: boolean;
  help: boolean;
  error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { failOnGate: false, help: false };
  const valueFlags: Record<string, keyof ParsedArgs> = {
    '--format': 'format',
    '--root': 'root',
    '--session': 'session',
    '--report': 'report',
    '--out': 'out',
    '--max-age': 'maxAge',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (flag === '-h' || flag === '--help') out.help = true;
    else if (flag === '--fail-on-gate') out.failOnGate = true;
    else if (flag === '--latest') out.session = undefined;
    else if (flag in valueFlags) {
      const value = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : args[++i];
      if (value === undefined || value.startsWith('--')) return { ...out, error: `${flag} needs a value` };
      (out as unknown as Record<string, unknown>)[valueFlags[flag]] = value;
    } else return { ...out, error: `Unknown argument: ${a}` };
  }
  return out;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

interface SessionCandidate {
  id: string;
  dir: string;
  createdAt: number;
  reportPath?: string;
}

/** Newest persisted report JSON of a session (the qa_report "report" artifact, not an export). */
function latestReportJson(
  dir: string,
  state: { artifacts?: Array<{ kind?: string; mime?: string; path?: string; createdAt?: number }> },
): string | undefined {
  const isReportJson = (p: string) => /(^|[\\/])report-\d+\.json$/.test(p);
  const fromState = (state.artifacts ?? [])
    .filter((a) => a.kind === 'report' && a.mime === 'application/json' && a.path && isReportJson(a.path) && existsSync(a.path))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  if (fromState.length) return fromState[fromState.length - 1].path;
  const reportDir = join(dir, 'report');
  if (!existsSync(reportDir)) return undefined;
  const files = readdirSync(reportDir)
    .filter((f) => isReportJson(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  return files.length ? join(reportDir, files[files.length - 1]) : undefined;
}

/**
 * Sessions persisted for `root`: the registry (~/.swipium/registry.json, which also covers custom
 * session dirs) plus a scan of the default per-project runs dir (the registry is capped). A session
 * belongs to the project when its state.json `root` resolves to the same directory.
 */
export function findProjectSessions(root: string, home = homedir()): SessionCandidate[] {
  const base = join(home, '.swipium');
  const dirs = new Set<string>();
  try {
    const reg = JSON.parse(readFileSync(join(base, 'registry.json'), 'utf8')) as Array<{ dir?: string }>;
    for (const e of reg) if (typeof e.dir === 'string') dirs.add(e.dir);
  } catch {
    /* no registry yet */
  }
  // Mirrors SessionStore's default session dir: ~/.swipium/runs/<sha256(resolve(root))[:16]>/<id>.
  const projectRuns = join(base, 'runs', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16));
  try {
    for (const d of readdirSync(projectRuns, { withFileTypes: true })) if (d.isDirectory()) dirs.add(join(projectRuns, d.name));
  } catch {
    /* no runs for this project */
  }
  const want = canonical(root);
  const out: SessionCandidate[] = [];
  for (const dir of dirs) {
    try {
      const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
        id?: string;
        root?: string;
        createdAt?: number;
        artifacts?: Array<{ kind?: string; mime?: string; path?: string; createdAt?: number }>;
      };
      if (typeof st.id !== 'string' || typeof st.root !== 'string' || canonical(st.root) !== want) continue;
      out.push({ id: st.id, dir, createdAt: st.createdAt ?? 0, reportPath: latestReportJson(dir, st) });
    } catch {
      /* unreadable / partial session: skip */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** When a report JSON was saved: the `report-<ms>.json` timestamp, else the file's mtime. */
function reportSavedAt(path: string): number | undefined {
  const ms = Number(path.match(/report-(\d{12,})\.json$/)?.[1]);
  if (Number.isFinite(ms) && ms > 0) return ms;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Render one format from a (persisted, already-redacted) report. Exported for tests. */
export function renderReport(data: ReportData, format: CliReportFormat, root: string): { body: string; block: boolean; reason: string } {
  const policy = applyPolicy(reportPolicyVerdicts(data), loadReleasePolicy(root));
  const body =
    format === 'junit'
      ? toJUnit(data, policy)
      : format === 'sarif'
        ? toSarif(data, policy, { sources: resolveSarifSources(root, data) })
        : format === 'github-summary'
          ? toGithubSummary(data, policy)
          : format === 'markdown'
            ? toMarkdown(data)
            : JSON.stringify({ ...data, releaseGate: policy }, null, 2);
  return { body, block: policy.block, reason: policy.reason };
}

export async function runReport(args: string[], io: ReportCliIo = defaultIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    io.stdout(REPORT_USAGE);
    return 0;
  }
  if (parsed.error) {
    io.stderr(`${parsed.error}\n\n${REPORT_USAGE}`);
    return 2;
  }
  if (!parsed.format || !(REPORT_FORMATS as readonly string[]).includes(parsed.format)) {
    io.stderr(`${parsed.format ? `Unknown --format "${parsed.format}"` : '--format is required'}\n\n${REPORT_USAGE}`);
    return 2;
  }
  const format = parsed.format as CliReportFormat;
  const maxAgeMin = parsed.maxAge === undefined ? undefined : Number(parsed.maxAge);
  if (maxAgeMin !== undefined && !(Number.isFinite(maxAgeMin) && maxAgeMin > 0)) {
    io.stderr(`--max-age needs a positive number of minutes (got "${parsed.maxAge}")\n\n${REPORT_USAGE}`);
    return 2;
  }
  const cwd = process.cwd();
  const root = parsed.root ? (isAbsolute(parsed.root) ? parsed.root : join(cwd, parsed.root)) : cwd;

  let reportPath: string | undefined;
  if (parsed.report) {
    reportPath = isAbsolute(parsed.report) ? parsed.report : join(cwd, parsed.report);
    if (!existsSync(reportPath)) {
      io.stderr(`Report file not found: ${reportPath}\n`);
      return 2;
    }
  } else {
    const sessions = findProjectSessions(root);
    const pick = parsed.session ? sessions.find((s) => s.id === parsed.session) : [...sessions].reverse().find((s) => s.reportPath);
    // Say so when newer sessions exist that never saved a report (the latest agent step
    // may have failed before qa_report), instead of silently rendering an older run.
    const newerWithoutReport = pick && !parsed.session ? sessions.filter((s) => s.createdAt > pick.createdAt && !s.reportPath) : [];
    if (newerWithoutReport.length) {
      io.stderr(
        `Warning: ${newerWithoutReport.length} newer session(s) (${newerWithoutReport
          .map((s) => s.id)
          .slice(-3)
          .join(', ')}) saved no report; rendering the older session ${pick!.id}.\n`,
      );
    }
    if (!pick) {
      io.stderr(
        parsed.session
          ? `No persisted Swipium session "${parsed.session}" for project ${root}.\n`
          : `No Swipium session with a report found for project ${root} (looked in ${join(homedir(), '.swipium')}).\n` +
              'Run the agent step first and make sure it calls qa_report (any format) before the session ends.\n',
      );
      return 2;
    }
    if (!pick.reportPath) {
      io.stderr(`Session ${pick.id} has no persisted report yet. Call qa_report for it first.\n`);
      return 2;
    }
    reportPath = pick.reportPath;
  }

  // Freshness. Every run prints when its report was saved; --max-age refuses a stale one.
  const savedAt = reportSavedAt(reportPath);
  if (maxAgeMin !== undefined && (savedAt === undefined || Date.now() - savedAt > maxAgeMin * 60_000)) {
    io.stderr(
      `Report ${reportPath} is older than --max-age ${maxAgeMin} min (saved ${savedAt ? new Date(savedAt).toISOString() : 'at an unknown time'}). ` +
        'The agent step probably produced no report this run; make sure it calls qa_report.\n',
    );
    return 2;
  }

  // An invalid policy is a usage error (exit 2), never a crash read as "gate blocks" (exit 1).
  const policyProblem = policyFileProblem(root);
  if (policyProblem) {
    io.stderr(
      `❌ INVALID_ARGUMENT: ${join(root, '.swipium', 'policy.json')} ${policyProblem}. Fix it (see docs/ci-reports.md "Release-gate policy") or remove it.\n`,
    );
    return 2;
  }
  // A typo'd key is ignored by the gate; say so instead of silently gating without it.
  const unknownPolicyKeys = policyUnknownKeys(root);
  if (unknownPolicyKeys.length) {
    io.stderr(
      `⚠ ${join(root, '.swipium', 'policy.json')}: unknown key(s) ${unknownPolicyKeys.map((k) => JSON.stringify(k)).join(', ')} ignored. Known keys: blockOn, warnOn, ignoreKnown, ciAllowMutations.\n`,
    );
  }

  let data: ReportData;
  try {
    data = loadReport(reportPath);
  } catch (e) {
    io.stderr(`Could not read report ${reportPath}: ${String((e as Error).message ?? e)}\n`);
    return 2;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.findings) || !Array.isArray(data.testOutcomes)) {
    io.stderr(`${reportPath} is not a Swipium report JSON (missing findings/testOutcomes).\n`);
    return 2;
  }

  let rendered: ReturnType<typeof renderReport>;
  try {
    rendered = renderReport(data, format, root);
  } catch (e) {
    io.stderr(`Could not render ${format} from ${reportPath}: ${String((e as Error).message ?? e)}\n`);
    return 2;
  }
  const { body, block, reason } = rendered;
  if (parsed.out) {
    const outPath = isAbsolute(parsed.out) ? parsed.out : join(cwd, parsed.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body.endsWith('\n') ? body : `${body}\n`);
    io.stderr(`Wrote ${format} for session ${data.sessionId} > ${outPath}\n`);
  } else {
    io.stdout(body.endsWith('\n') ? body : `${body}\n`);
  }
  io.stderr(
    `Release gate: ${block ? 'BLOCK' : 'PASS'}: ${reason} (session ${data.sessionId}, report saved ${savedAt ? new Date(savedAt).toISOString() : 'unknown'})\n`,
  );
  return parsed.failOnGate && block ? 1 : 0;
}
