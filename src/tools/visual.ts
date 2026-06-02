// qa_visual (PHASE3-PLAN §8.2) — local, deterministic visual intelligence for screens with no
// usable UI tree (maps/canvases/games), plus visual regression. Actions:
//   baseline   — save the current screen as a named baseline (.swipium/baselines/<name>.png)
//   diff       — compare the current screen to a baseline → changed-ratio + changed region
//   find_image — locate a reference image in the current screen → tappable coordinates
//   ocr        — OPTIONAL, consent-gated: run a locally-configured OCR command (none bundled)
// Every result carries the coordinate space so screenshot-pixel hits convert to tap pixels.

import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { isSecureNode, makeRedactor } from '../lib/redact.js';
import { displayArgv } from '../lib/commandTemplate.js';
import { GitScopeForbiddenError } from '../lib/spawn.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { imageDiff, findTemplate } from '../lib/image.js';
import { captureCoordinateSpace, toDevicePoint } from '../lib/coordSpace.js';
import { configuredOcrCommand, runOcr } from '../visual/ocr.js';
import { boundedText, resolveMaskProvider, resolveVisualProvider } from '../visual/provider.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerVisual(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_visual',
    {
      title: 'Visual matching',
      description:
        'Local, deterministic visual ops for screens without a usable UI tree, and visual regression. action: ' +
        'baseline (save current screen as a named reference), diff (compare current vs a baseline → changed ratio + region; pass if within threshold), ' +
        'find_image (locate a reference PNG in the current screen → tappable device coordinates), ocr (OPTIONAL, consent-gated; runs a locally-configured OCR command — none is bundled). ' +
        'Results include coordinateSpace so screenshot-pixel hits convert to qa_act {x,y} device pixels.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['baseline', 'diff', 'find_image', 'ocr']),
        name: z.string().optional().describe('Baseline name (for baseline/diff).'),
        template: z.string().optional().describe('Path to a reference PNG (for find_image); absolute or relative to the project root.'),
        threshold: z.number().optional().describe('diff: max changed fraction to still PASS (default 0.02).'),
        minScore: z.number().optional().describe('find_image: min match confidence 0..1 (default 0.85).'),
        force: z.boolean().optional().describe('Capture even if a secure field is on screen (pixels are not redactable).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, name, template, threshold, minScore, force, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) {
        return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target first.'] });
      }
      if (session.sensitive) return sensitiveRefusal('Visual capture');

      // Secure-screen guard (same as qa_screenshot): never persist password/OTP pixels by default.
      const hasSecure = session.lastSnapshot ? [...session.lastSnapshot.fullByRef.values()].some((n) => isSecureNode(n)) : false;
      if (hasSecure && !force) {
        return qaError({ what: 'Withheld — a secure field (password/OTP) is on screen', changedState: false, retrySafe: true, nextSteps: ['Pass force:true to proceed (pixels are NOT redactable), or use a non-sensitive screen.'] });
      }

      const baselinesDir = join(session.root, '.swipium', 'baselines');

      // ---- ocr: optional + consent-gated; only if a command is configured ----
      if (action === 'ocr') {
        const ocrCommand = configuredOcrCommand(session.root);
        if (!ocrCommand) {
          return qaError({
            what: 'OCR is not configured',
            changedState: false,
            retrySafe: false,
            failureCode: 'VISUAL_ONLY_SCREEN',
            nextSteps: ['Set an OCR command in .swipium/config.json ("ocrCommand": ["your-ocr", "{image}"]) or SWIPIUM_OCR_CMD env, then retry. Or use find_image / qa_assert_visual.'],
          });
        }
        let preview;
        let maskPreview;
        try {
          preview = resolveVisualProvider(ocrCommand, { image: '<screenshot>' }, 30000);
          maskPreview = resolveMaskProvider(session.root);
        } catch (e) {
          return qaError({ what: e instanceof GitScopeForbiddenError ? e.message : `Invalid OCR command template: ${String(e)}`, changedState: false, retrySafe: !(e instanceof GitScopeForbiddenError), failureCode: e instanceof GitScopeForbiddenError ? 'GIT_SCOPE_FORBIDDEN' : 'INVALID_FLOW', nextSteps: e instanceof GitScopeForbiddenError ? ['Run Git yourself outside Swipium; configure ocrCommand to use a non-Git executable.'] : ['Use an argv array in .swipium/config.json, e.g. ["node","ocr.js","{image}"].'] });
        }
        const maskConfigured = !!maskPreview;
        const gate = consumeConsent(consentId, approve, { action: 'ocr_run', affects: { argv: preview.argv, io: preview.io, maskConfigured } });
        if (!gate.approved) {
          return requireConsent({ action: 'ocr_run', risk: 'medium', exactCommand: displayArgv(preview.argv), affects: { argv: preview.argv, io: preview.io, maskConfigured }, explain: 'Run the configured OCR command on a screenshot of the current screen? The screen image is passed to that local program or via the Swipium JSON provider contract. If visualMaskCommand is configured, Swipium runs it first and sends the masked image.' });
        }
        try {
          const ocr = await runOcr(driver, session.root, ocrCommand);
          const bounded = boundedText(ocr.text.trim(), makeRedactor(session.secrets), 8000);
          return qaOk(
            { action, method: 'ocr', evidenceKind: 'ocr_text', text: bounded.text, truncated: bounded.truncated, regions: ocr.regions, coordinateSpace: ocr.coordinateSpace, provider: ocr.provider, masking: ocr.masking },
            `OCR text (${bounded.text.length}${bounded.truncated ? '+ truncated' : ''} chars):\n${bounded.text.slice(0, 2000)}`,
          );
        } catch (e) {
          return qaError({ what: `OCR command failed: ${String(e)}`, changedState: false, retrySafe: true, nextSteps: ['Check the configured OCR command runs standalone on a PNG.'] });
        }
      }

      // capture once for the pixel actions
      let png: Buffer;
      try {
        png = await driver.screenshot();
      } catch (e) {
        return qaError({ what: `Screenshot failed: ${String(e)}`, changedState: false, retrySafe: true, nextSteps: ['Confirm the device is online.'] });
      }
      const coordinateSpace = await captureCoordinateSpace(driver, png);

      if (action === 'baseline') {
        if (!name) return qaError({ what: 'baseline requires a name', changedState: false, retrySafe: true, nextSteps: ['Pass name="home-screen".'] });
        mkdirSync(baselinesDir, { recursive: true });
        writeFileSync(join(baselinesDir, `${name}.png`), png);
        const uri = sessions.saveArtifact(session, 'baseline', `${name}.png`, png, 'image/png', `visual baseline: ${name}`);
        return qaOk({ action, name, uri, coordinateSpace }, `saved baseline "${name}" (${png.length} bytes) → ${uri}`);
      }

      if (action === 'diff') {
        if (!name) return qaError({ what: 'diff requires a baseline name', changedState: false, retrySafe: true, nextSteps: ['Pass the name used with action:"baseline".'] });
        const basePath = join(baselinesDir, `${name}.png`);
        if (!existsSync(basePath)) {
          return qaError({ what: `No baseline "${name}" — capture one first`, changedState: false, retrySafe: true, nextSteps: [`Call qa_visual { action: "baseline", name: "${name}" } on the reference screen.`] });
        }
        const result = imageDiff(readFileSync(basePath), png);
        const tol = threshold ?? 0.02;
        const pass = result.comparable && result.ratio <= tol;
        const currentUri = sessions.saveArtifact(session, 'screenshot', `diff-${name}-${Date.now()}.png`, png, 'image/png', `diff vs baseline ${name}`);
        const deviceBox = result.box ? { x: toDevicePoint(coordinateSpace, result.box.x, result.box.y).x, y: toDevicePoint(coordinateSpace, result.box.x, result.box.y).y, width: Math.round(result.box.width / (coordinateSpace.scale ?? 1)), height: Math.round(result.box.height / (coordinateSpace.scale ?? 1)) } : null;
        return qaOk(
          { action, name, method: 'visual', comparable: result.comparable, reason: result.reason, changedRatio: Math.round(result.ratio * 10000) / 10000, threshold: tol, pass, changedBox: result.box, changedBoxDevice: deviceBox, currentUri, coordinateSpace },
          `diff vs "${name}": ${result.comparable ? `${(result.ratio * 100).toFixed(2)}% changed (threshold ${(tol * 100).toFixed(1)}%) → ${pass ? '✅ PASS' : '❌ FAIL'}` : `not comparable: ${result.reason}`}\nevidence: ${currentUri}`,
        );
      }

      // action === 'find_image'
      if (!template) return qaError({ what: 'find_image requires a template path', changedState: false, retrySafe: true, nextSteps: ['Pass template="/abs/or/project-relative/reference.png".'] });
      const tplPath = isAbsolute(template) ? template : join(session.root, template);
      if (!existsSync(tplPath)) return qaError({ what: `Template not found: ${tplPath}`, changedState: false, retrySafe: true, nextSteps: ['Provide an existing PNG path.'] });
      let match;
      try {
        match = findTemplate(png, readFileSync(tplPath), minScore ?? 0.85);
      } catch (e) {
        return qaError({ what: `Image match failed: ${String(e)}`, changedState: false, retrySafe: true, nextSteps: ['Ensure the template is an 8-bit PNG smaller than the screen.'] });
      }
      const devicePoint = match.found ? toDevicePoint(coordinateSpace, match.x, match.y) : null;
      return qaOk(
        { action, found: match.found, score: match.score, screenshotPoint: match.found ? { x: match.x, y: match.y } : null, devicePoint, coordinateSpace },
        match.found
          ? `found (score ${match.score}) at screenshot (${match.x},${match.y}) → tap device (${devicePoint!.x},${devicePoint!.y}) via qa_act { action:"tap", target:{ x:${devicePoint!.x}, y:${devicePoint!.y} } }`
          : `not found (best score ${match.score} < ${minScore ?? 0.85})`,
      );
    },
  );
}
