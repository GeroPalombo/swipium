// qa_screenshot: capture the screen, save as a session artifact, return a resource URI
// (not inline bytes). Sensitive-mode: if a secure field is on screen, withhold
// by default (pixels can't be redacted) unless force:true.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, qaStop, unknownSessionError } from '../lib/result.js';
import { isSecureNode } from '../lib/redact.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { captureCoordinateSpace } from '../lib/coordSpace.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerScreenshot(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_screenshot',
    {
      title: 'Capture a screenshot',
      description:
        'Capture the screen as a session artifact and return its swipium:// URI (not inline bytes). Withheld when a ' +
        'password/OTP field is on screen unless force:true (pixels cannot be redacted). Counts against the screenshot budget.',
      inputSchema: {
        sessionId: z.string(),
        force: z.boolean().optional(),
        reason: z.string().optional().describe('What it documents (shown in qa_report).'),
      },
    },
    async ({ sessionId, force, reason }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver, blocked } = await getDriver(session);
      if (!session || !driver) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: ['Call qa_prepare_target first.'],
          })
        );
      }

      if (session.sensitive) return sensitiveRefusal('Screenshot');

      const stopReason = sessions.budgetStop(session);
      if (stopReason) return qaStop(stopReason, { counters: session.counters, mode: session.mode });

      // Sensitive screen guard (M6): based on the latest snapshot's nodes.
      const hasSecure = session.lastSnapshot ? [...session.lastSnapshot.fullByRef.values()].some((n) => isSecureNode(n)) : false;
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
        const png = await driver.screenshot();
        const n = ++session.screenshotCount;
        const uri = sessions.saveArtifact(session, 'screenshot', `screenshot-${n}.png`, png, 'image/png', reason);
        const rec = sessions.findArtifact(uri)!.rec;
        sessions.bump(session, 'screenshots');
        const coordinateSpace = await captureCoordinateSpace(driver, png);
        const budgetReached = sessions.budgetStop(session);
        // Pixels are never redacted (redaction: "not-applied" on the artifact). When force:true
        // captured a screen with a secure field, say so explicitly so the agent can treat the
        // artifact as sensitive.
        const secureWarning = hasSecure
          ? '\n⚠ A secure field (password/OTP) was on screen and screenshot pixels are NOT redacted. Treat this artifact as sensitive.'
          : '';
        return qaOk(
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
          },
          `Saved screenshot #${n} (${png.length} bytes) > ${uri}${secureWarning}\ncoordinate space: ${coordinateSpace.screenshot?.width}x${coordinateSpace.screenshot?.height} screenshot px, scale ${coordinateSpace.scale}, ${coordinateSpace.orientation}${budgetReached ? `\n⏹ budget reached: ${budgetReached}, call qa_report.` : ''}`,
        );
      } catch (e) {
        return qaError({
          what: `Screenshot failed: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Confirm the device is still online (`adb devices`).'],
        });
      }
    },
  );
}
