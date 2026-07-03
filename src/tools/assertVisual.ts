// qa_assert_visual — record a VISUAL assertion in one call: capture a screenshot as evidence
// and file a qa_note(verifiedVisually) pass/fail. For screens with no usable structured tree
// (maps, canvases, animations) where the agent confirms a rendered result by eye. Replaces the
// two-step qa_screenshot + qa_note(verifiedVisually) idiom with a single intent-revealing tool.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { captureCoordinateSpace } from '../lib/coordSpace.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerAssertVisual(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_assert_visual',
    {
      title: 'Assert a visual result',
      description:
        'Record a visual assertion for a screen that has no usable structured tree (map/canvas/animation): captures a screenshot as evidence and files a test outcome with verifiedVisually=true. Use `pass:false` if the expected thing is NOT visible. Equivalent to qa_screenshot + qa_note(verifiedVisually) but in one call. Returns the screenshot URI and the recorded note.',
      inputSchema: {
        sessionId: z.string(),
        assertion: z.string().describe('what you visually confirmed, e.g. "Live Map rendered with the route polyline"'),
        pass: z.boolean().optional().describe('default true; set false if the expected result is NOT visible'),
        reason: z.string().optional().describe('extra detail (what you saw / why it failed)'),
      },
    },
    async ({ sessionId, assertion, pass = true, reason }) => {
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
      if (session.sensitive) return sensitiveRefusal('Visual assertion (screenshot)');
      let uri: string;
      let coordinateSpace;
      try {
        const png = await driver.screenshot();
        uri = sessions.saveArtifact(session, 'screenshot', `visual-${Date.now()}.png`, png, 'image/png', `visual assertion: ${assertion}`);
        sessions.bump(session, 'screenshots');
        coordinateSpace = await captureCoordinateSpace(driver, png);
      } catch (e) {
        return qaError({
          what: `Could not capture the screenshot evidence: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Confirm the device is online (qa_doctor), then retry.'],
        });
      }
      sessions.addNote(session, {
        at: Date.now(),
        workflow: assertion,
        outcome: pass ? 'pass' : 'fail',
        reason,
        method: 'visual',
        evidenceKind: 'visual_match',
        artifactUris: [uri],
        verifiedVisually: true,
      });
      if (pass) {
        const screenshotCrop = coordinateSpace?.screenshot
          ? { x: 0, y: 0, width: coordinateSpace.screenshot.width, height: coordinateSpace.screenshot.height }
          : undefined;
        sessions.addRecordedAction(session, {
          at: Date.now(),
          action: 'assert_visual',
          assertion,
          exportability: 'semantic',
          provenance: {
            screenshotUri: uri,
            selectorKind: 'visual_region',
            selectorValue: assertion,
            visual: {
              screenshotCrop,
              confidence: 1,
              density: coordinateSpace?.density ?? null,
              orientation: coordinateSpace?.orientation,
            },
          },
        });
      }
      return qaOk(
        { assertion, pass, verifiedVisually: true, method: 'visual', screenshotUri: uri, coordinateSpace },
        `visual assertion ${pass ? '✅ PASS' : '❌ FAIL'}: "${assertion}"\nevidence: ${uri}`,
      );
    },
  );
}
