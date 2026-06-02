import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { getDriver } from '../session/attach.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import type { SessionStore } from '../session/store.js';

export function registerInputCapabilities(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_input_capabilities',
    {
      title: 'Text input capabilities',
      description: 'Report backend text-entry constraints: ASCII safety, Unicode support, clipboard/paste availability, and WDA typing-frequency tuning. Use before generating fixture-backed form flows.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Prepare a target first.'] });
      const wda = driver.kind === 'wda' ? loadWdaConfig(session.root) : null;
      const caps = {
        backend: driver.kind,
        asciiSafe: true,
        unicodeSupport: driver.kind === 'direct' ? 'limited_android_adb_text' : driver.kind === 'wda' ? 'wda_type_text' : driver.kind === 'remote' ? 'appium_driver_dependent' : 'limited',
        pasteClipboardAvailable: false,
        maxTypingFrequency: typeof wda?.settings.maxTypingFrequency === 'number' ? wda.settings.maxTypingFrequency : null,
        unsupportedFailureCode: 'TEXT_INPUT_UNSUPPORTED',
        policy: driver.kind === 'direct'
          ? 'Prefer ASCII fixture values on Android DirectDriver; use declared generators that emit ASCII or a backend with Unicode-safe text entry.'
          : 'Fixture text entry is supported, but keep secrets in variables and tune WDA/Appium settings if typing flakes.',
      };
      return qaOk(caps, `input capabilities: ${driver.kind}; unicode=${caps.unicodeSupport}; clipboard=${caps.pasteClipboardAvailable}`);
    },
  );
}
