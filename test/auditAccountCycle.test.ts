// qa_mobile_audit account-cycle: logout is judged on the screen the tap leads to (sign-in wording
// plus an input field, never resource ids), login_again runs only after a logout that passed, and
// check reasons are redacted with the session's secrets before they reach the issue ledger.
// Hermetic: a fake driver whose tree changes on the logout tap; first-run is stubbed.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'swipium-audit-cycle-home-'));
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const fr = vi.hoisted(() => ({ calls: 0, second: { state: 'completed' } as Record<string, unknown> }));
vi.mock('../src/firstRun/firstRunRunner.js', async (orig) => ({
  ...(await orig<typeof import('../src/firstRun/firstRunRunner.js')>()),
  runFirstRun: vi.fn(async () => {
    fr.calls++;
    return fr.calls === 1
      ? { state: 'completed', accountOutcome: 'created', pathTaken: 'signup', evidenceUris: [] }
      : { evidenceUris: [], ...fr.second };
  }),
}));

const { runMobileAudit } = await import('../src/mobileAudit/runner.js');
const { looksLikeAuthSurface } = await import('../src/mobileAudit/checks.js');
const { parseSnapshot } = await import('../src/snapshot/parse.js');
const { SessionStore } = await import('../src/session/store.js');
type Driver = import('../src/drivers/Driver.js').Driver;

const node = (cls: string, text: string, id = '', bounds = '[40,100][1040,180]', clickable = false) =>
  `<node class="${cls}" package="com.example.app" text="${text}" resource-id="${id}" content-desc="" bounds="${bounds}" clickable="${clickable}" enabled="true"/>`;
const screen = (...nodes: string[]) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" package="com.example.app" text="" resource-id="" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
  nodes.join('') +
  `</node></hierarchy>`;

const HOME = screen(
  node('android.widget.TextView', 'Profile'),
  node('android.widget.TextView', 'Settings', '', '[40,200][1040,280]'),
  node('android.widget.Button', 'Log out', 'logout', '[40,300][1040,380]', true),
);
// Still logged in after the tap: only ids mention login, and a promo says "Sign in with Apple".
const STILL_IN = screen(
  node('android.widget.TextView', 'Profile'),
  node('android.widget.TextView', 'Link: Sign in with Apple', 'login_promo', '[40,200][1040,280]'),
  node('android.widget.Button', 'Done', 'login_button', '[40,300][1040,380]', true),
);
const SIGN_IN = screen(
  node('android.widget.TextView', 'Sign in'),
  node('android.widget.EditText', '', 'email', '[40,200][1040,280]'),
  node('android.widget.EditText', '', 'password', '[40,300][1040,380]'),
  node('android.widget.Button', 'Forgot password?', '', '[40,400][1040,480]', true),
);

function fakeDriver(afterTap: string) {
  let xml = HOME;
  return {
    kind: 'direct',
    listDevices: async () => ['fake'],
    useDevice() {},
    currentDevice: () => 'fake',
    isInstalled: async () => true,
    isRunning: async () => true,
    launchApp: async () => {},
    terminateApp: async () => {},
    airplaneOn: async () => false,
    setAirplane: async () => {},
    foregroundOwner: async () => 'com.example.app/.Main',
    screenshot: async () => Buffer.alloc(0),
    dumpXml: async () => xml,
    tapXY: async () => {
      xml = afterTap;
    },
    pressKey: async () => {},
    screenSize: async () => ({ width: 1080, height: 1920 }),
  } as unknown as Driver;
}

const roots: string[] = [];
function session() {
  const root = mkdtempSync(join(tmpdir(), 'swipium-audit-cycle-proj-'));
  roots.push(root);
  const sessions = new SessionStore();
  const s = sessions.create(root);
  s.appId = 'com.example.app';
  return { sessions, s, root };
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  fr.calls = 0;
  fr.second = { state: 'completed' };
});

const NOW = '2026-10-19T00:00:00.000Z';
const status = (checks: Array<{ id: string; status: string }>, id: string) => checks.find((c) => c.id === id)?.status;

describe('account-cycle logout and login_again', () => {
  it('a tap that leaves the logged-in screen is not a logout, and login_again is skipped', async () => {
    const { sessions, s } = session();
    const run = await runMobileAudit(sessions, s, fakeDriver(STILL_IN), { profile: 'account_cycle', allowGeneratedData: true, now: NOW });
    expect(status(run.checks, 'logout')).toBe('skipped');
    expect(status(run.checks, 'login_again')).toBe('skipped');
    expect(fr.calls).toBe(1);
  }, 30_000);

  it('a real sign-in screen after the tap passes logout, then login_again runs', async () => {
    const { sessions, s } = session();
    const run = await runMobileAudit(sessions, s, fakeDriver(SIGN_IN), { profile: 'account_cycle', allowGeneratedData: true, now: NOW });
    expect(status(run.checks, 'logout')).toBe('pass');
    expect(status(run.checks, 'login_again')).toBe('pass');
    expect(status(run.checks, 'forgot_password')).toBe('pass');
    expect(fr.calls).toBe(2);
  }, 30_000);

  it('a reason quoting a session secret is redacted in the result and the issue ledger', async () => {
    const { sessions, s, root } = session();
    s.secrets.add('hunter2-very-secret');
    fr.second = { state: 'stopped', stoppedReason: 'typed hunter2-very-secret into the password field and got rejected' };
    const run = await runMobileAudit(sessions, s, fakeDriver(SIGN_IN), { profile: 'account_cycle', allowGeneratedData: true, now: NOW });
    const login = run.checks.find((c) => c.id === 'login_again')!;
    expect(login.status).toBe('fail');
    expect(login.reason).not.toContain('hunter2-very-secret');
    expect(login.issueId).toBeTypeOf('string');
    const log = join(root, '.swipium', 'issues-log.jsonl');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).not.toContain('hunter2-very-secret');
  }, 30_000);
});

describe('looksLikeAuthSurface', () => {
  const nodes = (xml: string) => parseSnapshot(xml).allNodes;
  it('needs sign-in wording AND an input field, and ignores resource ids', () => {
    expect(looksLikeAuthSurface(nodes(SIGN_IN))).toBe(true);
    expect(looksLikeAuthSurface(nodes(STILL_IN))).toBe(false);
    expect(looksLikeAuthSurface(nodes(screen(node('android.widget.EditText', 'Search'), node('android.widget.TextView', 'Profile'))))).toBe(
      false,
    );
    expect(looksLikeAuthSurface(nodes(screen(node('android.widget.EditText', '', 'login_email'))))).toBe(false);
  });

  it('accepts a buttons-only sign-in screen, but not a single "Sign in" promo button', () => {
    const btn = (text: string) => node('android.widget.Button', text, '', '[40,100][1040,180]', true);
    expect(looksLikeAuthSurface(nodes(screen(btn('Log in'), btn('Sign up'))))).toBe(true);
    expect(looksLikeAuthSurface(nodes(screen(node('android.widget.TextView', 'Profile'), btn('Sign in'))))).toBe(false);
  });
});
