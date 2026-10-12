// qa_screenshot: capture the screen, save as a session artifact, return a resource URI
// (not inline bytes). Sensitive-mode: if a secure field is on screen, withhold
// by default (pixels can't be redacted) unless force:true.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, qaStop, unknownSessionError } from '../lib/result.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { captureCoordinateSpace } from '../lib/coordSpace.js';
import { INLINE_IMAGE_META, inlineScaleLine, prepareInlineImage } from '../lib/image.js';
import { blockedDeviceResult, getDriver, prepareFirstStep } from '../session/attach.js';
import { refreshSecureState, secureScreenState } from './visual.js';
import type { SessionStore } from '../session/store.js';
import { deviceGoneNextSteps, isDeviceGoneError } from '../lib/deviceGone.js';
import { diagnoseIosOutage, isIosSession } from '../lib/iosOutage.js';
import { isMetroRequiredFinding, launchErrorSurface, type Finding } from '../oracle/health.js';
import { launchErrorText } from '../oracle/record.js';
import type { RawNode } from '../snapshot/parse.js';

/** The qa_screenshot line for a RedBox / Expo dev launcher on screen (E2E NEW-17). */
function redBoxWarning(f: Finding): string {
  return isMetroRequiredFinding(f)
    ? `⚠ METRO_REQUIRED: ${launchErrorText(f)}: the debug build has no JS bundle. This screenshot is not evidence the app works; start Metro (qa_metro { action:"start" }) and relaunch.`
    : `⚠ ${launchErrorText(f)}: an app error screen, not a working app. Record it (qa_check_health) instead of a pass.`;
}

export function registerScreenshot(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_screenshot',
    {
      title: 'Capture a screenshot',
      description:
        'Save a screenshot as a session artifact and return its swipium:// URI. Withheld on password/OTP screens unless ' +
        'force:true. Counts against the screenshot budget. inline:true also returns the image (JPEG, long edge 1568 px, ' +
        'scale in the text) for clients that can see images.',
      inputSchema: {
        sessionId: z.string(),
        force: z.boolean().optional(),
        reason: z.string().optional().describe('What it documents (shown in qa_report).'),
        inline: z.boolean().optional().describe('Also return the image inline (the result then has no structuredContent).'),
      },
    },
    async ({ sessionId, force, reason, inline }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      // TOOL-19: refuse before the device lookup, so a sensitive session never sees NO_DEVICE first.
      if (session.sensitive) return sensitiveRefusal('Screenshot');
      const { driver, blocked } = await getDriver(session);
      if (!session || !driver) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: [prepareFirstStep(session)],
          })
        );
      }

      const stopReason = sessions.budgetStop(session);
      if (stopReason) return qaStop(stopReason, { counters: session.counters, mode: session.mode });

      // Sensitive screen guard (M6): the latest snapshot's nodes while it still describes the screen;
      // after an action or screen change (or with none) a structured backend re-dumps first, so a
      // stale "no password field" snapshot never lets a login screen through (qa_visual's rule).
      // A visual-fallback session keeps the cached answer (its dumps are known to fail).
      const seen: { nodes?: RawNode[] } = {};
      const hasSecure =
        (session.mode === 'visual-fallback' ? secureScreenState(session, seen) : await refreshSecureState(session, driver, seen)) ===
        'secure';
      // E2E NEW-17: the same tree, checked for an RN RedBox / Expo dev launcher (no extra device call;
      // no tree, as on a visual-only simulator, means no check).
      const appError = seen.nodes ? launchErrorSurface(seen.nodes) : undefined;
      if (hasSecure && !force) {
        return qaError({
          what: 'Screenshot withheld: a secure field (password/OTP) is on screen',
          changedState: false,
          retrySafe: true,
          failureCode: 'CAPTURE_WITHHELD_SECURE',
          nextSteps: ['Pass force:true to capture anyway (pixels are NOT redactable), or screenshot a non-sensitive screen.'],
        });
      }

      try {
        // E2E NEW-10: note whether the app under test is in front, so qa_report counts only such a
        // screenshot as "reached the app" (bounded; it runs alongside the capture).
        const appId = session.appId;
        const foreground = appId
          ? Promise.race([driver.foregroundOwner().catch(() => ''), new Promise<string>((r) => setTimeout(() => r(''), 1500).unref())])
          : Promise.resolve('');
        const png = await driver.screenshot();
        const n = ++session.screenshotCount;
        const uri = sessions.saveArtifact(session, 'screenshot', `screenshot-${n}.png`, png, 'image/png', reason);
        const rec = sessions.findArtifact(uri)!.rec;
        const fgPkg = (await foreground).split('/')[0];
        // A RedBox screenshot shows the app was not usable: never "reached the app" evidence.
        if (appId && fgPkg && fgPkg.startsWith(appId) && !appError) rec.appForeground = true;
        sessions.bump(session, 'screenshots');
        const coordinateSpace = await captureCoordinateSpace(driver, png);
        const budgetReached = sessions.budgetStop(session);
        // Pixels are never redacted (redaction: "not-applied" on the artifact). When force:true
        // captured a screen with a secure field, say so explicitly so the agent can treat the
        // artifact as sensitive.
        const secureWarning = hasSecure
          ? '\n⚠ A secure field (password/OTP) was on screen and screenshot pixels are NOT redacted. Treat this artifact as sensitive.'
          : '';
        const result = qaOk(
          {
            uri,
            path: rec.path,
            bytes: png.length,
            coordinateSpace,
            redaction: rec.redaction,
            ...(rec.redaction === 'partial' && rec.redactionNote ? { redactionNote: rec.redactionNote } : {}),
            sensitiveForced: hasSecure ? true : undefined,
            counters: session.counters,
            ...(budgetReached ? { budgetReached } : {}),
            ...(appError
              ? { appError: { ...appError, ...(isMetroRequiredFinding(appError) ? { failureCode: 'METRO_REQUIRED' } : {}) } }
              : {}),
          },
          `Saved screenshot #${n} (${png.length} bytes) > ${uri}${secureWarning}${appError ? `\n${redBoxWarning(appError)}` : ''}\ncoordinate space: ${coordinateSpace.screenshot?.width}x${coordinateSpace.screenshot?.height} screenshot px, scale ${coordinateSpace.scale}, ${coordinateSpace.orientation}${budgetReached ? `\n⏹ budget reached: ${budgetReached}, call qa_report.` : ''}`,
        );
        if (!inline) return result;
        // Inline: text + image only. Codex drops image blocks from a result that carries
        // structuredContent, so the payload travels in the text block (its fence) instead.
        const img = await prepareInlineImage(png, 'image/png');
        const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
        return {
          content: [
            { type: 'text', text: `${text}\n${inlineScaleLine(img, coordinateSpace.screenshot ?? null)}` },
            { type: 'image', data: img.data.toString('base64'), mimeType: img.mime, _meta: INLINE_IMAGE_META },
          ],
        };
      } catch (e) {
        if (isDeviceGoneError(e))
          return qaError({
            what: `Device offline: screenshot failed: ${String(e)}`,
            changedState: false,
            retrySafe: false,
            failureCode: 'NO_DEVICE',
            nextSteps: deviceGoneNextSteps(session.device),
          });
        const outage = await diagnoseIosOutage(session, e);
        if (outage)
          return qaError({
            what: `Screenshot failed: ${outage.what}`,
            changedState: false,
            retrySafe: true,
            failureCode: outage.failureCode,
            nextSteps: outage.nextSteps,
          });
        return qaError({
          what: `Screenshot failed: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          nextSteps: [
            isIosSession(session)
              ? 'Confirm the simulator is still booted (qa_ios { action:"list" }); if it was shut down, re-run qa_prepare_ios_target.'
              : 'Confirm the device is still online (`adb devices`).',
          ],
        });
      }
    },
  );
}
