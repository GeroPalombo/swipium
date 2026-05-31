// Network restore helpers retained for flows that temporarily change device connectivity.

import type { Session, SessionStore } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';

/** Restore network to the recorded original state. Exported for report/session-end use. */
export async function restoreNetwork(sessions: SessionStore, session: Session, d: Driver): Promise<string | null> {
  if (!session.network?.changed) return null;
  const original = session.network.originalAirplane;
  await d.setAirplane(original);
  sessions.addEnvChange(session, `network restored (airplane=${original})`);
  sessions.recordMutation(session, {
    tool: 'qa_report',
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

/** Best-effort restore of every session that changed the network, for server shutdown. */
export async function restoreAllNetwork(sessions: SessionStore): Promise<void> {
  const { DirectDriver } = await import('../drivers/DirectDriver.js');
  for (const s of sessions.list()) {
    if (!s.network?.changed) continue;
    const d = s.driver ?? (s.device ? new DirectDriver(s.device) : undefined);
    if (!d) continue;
    try {
      await d.setAirplane(s.network.originalAirplane);
      sessions.recordMutation(s, {
        tool: 'swipium_shutdown',
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
