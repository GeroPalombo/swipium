// qa_locator_suggest (NEXT-PLAN: Locator And Maintainability) — for the current screen, recommend
// the most durable locator for each element + score it, and grade the screen's "automation
// readiness" (how much of the interactive UI has a durable testID/accessibility handle). This
// tells a developer exactly which controls need testIDs to make flows non-brittle.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { parseSnapshot, signature } from '../snapshot/parse.js';
import { suggestLocator, automationReadiness, locatorReadinessIssues, type LocatorPlatform } from '../oracle/locator.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerLocator(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_locator_suggest',
    {
      title: 'Suggest durable locators',
      description:
        "For the current screen, recommend the most durable locator for each element (priority: accessibility/content-desc > resource-id/testID > visible text > structure > coordinate) with a durability score, and grade the screen's automation readiness — listing exactly which interactive controls need a testID. Use this to make generated flows non-brittle and to hand developers an actionable testID to-do list. Needs a structured UI tree (not the iOS simulator / visual-fallback).",
      inputSchema: {
        sessionId: z.string(),
        interactiveOnly: z.boolean().optional().describe('Only score clickable elements (default false → all addressable elements).'),
      },
    },
    async ({ sessionId, interactiveOnly }) => {
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
      if (driver.kind === 'simulator' || session.mode === 'visual-fallback') {
        return qaError({
          what: 'Locator suggestions need a structured UI tree, which this backend/screen lacks',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: [
            'On the iOS simulator or a visual-only screen there is no a11y tree to score. Use qa_visual / qa_assert_visual instead.',
          ],
        });
      }

      let xml: string;
      try {
        xml = await driver.dumpXml();
      } catch (e) {
        return qaError({
          what: `Could not read the UI tree: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          failureCode: 'SNAPSHOT_FAILED',
          nextSteps: ['Retry on a settled screen.'],
        });
      }
      const parsed = parseSnapshot(xml, { interactiveOnly: interactiveOnly ?? false });
      session.lastSnapshot = {
        fullByRef: parsed.fullByRef,
        signatures: new Set(parsed.elements.map(signature)),
        allNodes: parsed.allNodes,
      };

      const platform: LocatorPlatform =
        driver.kind === 'wda' ? 'ios' : driver.kind === 'direct' || driver.kind === 'remote' ? 'android' : 'generic';
      const suggestions = parsed.elements.map((el) => suggestLocator(el, { platform }));
      const readiness = automationReadiness(suggestions, parsed.elements, { platform });
      const issues = locatorReadinessIssues(suggestions, parsed.elements, { platform });
      const tierTally = suggestions.reduce<Record<string, number>>((a, s) => ((a[s.tier] = (a[s.tier] ?? 0) + 1), a), {});

      const summary =
        `automation readiness: ${readiness.grade} (${readiness.durablePct}% of ${readiness.interactiveCount} interactive controls have a durable ${platform === 'ios' ? 'accessibilityIdentifier' : 'testID/a11y'} handle)\n` +
        `platform: ${platform}\n` +
        `locator tiers: ${Object.entries(tierTally)
          .map(([t, n]) => `${t}=${n}`)
          .join(' ')}\n` +
        (issues.length
          ? `issues:\n${issues
              .slice(0, 8)
              .map((i) => `  - ${i.code}: ${i.message}`)
              .join('\n')}\n`
          : '') +
        (readiness.needTestIds.length
          ? `needs a testID (${readiness.needTestIds.length}):\n` +
            readiness.needTestIds
              .slice(0, 15)
              .map(
                (n) =>
                  `  - ${n.ref} [${n.role}] — ${n.hint}${n.suggestedTestId ? `; suggested ${platform === 'ios' ? 'accessibilityIdentifier' : 'testID'}: ${n.suggestedTestId}` : ''}`,
              )
              .join('\n')
          : 'every interactive control already has a durable locator ✅');

      return qaOk({ platform, readiness, suggestions, tierTally, issues }, summary);
    },
  );
}
