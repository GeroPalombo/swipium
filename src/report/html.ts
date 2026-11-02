// report.html: the one file a human opens. Self-contained (inline CSS, images as data: URIs, no JS,
// strict meta CSP), rendered from the already-redacted report. Failure-first: the verdict, then what
// broke with its screenshot and log, then outcomes, the step timeline, environment and artifacts.
// A run that never got to test anything gets a short layout: blocker, fix, log tail, timeline.

import { isAbsolute } from 'node:path';
import { downscalePng } from '../lib/png.js';
import { artifactDirectoryName, decodeUriSegment } from '../session/store.js';
import { latestAttempts, reportPolicyVerdicts, type ReportData, type ReportFinding, type ReportNote, type ReportStep } from './export.js';
import { pickNotTestedLog, readLogTail, readRegularFile, resolveSessionFile } from './logTail.js';
import { applyPolicy, loadPolicy, type PolicyDecision } from './policy.js';

/** The only origin report.html links to. Everything else is an in-page #anchor. */
export const DOCS_ORIGIN = 'https://github.com/GeroPalombo/swipium';
const DOCS_URL = `${DOCS_ORIGIN}/blob/main/docs/concepts.md`;

export const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
/** Total base64 bytes of embedded thumbnails. Past it, images are listed as paths instead. */
export const HTML_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;
const THUMB_WIDTH = 480;
/** Never read a "screenshot" bigger than this into memory just to thumbnail it. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const LOG_TAIL_LINES = 40;
/** Shorter tail on a failed outcome card: it sits next to the screenshot. */
const OUTCOME_LOG_TAIL_LINES = 20;

export interface RenderHtmlOptions {
  /** Session folder; artifact paths resolve against it. Without it images show "evidence not available". */
  sessionDir?: string;
  /** Release-gate decision already computed by the caller (the CLI does this). */
  policy?: PolicyDecision;
  /** Project root: load .swipium/policy.json from here when no `policy` is passed. */
  root?: string;
  /** Override the embedded image budget (tests). */
  imageBudgetBytes?: number;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escapeHtml;

type Artifact = ReportData['artifacts'][number];

/** Where an artifact lives, relative to the session folder (for display), if we can tell. */
function relativeArtifactPath(uri: string, art: Artifact | undefined): string | undefined {
  if (art?.path && !isAbsolute(art.path)) return art.path;
  const m = /^swipium:\/\/session\/[^/]+\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m) return undefined;
  const kind = decodeUriSegment(m[1]);
  const name = decodeUriSegment(m[2]);
  // A name that could walk out of the folder is not a path we will show or open.
  if (/[\\/]/.test(name) || name.includes('..') || /[\\/]/.test(kind) || kind.includes('..')) return undefined;
  return `${artifactDirectoryName(kind)}/${name}`;
}

/** Absolute file for an artifact URI, only when it is a regular file in an artifact subfolder of
 *  the session folder. The report JSON is untrusted, so both its `path` and the URI go through
 *  resolveSessionFile (no dotfiles, no `..`, no symlinks out, no FIFOs or devices). */
function resolveArtifactFile(uri: string, art: Artifact | undefined, sessionDir?: string): string | undefined {
  if (!sessionDir) return undefined;
  for (const c of [art?.path, relativeArtifactPath(uri, art)]) {
    const file = c ? resolveSessionFile(sessionDir, c) : undefined;
    if (file) return file;
  }
  return undefined;
}

const isImageUri = (uri: string, art?: Artifact) => /\.png$/i.test(uri) || art?.kind === 'screenshot' || art?.kind === 'checkpoint';

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Embeds thumbnails in render order (failures first, then outcome checkpoints, then the timeline),
 *  so the budget always goes to the most useful pictures. Each image is embedded once; later
 *  mentions link back to it. */
class ImageEmbedder {
  private used = 0;
  private seen = new Map<string, string>(); // uri > anchor id of its first embed
  private settled = new Map<string, string>(); // uri > html already decided (failed or over budget)
  private exhausted = false;
  private count = 0;
  overBudget = 0;

  constructor(
    private readonly byUri: Map<string, Artifact>,
    private readonly sessionDir: string | undefined,
    private readonly budget: number,
  ) {}

  /** HTML for one evidence image: a thumbnail, a link back to an earlier one, or a plain-text path. */
  async render(uri: string | undefined, alt: string): Promise<string> {
    if (!uri) return '';
    const art = this.byUri.get(uri);
    const rel = relativeArtifactPath(uri, art);
    const label = `<code>${esc(rel ?? uri)}</code>`;
    if (!isImageUri(uri, art)) return `<span class="file">${label}</span>`;
    const prior = this.seen.get(uri);
    if (prior) return `<a class="thumb-ref" href="#${prior}">screenshot above</a>`;
    const settled = this.settled.get(uri);
    if (settled) return settled;
    const file = resolveArtifactFile(uri, art, this.sessionDir);
    if (!file) return `<span class="missing">evidence not available</span> <span class="file">${label}</span>`;
    const overBudget = `<span class="file">${label} (not embedded: report image budget of ${Math.round(this.budget / 1024 / 1024)} MB reached)</span>`;
    // Budget spent: don't read or decode the rest just to throw the result away.
    if (this.exhausted) return this.settle(uri, overBudget, true);
    let png: Buffer | null = null;
    const src = readRegularFile(file, MAX_SOURCE_BYTES);
    if (src) png = downscalePng(src.buf, THUMB_WIDTH);
    await yieldToLoop();
    if (!png) return this.settle(uri, `<span class="file">${label} (could not embed this image)</span>`, false);
    const b64 = png.toString('base64');
    if (this.used + b64.length > this.budget) {
      this.exhausted = true;
      return this.settle(uri, overBudget, true);
    }
    this.used += b64.length;
    const id = `ev-${++this.count}`;
    this.seen.set(uri, id);
    return `<img id="${id}" class="thumb" alt="${esc(alt)}" src="data:image/png;base64,${b64}">`;
  }

  private settle(uri: string, html: string, overBudget: boolean): string {
    if (overBudget) this.overBudget++;
    this.settled.set(uri, html);
    return html;
  }
}

interface Gate {
  verdict: string;
  tone: 'bad' | 'warn' | 'good';
  reason: string;
}

function gateFor(r: ReportData, opts: RenderHtmlOptions): Gate {
  const policy = opts.policy ?? (opts.root ? applyPolicy(reportPolicyVerdicts(r), loadPolicy(opts.root)) : undefined);
  if (policy) {
    const tone = policy.block ? 'bad' : policy.warned.length ? 'warn' : 'good';
    return { verdict: policy.block ? 'BLOCK' : 'PASS', tone, reason: policy.reason };
  }
  const risk = r.executiveSummary?.risk ?? 'unknown';
  const verdict = risk === 'block' ? 'BLOCK' : risk === 'caution' ? 'CAUTION' : risk === 'ship' ? 'SHIP' : risk.toUpperCase();
  const tone = risk === 'block' ? 'bad' : risk === 'caution' ? 'warn' : 'good';
  return { verdict, tone, reason: r.executiveSummary?.reasons?.[0] ?? r.executiveSummary?.nextAction ?? '' };
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

const RESULT_CLASS: Record<string, string> = { ok: 'good', pass: 'good', failed: 'bad', fail: 'bad', blocked: 'warn' };

function outcomeFlags(n: ReportNote): string[] {
  const flags: string[] = [];
  if (n.outcome === 'pass' && n.unverified) flags.push('unverified');
  if (n.contradicted) flags.push('contradicted');
  if (n.flaky) flags.push(`flaky (attempts: ${[...(n.attempts ?? []).map((a) => a.outcome), n.outcome].join(', ')})`);
  else if (n.attempts?.length) flags.push(`${n.attempts.length + 1} attempts`);
  return flags;
}

const evidenceUris = (n: ReportNote): string[] => (n.evidence?.length ? n.evidence : (n.artifactUris ?? []));

/** The failing step of an outcome: a failed timeline step inside its range, else its own flow step. */
function failingStep(n: ReportNote, steps: ReportStep[]): { label: string; failureCode?: string; screenshotUri?: string } | undefined {
  if (n.stepRange) {
    const [from, to] = n.stepRange;
    const s = steps.find((x) => x.i >= from && x.i <= to && x.result === 'failed');
    if (s) return { label: `#${s.i} ${s.target ?? s.action}`, failureCode: s.failureCode, screenshotUri: s.screenshotUri };
  }
  const fs = n.steps?.find((x) => !x.ok);
  if (fs) return { label: `#${fs.index} ${fs.summary ?? fs.kind}`, failureCode: fs.failureCode };
  return undefined;
}

const CRASH_CODES = /^(NATIVE_CRASH|ANR|APP_LAUNCH_FAILED)$/;

/** The log to show on a failed outcome card: a high finding with a log captured during the
 *  outcome's steps, or for a crash/launch failure the crash finding's log. */
function outcomeLogUri(n: ReportNote, code: string | undefined, steps: ReportStep[], findings: ReportFinding[]): string | undefined {
  const withLog = findings.filter((f) => f.severity === 'high' && f.logUri);
  if (!withLog.length) return undefined;
  if (n.stepRange) {
    const [from, to] = n.stepRange;
    const covered = steps.filter((s) => s.i >= from && s.i <= to);
    if (covered.length) {
      // Pad by the step duration both ways: `at` is a timestamp near the step, not a strict start.
      const t0 = Math.min(...covered.map((s) => s.at - (s.durationMs ?? 0)));
      const t1 = Math.max(...covered.map((s) => s.at + (s.durationMs ?? 0)));
      const hit = withLog.find((f) => typeof f.at === 'number' && f.at >= t0 && f.at <= t1);
      if (hit) return hit.logUri;
    }
  }
  if (code && CRASH_CODES.test(code)) {
    return (withLog.find((f) => f.failureCode === code || /crash|anr|launch/i.test(f.kind)) ?? withLog[0]).logUri;
  }
  return undefined;
}

function logTailHtml(
  uri: string | undefined,
  byUri: Map<string, Artifact>,
  sessionDir: string | undefined,
  path?: string,
  n = LOG_TAIL_LINES,
): string {
  if (!uri) return '';
  const art = byUri.get(uri) ?? (path ? ({ uri, kind: 'log', path } as Artifact) : undefined);
  const file = resolveArtifactFile(uri, art, sessionDir);
  const shown = relativeArtifactPath(uri, art) ?? uri;
  const lines = file && sessionDir ? readLogTail(file, sessionDir, n) : undefined;
  if (!lines) return `<p class="muted">log <code>${esc(shown)}</code>: not available</p>`;
  return `<p class="muted">last ${lines.length} lines of <code>${esc(shown)}</code></p><pre class="log">${esc(lines.join('\n'))}</pre>`;
}

const CSS = `
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b636e;--line:#d8dee4;--card:#f6f8fa;--bad:#b42318;--bad-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fff4d6;--good:#1a7f37;--good-bg:#e6f4ea;--code:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa4af;--line:#30363d;--card:#161b22;--bad:#ff7b72;--bad-bg:#3a1513;--warn:#e3b341;--warn-bg:#352a0e;--good:#56d364;--good-bg:#10301a;--code:#1f252d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:1.3rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}
code{background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
pre.log{background:var(--code);padding:10px;border-radius:6px;overflow-x:auto;white-space:pre;max-height:480px}
.banner{border-radius:8px;padding:14px 16px;margin:8px 0 12px;border:1px solid var(--line)}
.banner.bad{background:var(--bad-bg);border-color:var(--bad)}.banner.warn{background:var(--warn-bg);border-color:var(--warn)}.banner.good{background:var(--good-bg);border-color:var(--good)}
.verdict{font-size:1.4rem;font-weight:700}.bad .verdict,.bad-t{color:var(--bad)}.warn .verdict,.warn-t{color:var(--warn)}.good .verdict,.good-t{color:var(--good)}
.partial{font-weight:600;color:var(--warn)}
.muted{color:var(--muted)}.missing{color:var(--muted);font-style:italic}
nav a{margin-right:12px;color:inherit}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0;display:flex;gap:14px;flex-wrap:wrap}
.card .body{flex:1 1 280px;min-width:0}
.card h3{margin:0 0 6px;font-size:1rem;word-break:break-word}
img.thumb{max-width:100%;width:240px;height:auto;border:1px solid var(--line);border-radius:6px;display:block}
td img.thumb{width:120px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}
th{background:var(--card)}
.flag{display:inline-block;font-size:.75rem;padding:0 6px;border-radius:10px;border:1px solid var(--line);margin-left:4px;white-space:nowrap}
.flag.bad{color:var(--bad);border-color:var(--bad)}.flag.warn{color:var(--warn);border-color:var(--warn)}
details>summary{cursor:pointer;font-weight:600;margin:28px 0 8px}
ul{padding-left:20px}li{margin:2px 0;word-break:break-word}
footer{margin-top:32px;font-size:.85rem}footer a{color:inherit}
`;

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body><main>',
    body,
    `<footer class="muted">Generated by Swipium. <a href="${DOCS_URL}">What is in this report</a></footer>`,
    '</main></body>',
    '</html>',
    '',
  ].join('\n');
}

function header(r: ReportData): string {
  const app = r.appId ? esc(r.appId) : '(app not resolved)';
  const device = r.device ? ` on ${esc(r.device)}` : ' (no device bound)';
  return `<h1>Swipium QA report: ${app}</h1><p class="muted">${device.trim()} · session <code>${esc(r.sessionId)}</code></p>`;
}

function partialLine(r: ReportData): string {
  const notice = (r as { releasePolicyNotice?: unknown }).releasePolicyNotice;
  const policy = typeof notice === 'string' && notice ? `<p class="partial">Policy: ${esc(notice)}</p>` : '';
  return (
    (r.partial?.jobId
      ? `<p class="partial">partial: job ${esc(r.partial.jobId)} running${r.partial.kind ? ` (${esc(r.partial.kind)})` : ''}</p>`
      : '') + policy
  );
}

async function timelineHtml(steps: ReportStep[], img: ImageEmbedder, open: boolean): Promise<string> {
  const out: string[] = [`<details id="timeline"${open ? ' open' : ''}><summary>Step timeline (${steps.length} steps)</summary>`];
  if (!steps.length) {
    out.push('<p class="muted">No step timeline in this report (saved before 2.4.0, or no steps ran).</p></details>');
    return out.join('\n');
  }
  out.push(
    '<div class="table-wrap"><table><thead><tr><th>#</th><th>Screen</th><th>Action</th><th>Target</th><th>Result</th><th>Duration</th><th>Code</th></tr></thead><tbody>',
  );
  for (const s of steps) {
    const shot = s.screenshotUri
      ? await img.render(s.screenshotUri, `step ${s.i}`)
      : s.screenshotSkipped
        ? `<span class="muted">screenshot: ${esc(s.screenshotSkipped)}</span>`
        : '';
    const screen = s.screen ? `<div class="muted">${esc(s.screen)}</div>` : '';
    out.push(
      `<tr><td>${esc(s.i)}</td><td>${shot}${screen}</td><td>${esc(s.action)}<div class="muted">${esc(s.source)}</div></td><td>${esc(s.target ?? '')}</td>` +
        `<td class="${RESULT_CLASS[s.result] ?? ''}-t">${esc(s.result)}</td><td>${esc(fmtMs(s.durationMs))}</td><td>${s.failureCode ? `<code>${esc(s.failureCode)}</code>` : ''}</td></tr>`,
    );
  }
  out.push('</tbody></table></div></details>');
  return out.join('\n');
}

async function renderNotTested(
  r: ReportData,
  gate: Gate,
  steps: ReportStep[],
  img: ImageEmbedder,
  byUri: Map<string, Artifact>,
  sessionDir?: string,
): Promise<string> {
  const nt = r.notTested!;
  const out: string[] = [header(r)];
  out.push(
    `<section class="banner bad" id="verdict"><div class="verdict">NOT TESTED</div>` +
      `<p><strong>Blocker:</strong> ${esc(nt.reason)}${nt.failureCode ? ` <code>${esc(nt.failureCode)}</code>` : ''}</p>` +
      `<p><strong>Fix:</strong> ${esc(r.executiveSummary?.nextAction ?? '')}</p>` +
      `<p class="muted">Release gate: ${esc(gate.verdict)}: ${esc(gate.reason)}</p>${partialLine(r)}</section>`,
  );
  out.push('<h2 id="log">Log</h2>');
  const picked = pickNotTestedLog(r);
  out.push(picked ? logTailHtml(picked.uri, byUri, sessionDir, picked.path) : '<p class="muted">no log captured</p>');
  out.push(await timelineHtml(steps, img, true));
  return page(`Swipium: not tested ${r.appId ?? ''}`.trim(), out.join('\n'));
}

/** Render report.html. Async because it yields to the event loop between images. */
export async function renderReportHtml(report: ReportData, opts: RenderHtmlOptions = {}): Promise<string> {
  const r = report;
  const sessionDir = opts.sessionDir;
  const artifacts = Array.isArray(r.artifacts) ? r.artifacts : [];
  const byUri = new Map(artifacts.map((a) => [a.uri, a]));
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const img = new ImageEmbedder(byUri, sessionDir, opts.imageBudgetBytes ?? HTML_IMAGE_BUDGET_BYTES);
  const gate = gateFor(r, opts);

  if (r.notTested) return renderNotTested(r, gate, steps, img, byUri, sessionDir);

  const outcomes = latestAttempts(Array.isArray(r.testOutcomes) ? r.testOutcomes : []);
  const findings: ReportFinding[] = Array.isArray(r.findings) ? r.findings : [];
  const failed = outcomes.filter((n) => n.outcome === 'fail' || n.outcome === 'blocked' || n.contradicted);
  const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortedFindings = [...findings].sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3));
  const anyFailure = gate.tone === 'bad' || failed.length > 0 || steps.some((s) => s.result === 'failed');

  const out: string[] = [header(r)];
  // (1) Banner.
  out.push(
    `<section class="banner ${gate.tone}" id="verdict"><div class="verdict">Release gate: ${esc(gate.verdict)}</div>` +
      `<p>${esc(gate.reason)}</p>${partialLine(r)}` +
      (r.executiveSummary?.nextAction ? `<p><strong>Next action:</strong> ${esc(r.executiveSummary.nextAction)}</p>` : '') +
      '</section>',
  );
  out.push(
    '<nav><a href="#failures">Failures</a><a href="#outcomes">Outcomes</a><a href="#timeline">Timeline</a><a href="#env">Environment</a><a href="#artifacts">Artifacts</a></nav>',
  );

  // (2) Failures and findings.
  out.push(`<h2 id="failures">Failures and findings (${failed.length + sortedFindings.length})</h2>`);
  if (!failed.length && !sortedFindings.length) out.push('<p class="muted">No failed workflows and no findings.</p>');
  for (const n of failed) {
    const step = failingStep(n, steps);
    const code = step?.failureCode ?? n.category;
    const logUri = outcomeLogUri(n, code, steps, findings);
    const shotUri = step?.screenshotUri ?? evidenceUris(n).find((u) => isImageUri(u, byUri.get(u)));
    const shot = shotUri ? await img.render(shotUri, `${n.workflow} failure`) : '<span class="missing">no screenshot</span>';
    const flags = outcomeFlags(n)
      .map((f) => `<span class="flag warn">${esc(f)}</span>`)
      .join('');
    out.push(
      `<div class="card"><div>${shot}</div><div class="body"><h3><span class="${RESULT_CLASS[n.outcome] ?? ''}-t">${esc(n.outcome)}</span> ${esc(n.workflow)}${flags}</h3>` +
        (step ? `<p><strong>Failing step:</strong> ${esc(step.label)}</p>` : '') +
        (code ? `<p><strong>Code:</strong> <code>${esc(code)}</code></p>` : '') +
        (n.reason ? `<p>${esc(n.reason)}</p>` : '') +
        (n.missingPrecondition ? `<p><strong>Missing:</strong> ${esc(n.missingPrecondition)}</p>` : '') +
        (logUri ? logTailHtml(logUri, byUri, sessionDir, undefined, OUTCOME_LOG_TAIL_LINES) : '') +
        '</div></div>',
    );
  }
  for (const f of sortedFindings) {
    const shot = f.screenshotUri ? await img.render(f.screenshotUri, `${f.kind} finding`) : '<span class="missing">no screenshot</span>';
    const tone = f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : '';
    out.push(
      `<div class="card"><div>${shot}</div><div class="body"><h3><span class="flag ${tone}">${esc(f.severity)}</span> ${esc(f.kind)}${f.count && f.count > 1 ? ` (x${esc(f.count)})` : ''}</h3>` +
        `<p>${esc(f.detail)}</p>` +
        (f.failureCode ? `<p><strong>Code:</strong> <code>${esc(f.failureCode)}</code></p>` : '') +
        (f.screen ? `<p class="muted">screen: ${esc(f.screen)}</p>` : '') +
        (f.evidence ? `<pre class="log">${esc(f.evidence)}</pre>` : '') +
        (f.nextStep ? `<p><strong>Next:</strong> ${esc(f.nextStep)}</p>` : '') +
        (f.logUri ? logTailHtml(f.logUri, byUri, sessionDir) : '') +
        '</div></div>',
    );
  }

  // (3) Outcomes.
  out.push(`<h2 id="outcomes">Outcomes (${outcomes.length})</h2>`);
  if (!outcomes.length) out.push('<p class="muted">No workflow outcomes recorded.</p>');
  else {
    out.push('<div class="table-wrap"><table><thead><tr><th>Workflow</th><th>Result</th><th>Evidence</th></tr></thead><tbody>');
    for (const n of outcomes) {
      const ev = evidenceUris(n);
      const shotUri = ev.find((u) => isImageUri(u, byUri.get(u)));
      const evidence = shotUri
        ? await img.render(shotUri, `${n.workflow} evidence`)
        : ev.length
          ? ev.map((u) => `<code>${esc(relativeArtifactPath(u, byUri.get(u)) ?? u)}</code>`).join(' ')
          : '<span class="missing">(no evidence)</span>';
      const flags = outcomeFlags(n)
        .map((f) => `<span class="flag ${f === 'contradicted' ? 'bad' : 'warn'}">${esc(f)}</span>`)
        .join('');
      out.push(
        `<tr><td>${esc(n.workflow)}${n.reason ? `<div class="muted">${esc(n.reason)}</div>` : ''}</td><td><span class="${RESULT_CLASS[n.outcome] ?? ''}-t">${esc(n.outcome)}</span>${flags}</td><td>${evidence}</td></tr>`,
      );
    }
    out.push('</tbody></table></div>');
  }

  // (4) Step timeline: open when something failed.
  out.push(await timelineHtml(steps, img, anyFailure));

  // (5) Environment, device and app, timing.
  const env = Array.isArray(r.environmentChanges) ? r.environmentChanges : [];
  const t = r.phaseTimings;
  out.push('<h2 id="env">Environment, device and timing</h2>');
  out.push(
    '<ul>' +
      `<li>App: ${r.appId ? `<code>${esc(r.appId)}</code>` : 'not resolved'}</li>` +
      `<li>Device: ${r.device ? `<code>${esc(r.device)}</code>` : 'none bound'}${r.automationBackend ? ` · ${esc(r.automationBackend.description ?? r.automationBackend.kind)}` : ''}</li>` +
      `<li>Health: native ${esc(r.nativeHealth)}, app ${esc(r.appHealth)}</li>` +
      `<li>Network: ${esc(r.finalNetwork)} (restore: ${esc(r.networkRestore)}) · auth: ${esc(r.authState)}</li>` +
      (t ? `<li>Timing: total ${esc(fmtMs(t.totalMs))}, setup ${esc(fmtMs(t.setupMs))}, active ${esc(fmtMs(t.activeMs))}</li>` : '') +
      '</ul>',
  );
  out.push(
    env.length
      ? `<p><strong>Environment changes:</strong></p><ul>${env.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
      : '<p class="muted">No environment changes.</p>',
  );

  // (6) Artifacts.
  out.push(`<h2 id="artifacts">Artifacts (${artifacts.length})</h2>`);
  if (img.overBudget)
    out.push(
      `<p class="warn-t">${img.overBudget} image(s) were not embedded because the report reached its image budget; open them from the session folder.</p>`,
    );
  out.push(`<p class="muted">Paths are relative to the session folder${sessionDir ? '' : ' (not available here)'}.</p>`);
  if (artifacts.length) {
    out.push('<ul>');
    for (const a of artifacts) {
      const sensitive = a.redaction === 'not-applied' ? ' <span class="flag warn">may contain sensitive pixels</span>' : '';
      out.push(
        `<li><code>${esc(relativeArtifactPath(a.uri, a) ?? a.uri)}</code> <span class="muted">${esc(a.kind)}${a.label ? `: ${esc(a.label)}` : ''}</span>${sensitive}</li>`,
      );
    }
    out.push('</ul>');
  }
  return page(`Swipium report ${r.appId ?? r.sessionId}`, out.join('\n'));
}
