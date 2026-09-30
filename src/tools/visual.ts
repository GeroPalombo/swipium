// qa_visual — consolidated local visual intelligence for screens with no usable UI
// tree (maps/canvases/games) and for visual regression. Its whole point is that it stays
// backend-neutral: only driver.screenshot() is required, so it works in visual-only iOS
// simulator mode (no WDA) where qa_act / qa_snapshot are rejected. Modes:
//   baseline   — save the current screen as a named baseline (<repo>/.swipium/baselines/<name>.png)
//   diff       — compare the current screen to a baseline → changed-ratio + changed region
//   find_text  — consent-gated OCR (locally-configured provider, none bundled) → text matches
//   find_image — locate a reference PNG in the current screen → tappable coordinates
//   assert     — record a visual pass/fail with screenshot evidence (a qa_note with
//                verifiedVisually=true; a pass is also recorded as a semantic IR step)
// Every result declares its coordinateSpace so screenshot-pixel hits convert
// honestly to device (tap) coordinates — POINTS on iOS (WDA and the idb fallback), pixels on
// Android. Policy matches qa_screenshot: refuse in sensitive mode, and
// withhold capture when a secure field is (or may be) on screen unless force:true
// (THREAT_MODEL "Sensitive-screen capture" — pixels are not redactable).
//
// Each mode is one handler in MODE_HANDLERS sharing a VisualContext, so adding a mode is one
// enum value + one handler.

import { z } from 'zod';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk, qaError, qaStop, unknownSessionError } from '../lib/result.js';
import { isSecureNode, makeRedactor, type Redactor } from '../lib/redact.js';
import { parseSnapshot } from '../snapshot/parse.js';
import { displayArgv } from '../lib/commandTemplate.js';
import { GitScopeForbiddenError, run } from '../lib/spawn.js';
import { which } from '../lib/android.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { imageDiff, findTemplate } from '../lib/image.js';
import { captureCoordinateSpace, toDevicePoint, type CoordinateSpace } from '../lib/coordSpace.js';
import {
  configuredOcrCommand,
  ocrCommandSource,
  findOcrRegion,
  runOcr,
  OCR_PROVIDER_CONTRACT,
  TESSERACT_OCR_EXAMPLE,
  type OcrRegion,
  type OcrResult,
} from '../visual/ocr.js';
import {
  boundedText,
  maskCommandSource,
  providerSourceLabel,
  resolveMaskProvider,
  resolveVisualProvider,
  VisualProviderFailedError,
} from '../visual/provider.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import { recordableTap } from '../flows/generate.js';
import type { Driver } from '../drivers/Driver.js';
import type { LastSnapshot, Session, SessionStore } from '../session/store.js';

export const VISUAL_MODES = ['assert', 'baseline', 'diff', 'find_text', 'find_image'] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];

// ---------------------------------------------------------------------------------------------
// B5: path containment for baselines and templates.

/** Baseline names are plain file stems: 1–64 of [A-Za-z0-9._-], never starting with a dot. */
const BASELINE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function baselinesDirFor(root: string): string {
  return join(root, '.swipium', 'baselines');
}

function pathRefused(what: string, nextStep: string): CallToolResult {
  return qaError({ what, changedState: false, retrySafe: false, failureCode: 'VISUAL_PATH_REFUSED', nextSteps: [nextStep] });
}

/** Resolve `<root>/.swipium/baselines/<name>.png`, refusing any name that could escape it. */
export function resolveBaselinePath(root: string, name: string): { path: string } | { error: string } {
  if (!BASELINE_NAME_RE.test(name) || name.startsWith('.')) {
    return { error: `Invalid baseline name ${JSON.stringify(name)} — use 1–64 of [A-Za-z0-9._-], not starting with "."` };
  }
  const dir = resolve(baselinesDirFor(root));
  const path = resolve(dir, `${name}.png`);
  if (!path.startsWith(dir + sep)) return { error: `Baseline name ${JSON.stringify(name)} resolves outside .swipium/baselines` };
  // A symlinked baseline file could still redirect the write/read elsewhere — refuse it.
  try {
    if (lstatSync(path).isSymbolicLink()) return { error: `Baseline ${JSON.stringify(name)} is a symlink — refusing to follow it` };
  } catch {
    // does not exist yet — fine
  }
  return { path };
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** A find_image template must be a PNG inside the project root (symlinks resolved) or a
 * swipium:// artifact of this session's project — never an arbitrary absolute path. */
export function resolveTemplatePath(
  sessions: SessionStore,
  session: Session,
  template: string,
): { path: string } | { error: string; missing?: boolean } {
  if (template.startsWith('swipium://')) {
    const found = sessions.findArtifact(template);
    if (!found || found.session.root !== session.root) return { error: `Unknown artifact ${template} for this project`, missing: true };
    return { path: found.rec.path };
  }
  const root = realOrResolved(session.root);
  const candidate = isAbsolute(template) ? resolve(template) : resolve(session.root, template);
  if (!existsSync(candidate)) return { error: `Template not found: ${candidate}`, missing: true };
  const real = realOrResolved(candidate);
  if (real !== root && !real.startsWith(root + sep)) {
    return {
      error: `Template ${JSON.stringify(template)} is outside the project root — only project files or swipium:// artifacts are allowed`,
    };
  }
  return { path: real };
}

// ---------------------------------------------------------------------------------------------
// B8: secure-screen detection.

/** Snapshots taken BEFORE a qa_visual tap describe a screen that may no longer be showing. */
const staleSnapshots = new WeakSet<LastSnapshot>();

export type SecureScreenState = 'secure' | 'clear' | 'unknown';

/** secure/clear from a FRESH UI tree; unknown when there is none (WDA-less simulator, no
 * qa_snapshot yet) or it predates a visual tap. */
export function secureScreenState(session: Session): SecureScreenState {
  const snap = session.lastSnapshot;
  if (!snap || staleSnapshots.has(snap)) return 'unknown';
  return [...snap.fullByRef.values()].some((n) => isSecureNode(n)) ? 'secure' : 'clear';
}

/** When the cached tree is missing or stale (e.g. after a qa_visual tap), a structured backend
 * (Android adb / WDA) can simply re-dump it: a qa_visual tap must not, by itself, turn the next
 * qa_visual call into an "unverified" one there. The fresh dump only informs the secure gate —
 * session.lastSnapshot (the agent's @ref numbering) is left untouched. WDA-less simulators
 * cannot dump a tree, so they stay 'unknown'. */
async function refreshSecureState(session: Session, driver: Driver): Promise<SecureScreenState> {
  const cached = secureScreenState(session);
  if (cached !== 'unknown' || driver.kind === 'simulator') return cached;
  try {
    const parsed = parseSnapshot(await driver.dumpXml());
    if (parsed.allNodes.length === 0) return 'unknown';
    return parsed.allNodes.some((n) => isSecureNode(n)) ? 'secure' : 'clear';
  } catch {
    return 'unknown';
  }
}

/** The session has handled credentials (typed secrets, secret inputs, a login, or a
 * rehydrated session whose secrets were dropped) — an unverified screen may be sensitive. */
function hasSecretContext(session: Session): boolean {
  return (
    session.secrets.size > 0 ||
    !!session.redactionDegraded ||
    (session.inputs ?? []).some((i) => i.secret) ||
    !!session.auth?.loginPerformed
  );
}

/** OCR text that reads like a password/OTP/payment screen. */
const SECURE_TEXT_RE = /password|passcode|one[- ]?time|\bOTP\b|verification code|security code|\bCVV\b|\bCVC\b|card number|\bPIN\b/i;

function redactRegion(r: OcrRegion, redact: Redactor): OcrRegion {
  return { ...r, text: redact(r.text) ?? '' };
}

// ---------------------------------------------------------------------------------------------
// Tapping (B6 units, B7 recording/budget).

/** Tap a found device-space point. On the WDA-less simulator the driver cannot inject input,
 * so fall back to Meta's `idb` when it is on PATH (`idb ui tap` takes POINTS, which is what
 * SimctlDriver.screenSize() reports, so devicePoint is already in points); otherwise return a
 * typed refusal that still carries the coordinates (the locate itself succeeded). */
async function tapFoundPoint(
  driver: Driver,
  point: { x: number; y: number },
  foundPayload: Record<string, unknown>,
): Promise<{ via: 'driver' | 'idb' } | { error: CallToolResult }> {
  if (driver.kind !== 'simulator') {
    try {
      await driver.tapXY(point.x, point.y);
      return { via: 'driver' };
    } catch (e) {
      return {
        error: qaError(
          {
            what: `Found the target but the tap failed: ${String(e)}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Tap the returned devicePoint with qa_act { action:"tap", target:{ x, y } }.'],
          },
          foundPayload,
        ),
      };
    }
  }
  const udid = driver.currentDevice();
  if (udid && (await which('idb'))) {
    const r = await run('idb', ['ui', 'tap', String(point.x), String(point.y), '--udid', udid], { timeoutMs: 15000 }).catch((e) => ({
      code: -1,
      stdout: '',
      stderr: String(e),
      timedOut: false,
    }));
    if (r.code === 0) return { via: 'idb' };
    return {
      error: qaError(
        {
          what: `Found the target but \`idb ui tap\` failed: ${r.stderr.trim() || `exit ${r.code}`}`,
          changedState: false,
          retrySafe: true,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['Attach WebDriverAgent with qa_wda, then tap the returned devicePoint via qa_act { action:"tap", target:{ x, y } }.'],
        },
        foundPayload,
      ),
    };
  }
  return {
    error: qaError(
      {
        what: 'Found the target, but tapping is not supported on the WDA-less iOS simulator backend (no idb on PATH)',
        changedState: false,
        retrySafe: true,
        failureCode: 'BACKEND_UNSUPPORTED',
        nextSteps: [
          'Attach WebDriverAgent with qa_wda, then tap the returned devicePoint via qa_act { action:"tap", target:{ x, y } }.',
          "Or install Meta's idb (`brew tap facebook/fb && brew install idb-companion`, then `pipx install fb-idb`) so qa_visual can tap here.",
        ],
      },
      foundPayload,
    ),
  };
}

interface VisualContext {
  sessions: SessionStore;
  session: Session;
  driver: Driver;
  args: VisualArgs;
  redact: Redactor;
  secureState: SecureScreenState;
  /** Unverified screen in a credential-handling session without force:true: the mode may run
   * (compare / locate / assert), but its capture must NOT be persisted as an artifact. */
  withholdCapture: boolean;
}

interface VisualArgs {
  mode: VisualMode;
  name?: string;
  query?: string;
  template?: string;
  threshold?: number;
  minScore?: number;
  minConfidence?: number;
  tap?: boolean;
  force?: boolean;
  consentId?: string;
  approve?: boolean;
  assertion?: string;
  pass?: boolean;
  reason?: string;
}

/** Tap + record it like qa_act does: bump the action counter, append a coordinate-kind action
 * to the IR (so qa_generate / next-best-action see WDA-less progress), mark the UI tree stale,
 * and surface budget exhaustion. */
async function tapAndRecord(
  ctx: VisualContext,
  devicePoint: { x: number; y: number },
  payload: Record<string, unknown>,
  visual: {
    screenshotCrop?: { x: number; y: number; width: number; height: number };
    ocrText?: string;
    confidence?: number;
    coordinateSpace: CoordinateSpace;
  },
  label: string,
): Promise<CallToolResult> {
  const { sessions, session, driver } = ctx;
  const tapped = await tapFoundPoint(driver, devicePoint, payload);
  if ('error' in tapped) return tapped.error;
  sessions.bump(session, 'actions');
  if (session.lastSnapshot) staleSnapshots.add(session.lastSnapshot);
  const point = { x: devicePoint.x, y: devicePoint.y, via: 'coords' };
  const rec = recordableTap(session, { x: devicePoint.x, y: devicePoint.y }, point);
  sessions.addRecordedAction(session, {
    at: Date.now(),
    action: 'tap',
    ...rec,
    warning: `Located visually (${visual.ocrText ? `OCR "${visual.ocrText}"` : 'template match'}) — coordinate-only replay; add an accessibilityIdentifier/testID for a durable selector`,
    provenance: {
      ...(rec.provenance ?? {}),
      selectorKind: 'coords',
      visual: {
        screenshotCrop: visual.screenshotCrop,
        ocrText: visual.ocrText,
        confidence: visual.confidence,
        density: visual.coordinateSpace.density,
        orientation: visual.coordinateSpace.orientation,
      },
    },
  });
  const budgetReached = sessions.budgetStop(session);
  return qaOk(
    { ...payload, tapped: true, tapVia: tapped.via, recorded: true, ...(budgetReached ? { budgetReached } : {}) },
    `${label} → tapped device (${devicePoint.x}, ${devicePoint.y}) via ${tapped.via}` +
      (budgetReached ? `\n⏹ budget reached: ${budgetReached} — call qa_report.` : ''),
  );
}

/** One capture for the pixel modes; counts against the screenshot budget. */
async function capture(ctx: VisualContext): Promise<{ png: Buffer; coordinateSpace: CoordinateSpace } | { error: CallToolResult }> {
  let png: Buffer;
  try {
    png = await ctx.driver.screenshot();
  } catch (e) {
    return {
      error: qaError({
        what: `Screenshot failed: ${String(e)}`,
        changedState: false,
        retrySafe: true,
        nextSteps: ['Confirm the device is online.'],
      }),
    };
  }
  ctx.sessions.bump(ctx.session, 'screenshots');
  return { png, coordinateSpace: await captureCoordinateSpace(ctx.driver, png) };
}

/** Pixel outputs carry an explicit warning when the secure-field check could not run.
 * `ocrChecked`: the OCR text of this very capture was screened for password/OTP wording (the
 * only signal without a UI tree) — reported as secureFieldCheck:"ocr". */
function unverifiedNote(ctx: VisualContext, opts: { ocrChecked?: boolean } = {}): Record<string, unknown> {
  if (ctx.secureState !== 'unknown' || ctx.args.force)
    return { secureFieldCheck: ctx.secureState === 'unknown' ? 'forced' : ctx.secureState };
  const withheld = ctx.withholdCapture ? { captureWithheld: true } : {};
  return opts.ocrChecked
    ? {
        secureFieldCheck: 'ocr',
        warning: 'No fresh UI tree — the secure-field check was OCR-text only (no password/OTP wording found).',
        ...withheld,
      }
    : {
        secureFieldCheck: 'unverified',
        warning: 'No fresh UI tree — could not verify that no password/OTP field is on screen.',
        ...withheld,
      };
}

/** Persist a capture as a session artifact — unless the screen is unverified in a
 * credential-handling session (then nothing is written and the result says so). */
function saveCapture(ctx: VisualContext, name: string, png: Buffer, label: string): string | undefined {
  if (ctx.withholdCapture) return undefined;
  return ctx.sessions.saveArtifact(ctx.session, 'screenshot', name, png, 'image/png', label);
}

const WITHHELD_EVIDENCE =
  'evidence: withheld (no fresh UI tree to rule out a password/OTP field in a credential-handling session — pass force:true to keep the screenshot)';

// ---------------------------------------------------------------------------------------------
// Mode handlers.

async function findText(ctx: VisualContext): Promise<CallToolResult> {
  const { session, driver, args, redact } = ctx;
  const { query, minConfidence, consentId, approve, tap, force } = args;
  if (!query)
    return qaError({
      what: 'find_text requires a query',
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: ['Pass query="Log in".'],
    });
  const command = configuredOcrCommand(session.root);
  if (!command) {
    return qaError(
      {
        what: 'OCR is not configured — find_text needs a local OCR provider (none is bundled)',
        changedState: false,
        retrySafe: false,
        failureCode: 'OCR_NOT_CONFIGURED',
        nextSteps: [
          `Configure a provider: ${OCR_PROVIDER_CONTRACT}`,
          'Tesseract example: save the exampleProvider script from this result as .swipium/ocr_tesseract.py (needs `brew install tesseract`), then set "ocrCommand": ["python3", ".swipium/ocr_tesseract.py", "{image}"] in .swipium/config.json.',
          'Or locate by image with qa_visual mode:"find_image" (no provider needed).',
        ],
      },
      {
        exampleProvider: {
          path: '.swipium/ocr_tesseract.py',
          ocrCommand: ['python3', '.swipium/ocr_tesseract.py', '{image}'],
          script: TESSERACT_OCR_EXAMPLE,
        },
      },
    );
  }
  let preview;
  let maskPreview;
  try {
    preview = resolveVisualProvider(command, { image: '<screenshot>' }, 30000);
    maskPreview = resolveMaskProvider(session.root);
  } catch (e) {
    return qaError({
      what: e instanceof GitScopeForbiddenError ? e.message : `Invalid OCR command template: ${String(e)}`,
      changedState: false,
      retrySafe: !(e instanceof GitScopeForbiddenError),
      failureCode: e instanceof GitScopeForbiddenError ? 'GIT_SCOPE_FORBIDDEN' : 'INVALID_FLOW',
      nextSteps:
        e instanceof GitScopeForbiddenError
          ? ['Run Git yourself outside Swipium; configure ocrCommand to use a non-Git executable.']
          : ['Use an argv array in .swipium/config.json, e.g. ["node","ocr.js","{image}"].'],
    });
  }
  const maskConfigured = !!maskPreview;
  // BOTH commands that will run are disclosed (argv + provenance) — a repo config could otherwise
  // pair a harmless-looking ocrCommand with an arbitrary visualMaskCommand the user never sees.
  const ocrSource = providerSourceLabel(ocrCommandSource(session.root) ?? 'environment', 'SWIPIUM_OCR_CMD');
  const maskSource = maskPreview ? providerSourceLabel(maskCommandSource(session.root) ?? 'environment', 'SWIPIUM_VISUAL_MASK_CMD') : null;
  const affects = {
    argv: preview.argv,
    io: preview.io,
    ocrCommandSource: ocrSource,
    query,
    maskConfigured,
    maskArgv: maskPreview?.argv ?? null,
    maskIo: maskPreview?.io ?? null,
    maskCommandSource: maskSource,
  };
  const gate = consumeConsent(consentId, approve, { action: 'ocr_run', affects });
  if (!gate.approved) {
    const exactCommand = maskPreview
      ? `1) mask [${maskSource}]: ${displayArgv(maskPreview.argv)}\n2) OCR [${ocrSource}]: ${displayArgv(preview.argv)}`
      : `OCR [${ocrSource}]: ${displayArgv(preview.argv)}`;
    return requireConsent({
      action: 'ocr_run',
      risk: 'medium',
      exactCommand,
      affects,
      explain: maskPreview
        ? `Run TWO local programs on the current screenshot to find "${query}": first the visualMaskCommand (${maskSource}), then the OCR command (${ocrSource}) on its masked output. The screen image is passed to both.`
        : `Run the OCR command (${ocrSource}) on the current screenshot to find "${query}"? The screen image is passed to that local program.`,
    });
  }
  let ocr: OcrResult;
  try {
    ocr = await runOcr(driver, session.root, command);
  } catch (e) {
    if (e instanceof VisualProviderFailedError) {
      // A crashing provider must not read as "text not on screen" (real-device smoke 2.0.0).
      const stderr = boundedText(e.stderr, redact, 1200);
      return qaError(
        {
          what: `${e.provider === 'ocr' ? 'OCR' : 'Visual mask'} provider failed (${e.timedOut ? 'timed out' : `exit code ${e.exitCode}`})${stderr.text ? `: ${stderr.text.split('\n').pop()}` : ''}`,
          changedState: false,
          retrySafe: false,
          failureCode: 'OCR_PROVIDER_FAILED',
          nextSteps: [
            `Run the provider standalone from the project root (${session.root}) on a PNG and fix the error in stderr.`,
            'Relative paths in ocrCommand resolve against the project root; the tesseract example needs `brew install tesseract`.',
          ],
        },
        { provider: e.provider, exitCode: e.exitCode, timedOut: e.timedOut, stderr: stderr.text, stderrTruncated: stderr.truncated },
      );
    }
    return qaError({
      what: `OCR command failed: ${redact(String(e)) ?? ''}`,
      changedState: false,
      retrySafe: true,
      failureCode: 'OCR_PROVIDER_FAILED',
      nextSteps: ['Check the configured OCR command runs standalone on a PNG.'],
    });
  }
  ctx.sessions.bump(session, 'screenshots'); // runOcr captured the screen
  // B8: no fresh UI tree → the OCR text itself is the only signal; a password/OTP screen is
  // withheld (no text, no regions, no tap) unless force:true.
  if (ctx.secureState === 'unknown' && !force && (SECURE_TEXT_RE.test(ocr.text) || ocr.regions.some((r) => SECURE_TEXT_RE.test(r.text)))) {
    return qaError({
      what: 'Withheld — the screen reads like a password/OTP/payment screen and no fresh UI tree could confirm otherwise',
      changedState: false,
      retrySafe: true,
      failureCode: 'CAPTURE_WITHHELD_SECURE',
      nextSteps: [
        'Pass force:true to return OCR results for this screen anyway (text is still secret-redacted), or navigate to a non-sensitive screen.',
      ],
    });
  }
  const regions = ocr.regions.map((r) => redactRegion(r, redact));
  const hit = findOcrRegion(ocr, query, minConfidence ?? 0.8);
  if (!hit) {
    const bounded = boundedText(ocr.text, redact, 8000);
    return qaOk(
      {
        mode: 'find_text',
        found: false,
        query,
        text: bounded.text,
        truncated: bounded.truncated,
        regions,
        coordinateSpace: ocr.coordinateSpace,
        provider: ocr.provider,
        masking: ocr.masking,
        method: 'ocr',
        evidenceKind: 'ocr_text',
        ...unverifiedNote(ctx, { ocrChecked: true }),
      },
      `OCR did not find "${query}" at confidence >= ${minConfidence ?? 0.8}.`,
    );
  }
  const region = redactRegion(hit.region, redact);
  const payload: Record<string, unknown> = {
    mode: 'find_text',
    found: true,
    query,
    region,
    devicePoint: hit.devicePoint,
    coordinateSpace: ocr.coordinateSpace,
    method: 'ocr',
    locatorStrategy: 'ocr_text',
    evidenceKind: 'ocr_text',
    provider: ocr.provider,
    masking: ocr.masking,
    ...unverifiedNote(ctx, { ocrChecked: true }),
  };
  const label = `found "${region.text}" (${region.confidence})`;
  if (tap)
    return tapAndRecord(
      ctx,
      hit.devicePoint,
      payload,
      { screenshotCrop: hit.region.bbox, ocrText: region.text, confidence: region.confidence, coordinateSpace: ocr.coordinateSpace },
      label,
    );
  return qaOk(
    payload,
    `${label} → tap device (${hit.devicePoint.x}, ${hit.devicePoint.y}) via qa_act { action:"tap", target:{ x:${hit.devicePoint.x}, y:${hit.devicePoint.y} } }`,
  );
}

async function baseline(ctx: VisualContext): Promise<CallToolResult> {
  const { sessions, session, args } = ctx;
  const name = args.name;
  if (!name)
    return qaError({
      what: 'baseline requires a name',
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: ['Pass name="home-screen".'],
    });
  const target = resolveBaselinePath(session.root, name);
  if ('error' in target) return pathRefused(target.error, 'Use a plain name such as "home-screen" or "checkout.step-2".');
  const shot = await capture(ctx);
  if ('error' in shot) return shot.error;
  const { png, coordinateSpace } = shot;
  mkdirSync(baselinesDirFor(session.root), { recursive: true });
  writeFileSync(target.path, png);
  const uri = sessions.saveArtifact(session, 'baseline', `${name}.png`, png, 'image/png', `visual baseline: ${name}`);
  return qaOk(
    { mode: 'baseline', name, uri, path: target.path, coordinateSpace, ...unverifiedNote(ctx) },
    `saved baseline "${name}" (${png.length} bytes) → .swipium/baselines/${name}.png + ${uri}`,
  );
}

async function diff(ctx: VisualContext): Promise<CallToolResult> {
  const { session, args } = ctx;
  const name = args.name;
  if (!name)
    return qaError({
      what: 'diff requires a baseline name',
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: ['Pass the name used with mode:"baseline".'],
    });
  const target = resolveBaselinePath(session.root, name);
  if ('error' in target) return pathRefused(target.error, 'Use the plain name you passed to mode:"baseline".');
  if (!existsSync(target.path)) {
    return qaError({
      what: `No baseline "${name}" — capture one first`,
      changedState: false,
      retrySafe: true,
      nextSteps: [`Call qa_visual { mode: "baseline", name: "${name}" } on the reference screen.`],
    });
  }
  const shot = await capture(ctx);
  if ('error' in shot) return shot.error;
  const { png, coordinateSpace } = shot;
  const result = imageDiff(readFileSync(target.path), png);
  const tol = args.threshold ?? 0.02;
  const pass = result.comparable && result.ratio <= tol;
  const currentUri = saveCapture(ctx, `diff-${name}-${Date.now()}.png`, png, `diff vs baseline ${name}`);
  const deviceBox = result.box
    ? {
        x: toDevicePoint(coordinateSpace, result.box.x, result.box.y).x,
        y: toDevicePoint(coordinateSpace, result.box.x, result.box.y).y,
        width: Math.round(result.box.width / (coordinateSpace.scale ?? 1)),
        height: Math.round(result.box.height / (coordinateSpace.scale ?? 1)),
      }
    : null;
  return qaOk(
    {
      mode: 'diff',
      name,
      method: 'visual',
      comparable: result.comparable,
      reason: result.reason,
      changedRatio: Math.round(result.ratio * 10000) / 10000,
      threshold: tol,
      pass,
      changedBox: result.box,
      changedBoxDevice: deviceBox,
      currentUri: currentUri ?? null,
      coordinateSpace,
      ...unverifiedNote(ctx),
    },
    `diff vs "${name}": ${result.comparable ? `${(result.ratio * 100).toFixed(2)}% changed (threshold ${(tol * 100).toFixed(1)}%) → ${pass ? '✅ PASS' : '❌ FAIL'}` : `not comparable: ${result.reason}`}\n${currentUri ? `evidence: ${currentUri}` : WITHHELD_EVIDENCE}`,
  );
}

async function findImage(ctx: VisualContext): Promise<CallToolResult> {
  const { sessions, session, args } = ctx;
  const { template, minScore, tap } = args;
  if (!template)
    return qaError({
      what: 'find_image requires a template path',
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: ['Pass template="assets/reference.png" (inside the project root) or a swipium:// artifact URI.'],
    });
  const tpl = resolveTemplatePath(sessions, session, template);
  if ('error' in tpl) {
    if (tpl.missing)
      return qaError({
        what: tpl.error,
        changedState: false,
        retrySafe: true,
        nextSteps: ['Provide an existing PNG inside the project root, or a swipium:// artifact URI from this project.'],
      });
    return pathRefused(tpl.error, 'Copy the reference PNG into the project (e.g. .swipium/templates/) and pass its project-relative path.');
  }
  const shot = await capture(ctx);
  if ('error' in shot) return shot.error;
  const { png, coordinateSpace } = shot;
  let match;
  try {
    match = findTemplate(png, readFileSync(tpl.path), minScore ?? 0.85);
  } catch (e) {
    return qaError({
      what: `Image match failed: ${String(e)}`,
      changedState: false,
      retrySafe: true,
      nextSteps: ['Ensure the template is an 8-bit PNG smaller than the screen.'],
    });
  }
  const devicePoint = match.found ? toDevicePoint(coordinateSpace, match.x, match.y) : null;
  const payload: Record<string, unknown> = {
    mode: 'find_image',
    found: match.found,
    score: match.score,
    screenshotPoint: match.found ? { x: match.x, y: match.y } : null,
    devicePoint,
    coordinateSpace,
    method: 'visual',
    evidenceKind: 'visual_match',
    ...unverifiedNote(ctx),
  };
  if (match.found && tap)
    return tapAndRecord(ctx, devicePoint!, payload, { confidence: match.score, coordinateSpace }, `found (score ${match.score})`);
  return qaOk(
    payload,
    match.found
      ? `found (score ${match.score}) at screenshot (${match.x},${match.y}) → tap device (${devicePoint!.x},${devicePoint!.y}) via qa_act { action:"tap", target:{ x:${devicePoint!.x}, y:${devicePoint!.y} } }`
      : `not found (best score ${match.score} < ${minScore ?? 0.85})`,
  );
}

/** Record a visual assertion in one call: screenshot evidence + a qa_note(verifiedVisually) pass/fail
 *  (the former qa_assert_visual). For screens with no usable UI tree where the agent confirms a
 *  rendered result by eye. A pass is also recorded as a semantic `assert_visual` IR step so
 *  generated suites keep the check. */
async function assertVisual(ctx: VisualContext): Promise<CallToolResult> {
  const { sessions, session, args } = ctx;
  const assertion = args.assertion?.trim();
  if (!assertion)
    return qaError({
      what: 'assert requires an assertion',
      changedState: false,
      retrySafe: true,
      failureCode: 'INVALID_ARGUMENT',
      nextSteps: ['Pass assertion="Live Map rendered with the route polyline" (and pass:false if it is NOT visible).'],
    });
  const pass = args.pass ?? true;
  const shot = await capture(ctx);
  if ('error' in shot) return shot.error;
  const { png, coordinateSpace } = shot;
  const uri = saveCapture(ctx, `visual-${Date.now()}.png`, png, `visual assertion: ${assertion}`);
  sessions.addNote(session, {
    at: Date.now(),
    workflow: assertion,
    outcome: pass ? 'pass' : 'fail',
    reason: args.reason,
    method: 'visual',
    evidenceKind: 'visual_match',
    artifactUris: uri ? [uri] : [],
    verifiedVisually: true,
  });
  if (pass) {
    const screenshotCrop = coordinateSpace.screenshot
      ? { x: 0, y: 0, width: coordinateSpace.screenshot.width, height: coordinateSpace.screenshot.height }
      : undefined;
    sessions.addRecordedAction(session, {
      at: Date.now(),
      action: 'assert_visual',
      assertion,
      exportability: 'semantic',
      provenance: {
        ...(uri ? { screenshotUri: uri } : {}),
        selectorKind: 'visual_region',
        selectorValue: assertion,
        visual: { screenshotCrop, confidence: 1, density: coordinateSpace.density ?? null, orientation: coordinateSpace.orientation },
      },
    });
  }
  return qaOk(
    {
      mode: 'assert',
      assertion,
      pass,
      verifiedVisually: true,
      method: 'visual',
      evidenceKind: 'visual_match',
      screenshotUri: uri ?? null,
      coordinateSpace,
      ...unverifiedNote(ctx),
    },
    `visual assertion ${pass ? '✅ PASS' : '❌ FAIL'}: "${assertion}"\n${uri ? `evidence: ${uri}` : WITHHELD_EVIDENCE}`,
  );
}

const MODE_HANDLERS: Record<VisualMode, (ctx: VisualContext) => Promise<CallToolResult>> = {
  assert: assertVisual,
  baseline,
  diff,
  find_text: findText,
  find_image: findImage,
};

export function registerVisual(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_visual',
    {
      title: 'Visual assert / baseline / diff / find text / find image',
      description:
        'Screenshot-based checks for screens without a usable UI tree (maps, canvases, WDA-less iOS). mode: assert (pass/fail ' +
        'with screenshot evidence; pass:false if NOT visible), baseline (save .swipium/baselines/<name>.png in the repo), diff ' +
        '(vs a baseline; pass within threshold), find_text (OCR via a locally configured provider; consent-gated), find_image ' +
        '(template-match a project PNG). Finds return device coordinates + coordinateSpace; tap:true taps the hit (recorded + ' +
        'budgeted). Withheld when a password/OTP field is on screen unless force:true; on an unverified screen in a credential ' +
        'session only baseline needs force (diff/assert evidence is not saved). Details: docs/tools.md#qa_visual.',
      inputSchema: {
        sessionId: z.string(),
        mode: z.enum(VISUAL_MODES),
        assertion: z.string().optional().describe('assert: what you visually confirmed, e.g. "Live Map shows the route".'),
        pass: z.boolean().optional().describe('assert: default true; false if the expected result is NOT visible.'),
        reason: z.string().optional().describe('assert: extra detail (what you saw / why it failed).'),
        name: z.string().optional().describe('baseline/diff: baseline name, [A-Za-z0-9._-]{1,64}.'),
        query: z.string().optional().describe('find_text: text to find.'),
        template: z.string().optional().describe('find_image: PNG inside the project root, or a swipium:// artifact URI.'),
        threshold: z.number().optional().describe('diff: max changed fraction to pass (default 0.02).'),
        minScore: z.number().optional().describe('find_image: min match score 0..1 (default 0.85).'),
        minConfidence: z.number().optional().describe('find_text: min OCR confidence 0..1 (default 0.8).'),
        tap: z.boolean().optional().describe('find_text/find_image: tap the found point.'),
        force: z.boolean().optional().describe('Capture even if a secure field may be visible.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async (args) => {
      const session = sessions.get(args.sessionId);
      if (!session) return unknownSessionError(args.sessionId);
      const { driver, blocked } = await getDriver(session);
      if (!session || !driver) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target (Android) or qa_prepare_ios_target (iOS) first.'],
          })
        );
      }
      if (session.sensitive) return sensitiveRefusal('Visual capture');

      // Budget gate (B7): same rule as qa_act / qa_screenshot — no new capture or tap once spent.
      const stopReason = sessions.budgetStop(session);
      if (stopReason) return qaStop(stopReason, { counters: session.counters, mode: session.mode });

      // Secure-screen guard (same policy as qa_screenshot, THREAT_MODEL "Sensitive-screen
      // capture"): never persist or OCR password/OTP pixels by default. Without a fresh UI tree
      // (B8) the screen is unverified; in a session that has handled credentials only the
      // mode that persists a capture into the repo (baseline) requires force:true — the others
      // run, but never persist the capture (diff/assert evidence withheld), and find_text
      // screens the OCR text itself for password/OTP wording (withheld on a hit).
      const secureState = await refreshSecureState(session, driver);
      if (!args.force && secureState === 'secure') {
        return qaError({
          what: 'Withheld — a secure field (password/OTP) is on screen',
          changedState: false,
          retrySafe: true,
          failureCode: 'CAPTURE_WITHHELD_SECURE',
          nextSteps: ['Pass force:true to proceed (pixels are NOT redactable), or use a non-sensitive screen.'],
        });
      }
      const unverifiedCredentialScreen = !args.force && secureState === 'unknown' && hasSecretContext(session);
      if (unverifiedCredentialScreen && args.mode === 'baseline') {
        return qaError({
          what: 'Withheld — a baseline persists the screenshot, but no fresh UI tree can verify the screen has no password/OTP field, and this session has handled credentials',
          changedState: false,
          retrySafe: true,
          failureCode: 'CAPTURE_WITHHELD_SECURE',
          nextSteps: [
            'Run qa_snapshot to refresh the UI tree (when a structured backend is attached), or pass force:true to proceed (pixels are NOT redactable).',
          ],
        });
      }

      const ctx: VisualContext = {
        sessions,
        session,
        driver,
        args,
        redact: makeRedactor(session.secrets),
        secureState,
        withholdCapture: unverifiedCredentialScreen,
      };
      return MODE_HANDLERS[args.mode](ctx);
    },
  );
}
