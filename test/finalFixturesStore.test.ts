// Integration fixes (2.0.0 final):
//  - (HIGH) fixtures bypassed the SWIPIUM_* env rule: a repo-supplied .swipium/fixtures.json field
//    `{var: "AWS_SECRET_ACCESS_KEY"}` returned the server's real value with secret:false, so
//    explore / first-run typed it into the app unredacted. Fixture env reads now go through the
//    flows allowlist (SWIPIUM_* only) and any env-sourced value is a registered secret.
//  - (MED) persisted fixtures were redacted and then reloaded as LIVE config (a resumed session typed
//    «redacted» into the password field / ran seeds with a broken token). state.json now holds only
//    value-less metadata; rehydrate re-reads the project's .swipium/fixtures.json.
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-final-fixtures-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { resolveFixtureValue, fixtureVarBlockedMessage } = await import('../src/fixtures/catalog.js');
const { loadProjectFixtures } = await import('../src/fixtures/load.js');

const root = mkdtempSync(join(tmpdir(), 'swipium-final-fixtures-proj-'));
const ENV_KEYS = ['AWS_SECRET_ACCESS_KEY', 'SWIPIUM_ACCT_EMAIL'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('fixture env vars obey the SWIPIUM_* rule', () => {
  it('a non-SWIPIUM_ var is never read from the environment (treated as missing)', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'AKIA-real-server-secret-123';
    const store = new SessionStore();
    const s = store.create(root, undefined, { fixtures: [{ name: 'acct', fields: { email: { var: 'AWS_SECRET_ACCESS_KEY' } } }] });
    expect(resolveFixtureValue(s, 'Email')).toBeUndefined();
    // With a declared fallback value, that value is used — never the env secret.
    s.fixtures = [{ name: 'acct', fields: { email: { var: 'AWS_SECRET_ACCESS_KEY', value: 'qa@example.test' } } }];
    const r = resolveFixtureValue(s, 'Email');
    expect(r?.value).toBe('qa@example.test');
    expect(r?.source).toBe('value');
    expect(fixtureVarBlockedMessage('acct', 'email', 'AWS_SECRET_ACCESS_KEY')).toMatch(/SWIPIUM_\*/);
  });

  it('a SWIPIUM_* var is read and always treated + registered as a secret', () => {
    process.env.SWIPIUM_ACCT_EMAIL = 'env-user@example.test';
    const store = new SessionStore();
    const s = store.create(root, undefined, { fixtures: [{ name: 'acct', fields: { email: { var: 'SWIPIUM_ACCT_EMAIL' } } }] });
    const r = resolveFixtureValue(s, 'Email');
    expect(r).toMatchObject({ value: 'env-user@example.test', secret: true, source: 'variable' });
    expect(s.secrets.has('env-user@example.test')).toBe(true);
  });
});

describe('fixtures persist as metadata only and rehydrate from fixtures.json', () => {
  it('state.json never holds fixture values / seed argv; a resumed session gets the real values', () => {
    const FILE_PW = 'FilePw!9x7q';
    const TOKEN = 'Tok3n-9f8e7d6c';
    const ARG_VALUE = 'ArgOnlyValue-55';
    const ENV_EMAIL = 'env-mail@example.test';
    mkdirSync(join(root, '.swipium'), { recursive: true });
    writeFileSync(
      join(root, '.swipium', 'fixtures.json'),
      JSON.stringify({
        fixtures: [
          {
            name: 'acct',
            requiredState: 'logged out',
            fields: { password: { value: FILE_PW, secret: true }, email: { var: 'SWIPIUM_ACCT_EMAIL' } },
            seed: { type: 'script', command: ['./seed.sh', '--token', TOKEN] },
          },
        ],
      }),
    );
    process.env.SWIPIUM_ACCT_EMAIL = ENV_EMAIL;
    const store = new SessionStore();
    const s = store.create(root, undefined, {
      fixtures: [...loadProjectFixtures(root), { name: 'argfx', value: ARG_VALUE, requiredState: 'search ready' }],
    });
    s.secrets.add(FILE_PW);
    expect(resolveFixtureValue(s, 'Email')?.value).toBe(ENV_EMAIL); // registers it as a secret
    store.flushAll();

    const raw = readFileSync(join(s.dir, 'state.json'), 'utf8');
    for (const v of [FILE_PW, TOKEN, ARG_VALUE, ENV_EMAIL, 'redacted']) expect(raw).not.toContain(v);
    const st = JSON.parse(raw) as { fixtures: Array<{ name: string; requiredState?: string; seed?: unknown }> };
    expect(st.fixtures.map((f) => f.name)).toEqual(['acct', 'argfx']);
    expect(st.fixtures[0].requiredState).toBe('logged out'); // report metadata kept
    expect(st.fixtures[0].seed).toBeUndefined();

    const reloaded = new SessionStore().get(s.id)!;
    const acct = reloaded.fixtures.find((f) => f.name === 'acct')!;
    expect(acct.seed?.command).toEqual(['./seed.sh', '--token', TOKEN]); // live config from the file
    expect(resolveFixtureValue(reloaded, 'Password')?.value).toBe(FILE_PW);
    expect(resolveFixtureValue(reloaded, 'Email')?.value).toBe(ENV_EMAIL);
    // An arg-only fixture survives as value-less metadata — never as redacted input.
    const arg = reloaded.fixtures.find((f) => f.name === 'argfx')!;
    expect(arg.requiredState).toBe('search ready');
    expect(arg.value).toBeUndefined();
  });
});
