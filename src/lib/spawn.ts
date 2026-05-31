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

export interface RunOptions {
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
  const cIndex = args.findIndex((arg) => (
    arg === '-c'
    || arg === '/c'
    || arg === '/C'
    || arg.toLowerCase() === '-command'
    || (['sh', 'bash', 'zsh', 'fish'].includes(shell) && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
  ));
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

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
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
        reject(
          new Error(`\`${cmd} ${args.join(' ')}\` exited ${code}${timedOut ? ' (timed out)' : ''}: ${stderr.trim()}`),
        );
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

/** Like run(), but collects stdout as raw bytes (for screenshots etc.). */
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
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
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
