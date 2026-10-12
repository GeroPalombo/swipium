// First-run fixes and missing tests (hermetic, fake driver):
//  - with credentials set, a sign-up / login chooser ("Sign up with Apple / Google /
//    Or by email / Already have an account? Sign In") follows the in-app "Sign In" link; Apple and
//    Google sign-in stay excluded; without such a link the blocker names the chooser, not credentials.
//  - Missing tests: first run closes an alert with its cancel button; never taps third-party sign-in.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, FakeDriver, type NodeSpec } from './actFixFake.js';
import { findSignInLink, planAuthActions } from '../src/firstRun/authStateMachine.js';
import type { SnapshotElement } from '../src/drivers/Driver.js';
import type { ScreenClassification } from '../src/firstRun/types.js';

const { SessionStore } = await import('../src/session/store.js');
const { runFirstRun } = await import('../src/firstRun/firstRunRunner.js');

/** An alert node wrapping its buttons (iosAlertCancel looks for buttons INSIDE the alert). */
function alertDump(title: string, buttons: Array<{ text: string; bounds: [number, number, number, number] }>): string {
  const inner = buttons
    .map(
      (b) =>
        `<node class="XCUIElementTypeButton" package="com.example.app" text="${b.text}" resource-id="" content-desc="" bounds="[${b.bounds[0]},${b.bounds[1]}][${b.bounds[2]},${b.bounds[3]}]" clickable="true" enabled="true"/>`,
    )
    .join('');
  return dump([]).replace(
    '</node></hierarchy>',
    `<node class="XCUIElementTypeAlert" package="com.example.app" text="" resource-id="" content-desc="${title}" bounds="[100,600][980,1200]" clickable="false" enabled="true">${inner}</node></node></hierarchy>`,
  );
}

const el = (ref: string, label: string, y: number, clickable = true, role = 'Button'): SnapshotElement => ({
  ref,
  role,
  label,
  bounds: [40, y, 1040, y + 80],
  clickable,
});

const CHOOSER: NodeSpec[] = [
  { cls: 'android.widget.TextView', text: 'Create your account', bounds: [40, 100, 1040, 180], clickable: false },
  { text: 'Sign up with Apple', bounds: [40, 300, 1040, 380] },
  { text: 'Sign up with Google', bounds: [40, 400, 1040, 480] },
  { cls: 'android.widget.TextView', text: 'Or by email', bounds: [40, 500, 1040, 580], clickable: false },
  { cls: 'android.widget.TextView', text: 'Already have an account?', bounds: [40, 700, 600, 780], clickable: false },
  { cls: 'android.widget.TextView', text: 'Sign In', bounds: [620, 700, 1040, 780], clickable: false },
];
const HOME = dump([
  { cls: 'android.widget.TextView', text: 'Home', bounds: [40, 100, 1040, 180], clickable: false },
  { text: 'Settings', id: 'com.example.app:id/settings', bounds: [40, 300, 1040, 380] },
  { text: 'Profile', id: 'com.example.app:id/profile', bounds: [40, 400, 1040, 480] },
]);

function newSession(fake: FakeDriver, creds: boolean) {
  const sessions = new SessionStore();
  const session = sessions.create(mkdtempSync(join(tmpdir(), 'swipium-r5fr-')));
  session.appId = 'com.example.app';
  session.driver = fake;
  if (creds) {
    session.inputValues.set('SWIPIUM_TEST_EMAIL', 'qa@example.com');
    session.inputValues.set('SWIPIUM_TEST_PASSWORD', 'Passw0rd-XYZ');
  }
  return { sessions, session };
}

const tappedAt = (fake: FakeDriver, b: [number, number, number, number]) =>
  fake.got('tapXY').some((c) => c.a[0] === Math.round((b[0] + b[2]) / 2) && c.a[1] === Math.round((b[1] + b[3]) / 2));

describe('findSignInLink', () => {
  it('picks "Sign In" (even as plain text), never Apple / Google sign-in', () => {
    const els = [el('@e1', 'Sign in with Apple', 300), el('@e2', 'Sign in with Google', 400), el('@e3', 'Sign In', 700, false, 'Text')];
    expect(findSignInLink(els)?.ref).toBe('@e3');
  });
  it('falls back to "by email", and finds nothing on a chooser with only third-party buttons', () => {
    expect(findSignInLink([el('@e1', 'Sign up with Apple', 300), el('@e2', 'Or by email', 500)])?.ref).toBe('@e2');
    expect(findSignInLink([el('@e1', 'Sign up with Apple', 300), el('@e2', 'Continue with Google', 400)])).toBeUndefined();
  });
  it('a chooser without a sign-in link blocks with a chooser reason, not a credentials request', () => {
    const c = { purpose: 'login', confidence: 0.33, requiredInputs: [] } as unknown as ScreenClassification;
    const r = planAuthActions(c, [el('@e1', 'Sign up with Apple', 300)], 'login', () => {
      throw new Error('no fields to plan');
    });
    expect(r.actions).toEqual([]);
    expect(r.blockedReasons[0]).toMatch(/sign-up chooser: no email login form reached/);
  });
});

describe('runFirstRun: alert close + sign-in exclusion + chooser navigation', () => {
  it('closes an alert with its cancel button, then taps "Sign In" (not Apple / Google) and reaches home', async () => {
    const alert = alertDump('Sign in to your Apple Account', [
      { text: 'Close', bounds: [120, 1000, 540, 1100] },
      { text: 'Settings', bounds: [560, 1000, 960, 1100] },
    ]);
    const fake = new FakeDriver(alert);
    fake.onTap = (x, y) => {
      if (fake.xml === alert && x === 330 && y === 1050) fake.xml = dump(CHOOSER);
      else if (fake.xml !== alert && x === 830 && y === 740) fake.xml = HOME;
    };
    const { sessions, session } = newSession(fake, true);
    const r = await runFirstRun(sessions, session, fake, { mode: 'until_home', maxSteps: 4, maxDurationMs: 20_000 });

    expect(tappedAt(fake, [120, 1000, 540, 1100])).toBe(true); // Close
    expect(tappedAt(fake, [560, 1000, 960, 1100])).toBe(false); // never the alert's Settings
    expect(tappedAt(fake, [40, 300, 1040, 380])).toBe(false); // never Apple
    expect(tappedAt(fake, [40, 400, 1040, 480])).toBe(false); // never Google
    expect(tappedAt(fake, [620, 700, 1040, 780])).toBe(true); // Sign In
    expect(session.workarounds.join('\n')).toMatch(/closed the alert "Sign in to your Apple Account" with "Close"/);
    expect(r.state).toBe('completed');
  }, 30_000);

  it('blocks on an alert that has no cancel button, without tapping it', async () => {
    const fake = new FakeDriver(alertDump('Update required', [{ text: 'Update', bounds: [120, 1000, 960, 1100] }]));
    const { sessions, session } = newSession(fake, false);
    const r = await runFirstRun(sessions, session, fake, { mode: 'until_home', maxSteps: 3, maxDurationMs: 20_000 });
    expect(r.state).toBe('blocked');
    expect(r.stoppedReason).toMatch(/no cancel \/ close button/);
    expect(fake.got('tapXY')).toEqual([]);
  }, 30_000);
});
