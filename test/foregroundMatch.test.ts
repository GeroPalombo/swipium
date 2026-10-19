// The foreground owner belongs to the app under test only on an exact package / bundle id match
// (optionally `/activity` or an Android `:process` suffix): `com.acme.app.debug` is another app.

import { describe, expect, it, vi } from 'vitest';
import { isForegroundOf, waitForForeground, waitForLaunch } from '../src/lib/launchWait.js';

describe('isForegroundOf', () => {
  it('matches the exact id, an activity, or a process suffix', () => {
    expect(isForegroundOf('com.acme.app', 'com.acme.app')).toBe(true);
    expect(isForegroundOf('com.acme.app/.MainActivity', 'com.acme.app')).toBe(true);
    expect(isForegroundOf('com.acme.app:remote/.Svc', 'com.acme.app')).toBe(true);
  });

  it('rejects a package that only shares the prefix, unknown, and a missing app id', () => {
    expect(isForegroundOf('com.acme.app.debug/.MainActivity', 'com.acme.app')).toBe(false);
    expect(isForegroundOf('com.acme.app2', 'com.acme.app')).toBe(false);
    expect(isForegroundOf('unknown', 'com.acme.app')).toBe(false);
    expect(isForegroundOf('com.acme.app', undefined)).toBe(false);
    expect(isForegroundOf('com.acme.app', '')).toBe(false);
  });
});

describe('waitForForeground', () => {
  it('keeps polling while a prefix-sharing package is in front', async () => {
    const owners = ['com.acme.app.debug/.Main', 'com.acme.app.debug/.Main', 'com.acme.app/.Main'];
    const d = { foregroundOwner: vi.fn(async () => owners.shift() ?? 'com.acme.app/.Main') };
    expect(await waitForForeground(d, 'com.acme.app', 2000)).toBe('com.acme.app/.Main');
    expect(d.foregroundOwner).toHaveBeenCalledTimes(3);
  });

  it('waitForLaunch skips the re-check when only a prefix-sharing package came up', async () => {
    const d = { foregroundOwner: vi.fn(async () => 'com.acme.app.debug/.Main') };
    expect(await waitForLaunch(d, 'com.acme.app', 300)).toBe('com.acme.app.debug/.Main');
  });
});
