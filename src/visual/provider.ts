import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectConfig } from '../cli/scan.js';
import { resolveCommandTemplate, type CommandTemplate, type ResolvedCommand } from '../lib/commandTemplate.js';
import { assertNoGitScope, run } from '../lib/spawn.js';
import type { Redactor } from '../lib/redact.js';

export type ProviderIo = 'argv' | 'json';
export type VisualProviderCommand = CommandTemplate | { command: CommandTemplate; io?: ProviderIo; timeoutMs?: number };

export interface ResolvedVisualProvider extends ResolvedCommand {
  io: ProviderIo;
  timeoutMs: number;
}

export interface MaskingResult {
  imagePath: string;
  tempPaths: string[];
  masksApplied: string[];
  providerConfigured: boolean;
}

function isProviderObject(value: unknown): value is { command: CommandTemplate; io?: ProviderIo; timeoutMs?: number } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'command' in value;
}

export function resolveVisualProvider(
  command: VisualProviderCommand,
  vars: Record<string, string>,
  defaultTimeoutMs: number,
): ResolvedVisualProvider {
  const raw = isProviderObject(command) ? command.command : command;
  const resolved = resolveCommandTemplate(raw, vars);
  assertNoGitScope(resolved.command, resolved.args);
  const io = isProviderObject(command) && command.io === 'json' ? 'json' : 'argv';
  const timeoutMs =
    isProviderObject(command) && Number.isFinite(command.timeoutMs) && command.timeoutMs! > 0
      ? Math.floor(command.timeoutMs!)
      : defaultTimeoutMs;
  return { ...resolved, io, timeoutMs };
}

/**
 * Temp directory for images handed to a local provider. `tmpdir()` can be a symlink (macOS:
 * /tmp > /private/tmp, /var/folders > /private/var/folders) and some native tools
 * (tesseract/leptonica) fail to open the symlinked path, so always hand out the real path.
 */
export function providerTempDir(): string {
  const dir = tmpdir();
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** A fresh private (0700, mkdtemp) directory for one provider call's images, never a
 *  predictable name in the shared tmpdir. The caller removes it (recursively) when done. */
export function makeProviderWorkDir(prefix: 'swipium-ocr-' | 'swipium-masked-'): string {
  return mkdtempSync(join(providerTempDir(), prefix));
}

/** Where a provider command came from. Shown in the consent prompt. A repository-configured
 *  command (.swipium/config.json) arrived with the checkout and has not been reviewed by the user. */
export type ProviderSource = 'repository' | 'environment';
export const REPO_COMMAND_LABEL = 'configured by the repository (.swipium/config.json), unreviewed';
export function providerSourceLabel(source: ProviderSource, envVar: string): string {
  return source === 'repository' ? REPO_COMMAND_LABEL : `configured by the ${envVar} environment variable (user)`;
}

/** A configured visual provider (OCR / mask command) exited non-zero or timed out. */
export class VisualProviderFailedError extends Error {
  readonly code = 'OCR_PROVIDER_FAILED' as const;

  constructor(
    readonly provider: 'ocr' | 'mask',
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(
      `${provider === 'ocr' ? 'OCR' : 'Visual mask'} provider ${timedOut ? 'timed out' : `exited with code ${exitCode}`}` +
        (stderr ? `: ${stderr}` : ' (no stderr)'),
    );
    this.name = 'VisualProviderFailedError';
  }
}

/** Trim provider stderr to a bounded tail (the actionable part of a Python traceback is last). */
export function trimProviderStderr(stderr: string, maxChars = 1200): string {
  const t = stderr.trim();
  return t.length > maxChars ? `…${t.slice(t.length - maxChars)}` : t;
}

/**
 * Run a visual provider command. `cwd` should be the project root so relative argv entries
 * (e.g. ".swipium/ocr_tesseract.py") resolve against the project, not the server's cwd.
 * A non-zero exit or timeout throws VisualProviderFailedError (never a silent empty result).
 */
export async function runVisualProvider(
  command: VisualProviderCommand,
  vars: Record<string, string>,
  payload: Record<string, unknown>,
  defaultTimeoutMs: number,
  opts: { cwd?: string; provider?: 'ocr' | 'mask' } = {},
) {
  const resolved = resolveVisualProvider(command, vars, defaultTimeoutMs);
  const input = resolved.io === 'json' ? JSON.stringify({ schema: 'swipium.visual.provider.v1', ...payload }) + '\n' : undefined;
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : undefined;
  const result = await run(resolved.command, resolved.args, { timeoutMs: resolved.timeoutMs, input, cwd });
  if (result.timedOut || result.code !== 0)
    throw new VisualProviderFailedError(opts.provider ?? 'ocr', result.code, trimProviderStderr(result.stderr), result.timedOut);
  return { resolved, result };
}

export function configuredMaskCommand(root: string): VisualProviderCommand | undefined {
  const cfg = loadProjectConfig(root)?.visualMaskCommand as VisualProviderCommand | undefined;
  return cfg ?? process.env.SWIPIUM_VISUAL_MASK_CMD;
}

/** Provenance of the mask command configuredMaskCommand() would use. */
export function maskCommandSource(root: string): ProviderSource | undefined {
  if (loadProjectConfig(root)?.visualMaskCommand) return 'repository';
  return process.env.SWIPIUM_VISUAL_MASK_CMD ? 'environment' : undefined;
}

export function resolveMaskProvider(root: string): ResolvedVisualProvider | null {
  const command = configuredMaskCommand(root);
  return command ? resolveVisualProvider(command, { image: '<screenshot>', output: '<masked-screenshot>' }, 30000) : null;
}

export async function maskScreenshotForProvider(root: string, imagePath: string, context: Record<string, unknown>): Promise<MaskingResult> {
  const command = configuredMaskCommand(root);
  if (!command) return { imagePath, tempPaths: [], masksApplied: [], providerConfigured: false };
  const workDir = makeProviderWorkDir('swipium-masked-');
  const outputPath = join(workDir, 'masked.png');
  let result;
  try {
    ({ result } = await runVisualProvider(
      command,
      { image: imagePath, output: outputPath },
      {
        task: 'mask_screenshot',
        imagePath,
        outputPath,
        context,
      },
      30000,
      { cwd: root, provider: 'mask' },
    ));
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const produced = typeof parsed.imagePath === 'string' && parsed.imagePath.trim() ? parsed.imagePath : outputPath;
  if (!existsSync(produced)) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error('visualMaskCommand did not produce a masked imagePath or output file');
  }
  const masksApplied = Array.isArray(parsed.masksApplied)
    ? parsed.masksApplied.filter((v): v is string => typeof v === 'string')
    : ['external_mask'];
  // Only our private work dir is ever cleaned up, never a provider-chosen path outside it.
  return { imagePath: produced, tempPaths: [workDir], masksApplied, providerConfigured: true };
}

export function boundedProviderObject(value: unknown, redact: Redactor, maxChars = 8000): Record<string, unknown> {
  const raw = redact(JSON.stringify(value)) ?? '{}';
  const bounded = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  try {
    const parsed = JSON.parse(bounded) as Record<string, unknown>;
    if (raw.length > maxChars) parsed.truncated = true;
    return parsed;
  } catch {
    return { text: bounded, truncated: raw.length > maxChars };
  }
}

export function boundedText(value: string, redact: Redactor, maxChars = 8000): { text: string; truncated: boolean } {
  const safe = redact(value) ?? '';
  return { text: safe.slice(0, maxChars), truncated: safe.length > maxChars };
}
