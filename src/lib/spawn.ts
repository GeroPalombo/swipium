// Safe process execution: arg arrays only (never shell strings → injection-safe,
// DESIGN §10.1), with timeout + AbortSignal threading.

import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Default kill timer for spawned commands (2 minutes). A stuck `adb`/`xcodebuild` would
 * otherwise hang the single-threaded server forever. Long-running call sites (builds,
 * emulator boot, AAB conversion) must pass an explicit generous `timeoutMs` — or opt out
 * entirely with `timeoutMs: 0` (or `Infinity`). */
export const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;

/** Resolve the caller's `timeoutMs` to the effective kill-timer delay.
 *  undefined → DEFAULT_SPAWN_TIMEOUT_MS; 0 / negative / Infinity → no timeout (opt-out). */
function effectiveTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return DEFAULT_SPAWN_TIMEOUT_MS;
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) return undefined;
  return timeoutMs;
}

export interface RunOptions {
  /** Kill timer in ms. Omitted → DEFAULT_SPAWN_TIMEOUT_MS (120s). Pass 0 (or Infinity) to
   * explicitly disable the timeout for a legitimately unbounded command. */
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  input?: string;
  /** Treat a non-zero exit as a thrown error instead of a resolved RunResult. */
  rejectOnNonZero?: boolean;
}

export class GitScopeForbiddenError extends Error {
  code = 'GIT_SCOPE_FORBIDDEN' as const;

  constructor(command: string) {
    super(`Git is outside Swipium's QA scope; refused command "${command}"`);
    this.name = 'GitScopeForbiddenError';
  }
}

function executableName(command: string): string {
  const base = basename(command).toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

function isShell(command: string): boolean {
  return ['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(executableName(command));
}

function shellCommandPayload(command: string, args: string[]): string | null {
  if (!isShell(command)) return null;
  const shell = executableName(command);
  const cIndex = args.findIndex(
    (arg) =>
      arg === '-c' ||
      arg === '/c' ||
      arg === '/C' ||
      arg.toLowerCase() === '-command' ||
      (['sh', 'bash', 'zsh', 'fish'].includes(shell) && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)),
  );
  return cIndex >= 0 && typeof args[cIndex + 1] === 'string' ? args[cIndex + 1] : null;
}

function stripTokenQuotes(token: string): string {
  let out = token.trim();
  while ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function shellPayloadGitToken(payload: string): string | null {
  for (const raw of payload.split(/[\s;&|(){}<>]+/)) {
    const token = stripTokenQuotes(raw);
    if (!token || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (executableName(token) === 'git') return token;
  }
  return null;
}

export function gitScopeViolation(argv: string[] | string): string | null {
  const command = Array.isArray(argv) ? argv[0] : argv;
  if (!command) return null;
  if (executableName(command) === 'git') return command;
  if (Array.isArray(argv)) {
    const payload = shellCommandPayload(command, argv.slice(1));
    const shellGit = payload ? shellPayloadGitToken(payload) : null;
    if (shellGit) return shellGit;
  }
  return null;
}

export function assertNoGitScope(command: string, args: string[] = []): void {
  const bad = gitScopeViolation([command, ...args]);
  if (bad) throw new GitScopeForbiddenError(bad);
}

/** Run a command from an argv array. `opts.timeoutMs` defaults to DEFAULT_SPAWN_TIMEOUT_MS
 * (120s) when omitted; pass `timeoutMs: 0` (or `Infinity`) to disable the kill timer. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    assertNoGitScope(cmd, args);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutMs = effectiveTimeoutMs(opts.timeoutMs);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = { code, stdout, stderr, timedOut };
      if (opts.rejectOnNonZero && code !== 0) {
        reject(new Error(`\`${cmd} ${args.join(' ')}\` exited ${code}${timedOut ? ' (timed out)' : ''}: ${stderr.trim()}`));
        return;
      }
      resolve(result);
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

export interface BinaryRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/** Like run(), but collects stdout as raw bytes (for screenshots etc.). Same timeout
 * convention: omitted → DEFAULT_SPAWN_TIMEOUT_MS (120s); 0 / Infinity → disabled. */
export function runBinary(cmd: string, args: string[], opts: RunOptions = {}): Promise<BinaryRunResult> {
  try {
    assertNoGitScope(cmd, args);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal });
    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const timeoutMs = effectiveTimeoutMs(opts.timeoutMs);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (opts.rejectOnNonZero && code !== 0) {
        reject(new Error(`\`${cmd}\` exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut });
    });
  });
}
