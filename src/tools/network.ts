// qa_network: safe offline/online testing without raw adb.
// Uses `cmd connectivity airplane-mode` (API 30+). Records the original state on first
// change so it can be restored; report + session-end restore use session.network.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { blockedDeviceResult, getDriver, prepareFirstStep } from '../session/attach.js';
import { pidAlive, type Session, type SessionStore } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';
import { noteScreenMutation } from '../snapshot/fresh.js';

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

/** Sessions whose network flag this server process may restore on shutdown: only sessions with a
 *  live driver in THIS process whose network change THIS process made (`ownerPid`). A server that
 *  only read or snapshotted another server's live session gets a driver too, but must leave its
 *  airplane mode alone: the owner still believes the device is offline. */
export function sessionsToRestoreOnShutdown(sessions: SessionStore): Session[] {
  return sessions.list().filter((s) => s.network?.changed && s.driver && s.network.ownerPid === process.pid);
}

/** Network changes on `device` (this session's or any other's) left behind by a server that is gone
 *  (SIGKILL, crash): nobody restores those on shutdown, so the device stays in airplane mode and the
 *  app's offline screens look like app bugs. Rows without `ownerPid` (owner unknown) are left out. */
export function orphanedNetworkChanges(sessions: SessionStore, device: string | undefined): Session[] {
  if (!device) return [];
  return sessions.list().filter((s) => {
    const pid = s.network?.changed ? s.network.ownerPid : undefined;
    return s.device === device && typeof pid === 'number' && pid !== process.pid && !pidAlive(pid);
  });
}

/** One-line warning for qa_status / qa_network status, or undefined when nothing was orphaned. */
export function orphanedNetworkWarning(orphans: Session[], sessionId: string): string | undefined {
  if (!orphans.length) return undefined;
  const ids = orphans.map((o) => o.id).join(', ');
  return (
    `airplane mode was left on ${orphans[0]!.device} by a Swipium server that exited without restoring it (session ${ids}); ` +
    `run qa_network {sessionId:"${sessionId}", action:"restore"} before testing, or offline screens will look like app bugs`
  );
}

/** Best-effort restore, for server shutdown, of every session THIS process drives that changed the
 *  network. Only Android (adb) drivers can toggle airplane mode; any other driver just clears the
 *  flag so it is not retried forever. */
export async function restoreAllNetwork(sessions: SessionStore): Promise<void> {
  for (const s of sessionsToRestoreOnShutdown(sessions)) {
    const d = s.driver!;
    if (!s.network) continue;
    if (d.kind !== 'direct') {
      s.network = { changed: false, originalAirplane: s.network.originalAirplane };
      sessions.persist(s);
      continue;
    }
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
        'Test offline/online behavior via airplane mode (Android 11+). action: status, offline/online (consent-gated), restore. The ' +
        'original state is restored on qa_report, on restore, and on server shutdown.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'offline', 'online', 'restore']),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, consentId, approve }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver: d, blocked } = await getDriver(session);
      if (!session || !d) {
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached',
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: [prepareFirstStep(session)],
          })
        );
      }

      // Airplane-mode control is an Android emulator feature (`cmd connectivity airplane-mode`); iOS
      // simulators have no equivalent, so answer with a typed refusal instead of a raw driver error.
      if (d.kind !== 'direct') {
        return qaError({
          what: 'qa_network is supported on Android emulators only (iOS simulators have no airplane-mode control)',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['On iOS, test offline behavior by disconnecting the Mac from the network or with a network link conditioner.'],
        });
      }
      const airplane = await d.airplaneOn();
      // Changes on this device left by a server that died without restoring (this session's or another's).
      const orphans = orphanedNetworkChanges(sessions, session.device);
      if (action === 'status') {
        const warning = orphanedNetworkWarning(orphans, session.id);
        return qaOk(
          {
            network: airplane ? 'offline' : 'online',
            airplaneOn: airplane,
            changedBySwipium: !!session.network?.changed || orphans.length > 0,
            restoreAvailable: !!session.network?.changed || orphans.length > 0,
            ...(orphans.length ? { orphanedBySessions: orphans.map((o) => o.id) } : {}),
          },
          `network=${airplane ? 'offline (airplane on)' : 'online'}${session.network?.changed ? ' (changed by Swipium, will restore)' : ''}` +
            (warning ? `\nWARNING: ${warning}` : ''),
        );
      }

      if (action === 'restore') {
        let msg = await restoreNetwork(sessions, session, d);
        // Also take back what a dead server left on this device. A change whose original was
        // "online" goes last so an orphan recorded after another one cannot leave airplane on.
        const others = orphans
          .filter((o) => o !== session)
          .sort((a, b) => Number(!a.network!.originalAirplane) - Number(!b.network!.originalAirplane));
        for (const o of others) {
          const m = await restoreNetwork(sessions, o, d);
          if (m) msg = `${m} (left by session ${o.id}, whose server exited without restoring)`;
        }
        if (msg) noteScreenMutation(session);
        return qaOk(
          { network: (await d.airplaneOn()) ? 'offline' : 'online', restored: !!msg },
          msg ? `network ${msg}` : 'nothing to restore (Swipium did not change the network)',
        );
      }

      // offline / online: consent-gated, records original on first change.
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
      const firstChange = !session.network?.changed;
      if (firstChange) {
        session.network = { changed: true, originalAirplane: airplane, ownerPid: process.pid };
      } else {
        session.network!.ownerPid = process.pid; // this server changed it last: it restores on shutdown
      }
      sessions.persist(session);
      try {
        await d.setAirplane(wantAirplane);
        noteScreenMutation(session); // offline banners etc.: a < 2 s snapshot is stale
      } catch (e) {
        // Older images / no `cmd connectivity airplane-mode` (pre-Android 11). Nothing changed, so
        // drop the restore record this call just created (an earlier change's record is kept).
        if (firstChange) session.network = undefined;
        sessions.persist(session);
        return qaError({
          what: `Network control unsupported on this device: ${String(e)}`,
          changedState: false,
          retrySafe: false,
          nextSteps: ['Needs Android 11+ (`cmd connectivity airplane-mode`). Use a newer emulator image, or toggle network manually.'],
        });
      }
      sessions.addEnvChange(session, `network > ${action} (airplane=${wantAirplane})`);
      // Poll the flag (same 1.2 s cap as the old fixed settle) instead of always sleeping.
      const deadline = Date.now() + 1200;
      let now = await d.airplaneOn();
      while (now !== wantAirplane && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        now = await d.airplaneOn();
      }
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
        `network > ${now ? 'offline' : 'online'}. Original recorded; restore on qa_report / qa_network restore.`,
      );
    },
  );
}
