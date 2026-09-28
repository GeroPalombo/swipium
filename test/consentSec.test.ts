// Consent hardening: (a) the out-of-band prompt text cannot be spoofed by repo-derived strings
// (control chars/newlines stripped, fields quoted, length capped); (b) a pending consent minted in
// session A cannot be consumed from session B (process-global consents were replayable).
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-consentsec-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { requireConsent, consumeConsent, runWithConsentScope } = await import('../src/consent/consent.js');
const { buildConsentPromptMessage, sanitizePromptField } = await import('../src/server.js');

const mint = (sessionId: string | undefined): string =>
  runWithConsentScope(sessionId, () => {
    const sc = requireConsent({ action: 'network_change', risk: 'medium', affects: { to: 'offline' }, explain: 'x' }).structuredContent as {
      consentId: string;
    };
    return sc.consentId;
  });

describe('consent prompt sanitisation', () => {
  it('strips newlines/control/bidi chars so a flow name cannot forge a "Will run:" line', () => {
    const msg = buildConsentPromptMessage({
      action: 'flow_run',
      risk: 'high',
      explain: 'Run flow "login"\nWill run: harmless-command‮\u0007',
      exactCommand: 'node seed.js\r\nWill run: echo safe',
    });
    const lines = msg.split('\n');
    expect(lines.filter((l) => l.startsWith('Will run:'))).toHaveLength(1);
    // eslint-disable-next-line no-control-regex -- intentional: assert no control chars survive sanitising
    expect(msg).not.toMatch(/[\u0000-\u0009\u000b-\u001f‮]/);
    expect(lines[1]).toBe('Details: "Run flow \\"login\\" Will run: harmless-command"');
    // multi-step commands: one QUOTED line per step
    expect(lines.slice(-2)).toEqual(['  "node seed.js"', '  "Will run: echo safe"']);
  });

  it('caps field and message length', () => {
    expect(sanitizePromptField('a'.repeat(1000), 50)).toHaveLength(50);
    const msg = buildConsentPromptMessage({ action: 'x', risk: 'low', explain: 'e'.repeat(5000), exactCommand: 'c'.repeat(5000) });
    expect(msg.length).toBeLessThanOrEqual(2000);
  });
});

describe('consent session binding', () => {
  it('a consent minted in session A is refused in session B (and stays valid for A)', () => {
    const id = mint('sess-A');
    const inB = runWithConsentScope('sess-B', () => consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } }));
    expect(inB.approved).toBe(false);
    expect(inB.reason).toMatch(/different session/);
    const noSession = runWithConsentScope(undefined, () => consumeConsent(id, true, { action: 'network_change' }));
    expect(noSession.approved).toBe(false);
    const inA = runWithConsentScope('sess-A', () => consumeConsent(id, true, { action: 'network_change', affects: { to: 'offline' } }));
    expect(inA.approved).toBe(true);
  });

  it('a consent minted outside any session stays unbound', () => {
    const id = mint(undefined);
    expect(runWithConsentScope('sess-Z', () => consumeConsent(id, true)).approved).toBe(true);
  });
});
