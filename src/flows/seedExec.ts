// Shared seed executor (NEXT-PLAN: Seeded State + Flow V2). The raw, no-consent execution of a
// fixture seed (deeplink / script / api), used by flow
// runner's `seed` step (a flow is the author's explicit consent surface). It performs the action,
// persists a redacted artifact for scripts, logs the env change on success, and returns a result —
// it does NOT prompt for consent or record qa_notes (callers decide how to report).

import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { makeRedactor } from '../lib/redact.js';
import { gitScopeViolation, run } from '../lib/spawn.js';
import { displayArgv, shellSplit } from '../lib/commandTemplate.js';
import type { Driver } from '../drivers/Driver.js';
import type { FixtureSeedAction, Session, SessionStore } from '../session/store.js';

/** Normalize a seed command to argv. string form is deprecated; argv arrays remain the unambiguous format. */
export function normalizeCommand(command: string | string[] | undefined): { argv: string[]; deprecated: boolean; parseError?: string } {
  if (Array.isArray(command)) return { argv: command, deprecated: false };
  if (typeof command === 'string') {
    try {
      return { argv: shellSplit(command), deprecated: true };
    } catch (e) {
      return { argv: [], deprecated: true, parseError: e instanceof Error ? e.message : String(e) };
    }
  }
  return { argv: [], deprecated: false };
}

/** Refuse seed scripts that reference a script/data PATH outside the project root (hooks-under-root).
 *  The interpreter (argv[0], e.g. an absolute `node`/`sh`) is allowed; only block a relative argv[0]
 *  that escapes root, and any later argument that is an absolute existing path outside root. */
export function outsideRoot(argv: string[], root: string): string | null {
  const base = resolve(root);
  const escapes = (abs: string) => abs !== base && !abs.startsWith(base + sep);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (i === 0) {
      if (!isAbsolute(tok) && (tok.includes('/') || tok.includes('\\')) && escapes(resolve(base, tok))) return tok;
      continue;
    }
    if (isAbsolute(tok) && existsSync(tok) && escapes(resolve(tok))) return tok;
  }
  return null;
}

export function seedGitScopeViolation(seed: FixtureSeedAction): string | null {
  if (seed.type !== 'script') return null;
  const { argv, parseError } = normalizeCommand(seed.command);
  if (parseError || !argv.length) return null;
  return gitScopeViolation(argv);
}

export interface SeedExecResult {
  ok: boolean;
  detail?: string;
  warnings: string[];
}

/** Build the exact command/action string for a seed (for consent display). */
export function seedExactCommand(seed: FixtureSeedAction): string {
  if (seed.type === 'deeplink') return `open ${seed.url}`;
  if (seed.type === 'script') {
    if (typeof seed.command === 'string') return seed.command;
    return displayArgv(normalizeCommand(seed.command).argv);
  }
  return `${seed.method ?? 'POST'} ${seed.url}`;
}

export async function executeSeed(
  sessions: SessionStore,
  session: Session,
  driver: Driver | undefined,
  fixtureName: string,
  seed: FixtureSeedAction,
): Promise<SeedExecResult> {
  const redact = makeRedactor(session.secrets);
  const { argv, deprecated, parseError } = normalizeCommand(seed.command);
  const warnings: string[] = [];
  if (seed.type === 'script' && deprecated)
    warnings.push(
      'string `command` is deprecated; it is parsed with shell-style quoting for compatibility, but argv arrays avoid ambiguous escaping, e.g. command: ["node", "scripts/seed.js"].',
    );

  try {
    if (seed.type === 'deeplink') {
      if (!seed.url) return { ok: false, detail: 'no url in seed', warnings };
      if (!driver) return { ok: false, detail: 'no device attached to open the deep link', warnings };
      await driver.openUrl(seed.url);
    } else if (seed.type === 'script') {
      if (parseError) return { ok: false, detail: `invalid seed command: ${parseError}`, warnings };
      if (!argv.length) return { ok: false, detail: 'no command in seed', warnings };
      const git = gitScopeViolation(argv);
      if (git) return { ok: false, detail: `Git is outside Swipium's QA scope; refused seed command "${git}"`, warnings };
      const bad = outsideRoot(argv, session.root);
      if (bad)
        return {
          ok: false,
          detail: `seed script references a path outside the project root ("${bad}") — seed scripts must live under the project root`,
          warnings,
        };
      const r = await run(argv[0], argv.slice(1), { cwd: session.root, timeoutMs: 60000 });
      const log = redact([r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 8000)) ?? '';
      if (log)
        sessions.saveArtifact(
          session,
          'seed',
          `seed-${fixtureName}-${Date.now()}.log`,
          log,
          'text/plain',
          `seed script output (${fixtureName})`,
        );
      if (r.code !== 0) return { ok: false, detail: `script exited ${r.code}: ${redact(r.stderr.trim().slice(0, 300)) ?? ''}`, warnings };
    } else {
      if (!seed.url) return { ok: false, detail: 'no url in seed', warnings };
      const res = await fetch(seed.url, { method: seed.method ?? 'POST', headers: seed.headers, body: seed.body });
      if (!res.ok) return { ok: false, detail: `API responded ${res.status} ${res.statusText}`, warnings };
    }
  } catch (e) {
    return { ok: false, detail: String(e), warnings };
  }

  sessions.addEnvChange(session, `seeded "${fixtureName}" via ${seed.type}`);
  return { ok: true, warnings };
}
