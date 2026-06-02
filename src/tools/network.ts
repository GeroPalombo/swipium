// qa_network — safe offline/online testing without raw adb (Phase 2 CR2).
// Uses `cmd connectivity airplane-mode` (API 30+). Records the original state on first
// change so it can be restored; report + session-end restore use session.network.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { getDriver } from '../session/attach.js';
import type { Session, SessionStore } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';

/** Restore network to the recorded original state. Exported for report/session-end use. */
export async function restoreNetwork(sessions: SessionStore, session: Session, d: Driver): Promise<string | null> {
  if (!session.network?.changed) return null;
  const original = session.network.originalAirplane;
  await d.setAirplane(original); // original airplane flag
  sessions.addEnvChange(session, `network restored (airplane=${original})`);
  sessions.recordMutation(session, {
    tool: 'qa_network',
    action: 'network_restore',
    risk: 'low',
    target: { toAirplane: original },
    consent: { required: false, approved: true },
    status: 'restored',
    detail: `restored airplane=${original}`,
  });
  session.network = { changed: false, originalAirplane: original };
  sessions.persist(session);
  return `restored (airplane=${original})`;
}

/** Best-effort restore of EVERY session that changed the network — for server shutdown. */
export async function restoreAllNetwork(sessions: SessionStore): Promise<void> {
  const { DirectDriver } = await import('../drivers/DirectDriver.js');
  for (const s of sessions.list()) {
    if (!s.network?.changed) continue;
    const d = s.driver ?? (s.device ? new DirectDriver(s.device) : undefined);
    if (!d) continue;
    try {
      await d.setAirplane(s.network.originalAirplane);
      sessions.recordMutation(s, {
        tool: 'qa_network',
        action: 'network_restore',
        risk: 'low',
        target: { toAirplane: s.network.originalAirplane, shutdown: true },
        consent: { required: false, approved: true },
        status: 'restored',
        detail: 'best-effort restore on shutdown',
      });
      s.network = { changed: false, originalAirplane: s.network.originalAirplane };
      sessions.persist(s);
    } catch {
      /* best-effort on shutdown */
    }
  }
}

export function registerNetwork(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_network',
    {
      title: 'Network state control',
      description:
        'Offline/online testing via airplane mode (no raw adb; needs Android 11+ `cmd connectivity`). Actions: status, offline, online, restore. Swipium records the original airplane state on the first change and restores it on qa_report, on explicit `restore`, and best-effort on server shutdown (SIGINT/SIGTERM/transport close). offline/online require consent.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'offline', 'online', 'restore']),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver: d } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !d) {
        return qaError({ what: 'No device attached', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target first.'] });
      }

      const airplane = await d.airplaneOn();
      if (action === 'status') {
        return qaOk(
          { network: airplane ? 'offline' : 'online', airplaneOn: airplane, changedBySwipium: !!session.network?.changed, restoreAvailable: !!session.network?.changed },
          `network=${airplane ? 'offline (airplane on)' : 'online'}${session.network?.changed ? ' (changed by Swipium — will restore)' : ''}`,
        );
      }

      if (action === 'restore') {
        const msg = await restoreNetwork(sessions, session, d);
        return qaOk({ network: (await d.airplaneOn()) ? 'offline' : 'online', restored: !!msg }, msg ? `network ${msg}` : 'nothing to restore (Swipium did not change the network)');
      }

      // offline / online — consent-gated, records original on first change.
      const wantAirplane = action === 'offline';
      const gate = consumeConsent(consentId, approve, { action: 'network_change', affects: { to: action } });
      if (!gate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_network',
          action: 'network_change',
          risk: 'medium',
          target: { to: action, airplane: wantAirplane },
          consent: { required: true, approved: false, payloadHash: action },
          status: 'requested',
        });
        return requireConsent({
          action: 'network_change',
          risk: 'medium',
          exactCommand: `adb shell cmd connectivity airplane-mode ${wantAirplane ? 'enable' : 'disable'}`,
          affects: { to: action },
          explain: `Set the device ${action} (airplane mode ${wantAirplane ? 'ON' : 'OFF'})? Swipium will restore the original state on qa_report / session end.`,
        });
      }
      sessions.recordMutation(session, {
        tool: 'qa_network',
        action: 'network_change',
        risk: 'medium',
        target: { to: action, airplane: wantAirplane },
        consent: { required: true, consentId, approved: true, payloadHash: action },
        status: 'approved',
      });
      if (!session.network?.changed) {
        session.network = { changed: true, originalAirplane: airplane };
      }
      sessions.persist(session);
      try {
        await d.setAirplane(wantAirplane);
      } catch (e) {
        // Older images / no `cmd connectivity airplane-mode` (pre-Android 11).
        if (!session.network.changed) session.network = undefined;
        sessions.persist(session);
        return qaError({
          what: `Network control unsupported on this device: ${String(e)}`,
          changedState: false,
          retrySafe: false,
          nextSteps: ['Needs Android 11+ (`cmd connectivity airplane-mode`). Use a newer emulator image, or toggle network manually.'],
        });
      }
      sessions.addEnvChange(session, `network → ${action} (airplane=${wantAirplane})`);
      await new Promise((r) => setTimeout(r, 1200)); // settle
      const now = await d.airplaneOn();
      sessions.recordMutation(session, {
        tool: 'qa_network',
        action: 'network_change',
        risk: 'medium',
        target: { to: action, airplane: wantAirplane },
        consent: { required: true, approved: true, payloadHash: action },
        status: 'executed',
        detail: `network=${now ? 'offline' : 'online'}`,
      });
      return qaOk(
        { network: now ? 'offline' : 'online', previousStateRecorded: true, restoreAvailable: true },
        `network → ${now ? 'offline' : 'online'}. Original recorded; restore on qa_report / qa_network restore.`,
      );
    },
  );
}
