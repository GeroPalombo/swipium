// qa_prepare_ios_target (hardening P0.3) — one high-level iOS prepare: boot simulator → install
// .app → launch bundle → verify → report WDA/visual mode. The cross-platform counterpart to
// qa_prepare_target's Android path, so qa_test_this can complete iOS first-runs end-to-end.

import { z } from 'zod';
import { isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail, type FailureCode } from '../oracle/failures.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { prepareIos } from '../services/prepareIos.js';
import type { Session, SessionStore } from '../session/store.js';

/** A .app is a directory — hash a stable signature (Info.plist) for consent binding. */
function appSignature(appPath: string): string {
  try {
    const plist = join(appPath, 'Info.plist');
    if (existsSync(plist)) return createHash('sha256').update(readFileSync(plist)).digest('hex').slice(0, 16);
    return createHash('sha256').update(`${appPath}:${statSync(appPath).mtimeMs}`).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

function externalToRoot(session: Session, appPath: string): boolean {
  const abs = isAbsolute(appPath) ? appPath : join(session.root, appPath);
  return !abs.startsWith(session.root);
}

export function registerPrepareIosTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_prepare_ios_target',
    {
      title: 'Prepare an iOS simulator target',
      description:
        'High-level iOS simulator prepare: pick + boot a simulator, install a simulator .app (consent-gated), launch its bundle id, verify foreground, and report whether structured automation (WDA) is available or it is honestly visual-only. Refuses a .ipa on the simulator (real-device only). attachWda: auto (use WDA if reachable, else visual) | required (fail if no WDA) | skip (visual-only). Returns typed blockers (IPA_NEEDS_REAL_DEVICE, IOS_SIMULATOR_APP_MISSING, SIMULATOR_BOOT_FAILED, WDA_UNREACHABLE).',
      inputSchema: {
        sessionId: z.string(),
        app: z.string().optional().describe('Simulator .app path (absolute or project-relative).'),
        bundleId: z.string().optional(),
        simulator: z.string().optional().describe('Simulator udid or name substring.'),
        launch: z.boolean().optional(),
        attachWda: z.enum(['auto', 'required', 'skip']).optional(),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, app, bundleId, simulator, launch, attachWda, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId "${sessionId}"`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });

      // Installing app code is privileged → consent (mirrors qa_ios install).
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } | undefined;
      let installAffects: { appPath: string; sig: string; external: boolean } | undefined;
      if (app) {
        const abs = isAbsolute(app) ? app : join(session.root, app);
        const sig = appSignature(abs);
        const affects = { appPath: abs, sig, external: externalToRoot(session, app) };
        installAffects = affects;
        const gate = consumeConsent(consentId, approve, { action: 'install_app', affects });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_prepare_ios_target',
            action: 'install_app',
            risk: affects.external ? 'medium' : 'low',
            target: affects,
            consent: { required: true, approved: false, payloadHash: sig },
            status: 'requested',
          });
          return requireConsent({
            action: 'install_app', risk: affects.external ? 'medium' : 'low',
            exactCommand: `xcrun simctl install <booted> ${abs}`,
            affects,
            explain: `Boot a simulator and install ${abs}${affects.external ? ' (outside the project root)' : ''}? It runs third-party app code.`,
          });
        }
        mutationConsent = { required: true, consentId, approved: true, payloadHash: sig };
        sessions.recordMutation(session, {
          tool: 'qa_prepare_ios_target',
          action: 'install_app',
          risk: affects.external ? 'medium' : 'low',
          target: affects,
          consent: mutationConsent,
          status: 'approved',
        });
      }

      const res = await prepareIos(sessions, session, { app, bundleId, simulator, launch, attachWda, mutationConsent }, { onProgress: () => {} });
      if (!res.ok) {
        if (installAffects) {
          sessions.recordMutation(session, {
            tool: 'qa_prepare_ios_target',
            action: 'install_app',
            risk: installAffects.external ? 'medium' : 'low',
            target: installAffects,
            consent: mutationConsent,
            status: 'blocked',
            detail: res.error ?? res.failureCode ?? 'prepare failed',
          });
        }
        return qaFail((res.failureCode as FailureCode) ?? 'APP_LAUNCH_FAILED', { what: res.error ?? 'iOS prepare failed', extra: { udid: res.udid ?? null, name: res.name ?? null } });
      }
      return qaOk(
        { udid: res.udid, name: res.name, bundleId: res.bundleId ?? null, installed: res.installed, launched: res.launched, mode: res.mode, wda: res.wda ?? null },
        res.resultText ?? 'iOS target prepared.',
      );
    },
  );
}
