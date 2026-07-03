// qa_screenshot — capture the screen, save as a session artifact, return a resource URI
// (not inline bytes, DESIGN §4). Sensitive-mode: if a secure field is on screen, withhold
// by default (pixels can't be redacted) unless force:true.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, qaStop } from '../lib/result.js';
import { isSecureNode } from '../lib/redact.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { captureCoordinateSpace } from '../lib/coordSpace.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerScreenshot(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_screenshot',
    {
      title: 'Capture a screenshot',
      description:
        "Capture the current screen, save it as a session artifact, and return a resource URI (swipium://…) — not inline image bytes. If a secure field (password/OTP) is on screen the capture is withheld unless force:true, since screenshot pixels can't be redacted. Requires qa_prepare_target.",
      inputSchema: {
        sessionId: z.string(),
        force: z.boolean().optional(),
        reason: z.string().optional().describe('Short label of what this screenshot documents (shown in qa_report).'),
      },
    },
    async ({ sessionId, force, reason }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) {
        return qaError({
          what: 'No device attached to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_prepare_target first.'],
        });
      }

      if (session.sensitive) return sensitiveRefusal('Screenshot');

      const stopReason = sessions.budgetStop(session);
      if (stopReason) return qaStop(stopReason, { counters: session.counters, mode: session.mode });

      // Sensitive screen guard (M6): based on the latest snapshot's nodes.
      const hasSecure = session.lastSnapshot ? [...session.lastSnapshot.fullByRef.values()].some((n) => isSecureNode(n)) : false;
      if (hasSecure && !force) {
        return qaError({
          what: 'Screenshot withheld — a secure field (password/OTP) is on screen',
          changedState: false,
          retrySafe: true,
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
          ? '\n⚠ A secure field (password/OTP) was on screen and screenshot pixels are NOT redacted — treat this artifact as sensitive.'
          : '';
        return qaOk(
          {
            uri,
            path: rec.path,
            bytes: png.length,
            coordinateSpace,
            redaction: rec.redaction,
            sensitiveForced: hasSecure ? true : undefined,
            counters: session.counters,
            ...(budgetReached ? { budgetReached } : {}),
          },
          `Saved screenshot #${n} (${png.length} bytes) → ${uri}${secureWarning}\ncoordinate space: ${coordinateSpace.screenshot?.width}x${coordinateSpace.screenshot?.height} screenshot px, scale ${coordinateSpace.scale}, ${coordinateSpace.orientation}${budgetReached ? `\n⏹ budget reached: ${budgetReached} — call qa_report.` : ''}`,
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
