import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { makeRedactor } from '../lib/redact.js';
import { displayArgv } from '../lib/commandTemplate.js';
import { GitScopeForbiddenError } from '../lib/spawn.js';
import { boundedText, resolveMaskProvider, resolveVisualProvider } from '../visual/provider.js';
import { getDriver } from '../session/attach.js';
import { configuredOcrCommand, findOcrRegion, runOcr } from '../visual/ocr.js';
import type { SessionStore } from '../session/store.js';

export function registerVisualText(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_visual_find_text',
    {
      title: 'Find visible text with OCR',
      description:
        'Find visible text in a screenshot using a configured OCR provider that returns structured regions. Returns screenshot-pixel bbox, coordinate-space metadata, and tappable device coordinates. Consent-gated because the screenshot is passed to the local OCR command.',
      inputSchema: {
        sessionId: z.string(),
        query: z.string(),
        minConfidence: z.number().optional(),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, query, minConfidence, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Prepare a target first.'] });
      if (session.sensitive) return sensitiveRefusal('OCR visual text search');
      const command = configuredOcrCommand(session.root);
      if (!command) return qaError({ what: 'OCR is not configured', changedState: false, retrySafe: false, failureCode: 'VISUAL_ONLY_SCREEN', nextSteps: ['Set ocrCommand in .swipium/config.json as an argv array or SWIPIUM_OCR_CMD. The command should emit JSON regions with text/confidence/bbox.'] });
      let preview;
      let maskPreview;
      try {
        preview = resolveVisualProvider(command, { image: '<screenshot>' }, 30000);
        maskPreview = resolveMaskProvider(session.root);
      } catch (e) {
        return qaError({ what: e instanceof GitScopeForbiddenError ? e.message : `Invalid OCR command template: ${String(e)}`, changedState: false, retrySafe: !(e instanceof GitScopeForbiddenError), failureCode: e instanceof GitScopeForbiddenError ? 'GIT_SCOPE_FORBIDDEN' : 'INVALID_FLOW', nextSteps: e instanceof GitScopeForbiddenError ? ['Run Git yourself outside Swipium; configure ocrCommand to use a non-Git executable.'] : ['Use an argv array in .swipium/config.json, e.g. ["node","ocr.js","{image}"].'] });
      }
      const maskConfigured = !!maskPreview;
      const gate = consumeConsent(consentId, approve, { action: 'ocr_run', affects: { argv: preview.argv, io: preview.io, query, maskConfigured } });
      if (!gate.approved) {
        return requireConsent({
          action: 'ocr_run',
          risk: 'medium',
          exactCommand: displayArgv(preview.argv),
          affects: { argv: preview.argv, io: preview.io, query, maskConfigured },
          explain: `Run the configured OCR command on the current screenshot to find "${query}"? If visualMaskCommand is configured, Swipium runs it first and sends the masked image.`,
        });
      }
      const ocr = await runOcr(driver, session.root, command);
      const hit = findOcrRegion(ocr, query, minConfidence ?? 0.8);
      if (!hit) {
        const bounded = boundedText(ocr.text, makeRedactor(session.secrets), 8000);
        return qaOk({ found: false, query, text: bounded.text, truncated: bounded.truncated, regions: ocr.regions, coordinateSpace: ocr.coordinateSpace, provider: ocr.provider, masking: ocr.masking, evidenceKind: 'ocr_text' }, `OCR did not find "${query}" at confidence >= ${minConfidence ?? 0.8}.`);
      }
      return qaOk(
        { found: true, query, region: hit.region, devicePoint: hit.devicePoint, coordinateSpace: ocr.coordinateSpace, method: 'ocr', locatorStrategy: 'ocr_text', evidenceKind: 'ocr_text', provider: ocr.provider, masking: ocr.masking },
        `found "${hit.region.text}" (${hit.region.confidence}) → tap device (${hit.devicePoint.x}, ${hit.devicePoint.y})`,
      );
    },
  );
}
