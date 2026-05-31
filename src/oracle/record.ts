// Record health findings into the session for qa_report (review #3, Phase 2.2).
// Shared by qa_act (auto after each action) and qa_check_health (on demand). Carries the
// native/app layer + visible-text evidence, and — for app-layer error surfaces — captures
// ONE screenshot as evidence and attaches its URI to those findings.

import type { SessionStore, Session } from '../session/store.js';
import type { Driver } from '../drivers/Driver.js';
import type { Finding } from './health.js';

export async function recordHealthFindings(
  sessions: SessionStore,
  session: Session,
  findings: Finding[],
  driver?: Driver,
  screen?: string,
): Promise<void> {
  // Capture one screenshot of an app-layer error surface (RedBox / error-boundary / etc.)
  // so the report shows WHAT broke, not just that something did. Evidence — not budgeted.
  let evidenceUri: string | undefined;
  const appError = findings.find((f) => f.layer === 'app' && (f.severity === 'high' || f.severity === 'medium'));
  // Sensitive mode: record the finding but DON'T capture pixels.
  if (appError && driver && !session.sensitive) {
    try {
      const png = await driver.screenshot();
      evidenceUri = sessions.saveArtifact(session, 'screenshot', `app-error-${Date.now()}.png`, png, 'image/png', `app-health: ${appError.kind}`);
    } catch {
      /* best-effort — evidence is a bonus, not required */
    }
  }

  for (const f of findings) {
    if (f.severity === 'info') continue;
    const screenshotUri = f.layer === 'app' ? (f.screenshotUri ?? evidenceUri) : f.screenshotUri;
    sessions.addFinding(session, {
      at: Date.now(),
      severity: f.severity,
      kind: f.kind,
      detail: f.detail,
      layer: f.layer,
      evidence: f.evidence,
      screen,
      screenshotUri,
    });
  }
}
