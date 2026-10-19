// Generated-data policy: Swipium invents input values (a throwaway account) only when the policy and
// the classified environment both say it is safe; when production cannot be ruled out it refuses.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyEnvironment,
  decideGeneratedAccount,
  DEFAULT_TEST_DATA_POLICY,
  generateFieldValue,
  loadTestDataPolicy,
  type EnvironmentClassification,
  type TestDataPolicy,
} from '../src/firstRun/generatedDataPolicy.js';

function repo(policy?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'swipium-datapolicy-'));
  if (policy !== undefined) {
    mkdirSync(join(root, '.swipium'), { recursive: true });
    writeFileSync(join(root, '.swipium', 'test-data-policy.json'), policy);
  }
  return root;
}

describe('loadTestDataPolicy', () => {
  it('a missing file is the safe default', () => {
    expect(loadTestDataPolicy(repo())).toEqual({ policy: DEFAULT_TEST_DATA_POLICY, source: 'default' });
  });

  it('a partial file is deep-merged over the default', () => {
    const root = repo(JSON.stringify({ allowGeneratedAccounts: 'never', email: { pattern: 'qa+<timestamp>@example.test' } }));
    const { policy, source } = loadTestDataPolicy(root);
    expect(source).toBe(join(root, '.swipium', 'test-data-policy.json'));
    expect(policy.allowGeneratedAccounts).toBe('never');
    expect(policy.email.pattern).toBe('qa+<timestamp>@example.test');
    expect(policy.email.generator).toBe(DEFAULT_TEST_DATA_POLICY.email.generator);
    expect(policy.password).toEqual(DEFAULT_TEST_DATA_POLICY.password);
    expect(policy.forbiddenEnvironments).toEqual(['production']);
  });

  it('an unreadable file falls back to the default and says so; an explicit relative path is read from the root', () => {
    expect(loadTestDataPolicy(repo('{ not json'))).toEqual({
      policy: DEFAULT_TEST_DATA_POLICY,
      source: 'default (unreadable policy file)',
    });
    const root = repo();
    writeFileSync(join(root, 'custom-policy.json'), JSON.stringify({ allowPhone: true }));
    const { policy, source } = loadTestDataPolicy(root, 'custom-policy.json');
    expect(source).toBe(join(root, 'custom-policy.json'));
    expect(policy.allowPhone).toBe(true);
  });
});

describe('classifyEnvironment', () => {
  it('a declared environment or disposable fixture is authoritative', () => {
    expect(classifyEnvironment({ declaredEnvironment: 'Production', appId: 'com.acme.app.dev' })).toMatchObject({
      environment: 'production',
      productionRisk: true,
    });
    expect(classifyEnvironment({ declaredEnvironment: 'staging' })).toMatchObject({ environment: 'staging', productionRisk: false });
    expect(classifyEnvironment({ declaredEnvironment: 'qa' })).toMatchObject({ environment: 'test', productionRisk: false });
    expect(classifyEnvironment({ hasDisposableState: true, apiBaseUrls: ['https://api.acme.com'] })).toMatchObject({
      environment: 'test',
      productionRisk: false,
    });
  });

  it('test and staging signals classify as non-production', () => {
    expect(classifyEnvironment({ appId: 'com.acme.app.dev' })).toMatchObject({ environment: 'test', productionRisk: false });
    expect(classifyEnvironment({ appId: 'com.acme.app', buildType: 'debug' })).toMatchObject({
      environment: 'test',
      productionRisk: false,
    });
    expect(classifyEnvironment({ appId: 'com.acme.app', apiBaseUrls: ['https://staging-api.acme.com'] })).toMatchObject({
      environment: 'staging',
      productionRisk: false,
    });
  });

  it('a production API wins over test signals, and no signal at all is treated as production risk', () => {
    const mixed = classifyEnvironment({ appId: 'com.acme.app', buildType: 'debug', apiBaseUrls: ['https://api.acme.com'] });
    expect(mixed).toMatchObject({ environment: 'production', productionRisk: true });
    expect(mixed.signals.some((s) => s.includes('https://api.acme.com'))).toBe(true);
    const none = classifyEnvironment({ appId: 'com.acme.app' });
    expect(none).toMatchObject({ environment: 'unknown', productionRisk: true });
  });
});

describe('decideGeneratedAccount', () => {
  const env = (environment: EnvironmentClassification['environment'], productionRisk: boolean): EnvironmentClassification => ({
    environment,
    productionRisk,
    confidence: 0.8,
    signals: [],
  });
  const policy = (allowGeneratedAccounts: TestDataPolicy['allowGeneratedAccounts']): TestDataPolicy => ({
    ...DEFAULT_TEST_DATA_POLICY,
    allowGeneratedAccounts,
  });

  it('the default policy allows test and staging only', () => {
    expect(decideGeneratedAccount(DEFAULT_TEST_DATA_POLICY, env('test', false)).allowed).toBe(true);
    expect(decideGeneratedAccount(DEFAULT_TEST_DATA_POLICY, env('staging', false)).allowed).toBe(true);
    const unknown = decideGeneratedAccount(DEFAULT_TEST_DATA_POLICY, env('unknown', true));
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toContain('could not be confirmed as non-production');
  });

  it('a forbidden environment is refused even with an explicit approval', () => {
    const r = decideGeneratedAccount(policy('always'), env('production', true), true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('policy forbids generated accounts in "production"');
  });

  it('an explicit approval covers an unconfirmed environment; an explicit refusal always wins', () => {
    expect(decideGeneratedAccount(DEFAULT_TEST_DATA_POLICY, env('unknown', true), true)).toMatchObject({
      allowed: true,
      reason: 'generated account explicitly approved for this run',
    });
    expect(decideGeneratedAccount(policy('always'), env('test', false), false).allowed).toBe(false);
  });

  it('allowGeneratedAccounts "never" refuses even in test; "always" allows a non-forbidden environment', () => {
    expect(decideGeneratedAccount(policy('never'), env('test', false)).allowed).toBe(false);
    expect(decideGeneratedAccount(policy('always'), env('test', false)).allowed).toBe(true);
  });
});

describe('generateFieldValue', () => {
  const ts = 1_700_000_000_000;

  it('emails follow the policy pattern; the username is the email local part', () => {
    expect(generateFieldValue('email', DEFAULT_TEST_DATA_POLICY, { timestamp: ts })).toEqual({
      value: `swipium_${ts}@yopmail.com`,
      secret: false,
      generator: 'swipium_timestamp',
    });
    expect(generateFieldValue('email', DEFAULT_TEST_DATA_POLICY, { timestamp: ts, index: 2 })?.value).toBe(`swipium_${ts}2@yopmail.com`);
    expect(generateFieldValue('username', DEFAULT_TEST_DATA_POLICY, { timestamp: ts })?.value).toBe(`swipium_${ts}`);
    const noPlaceholder = { ...DEFAULT_TEST_DATA_POLICY, email: { ...DEFAULT_TEST_DATA_POLICY.email, pattern: 'fixed@example.test' } };
    expect(generateFieldValue('email', noPlaceholder, { timestamp: ts })?.value).toBe(`swipium_${ts}@yopmail.com`);
  });

  it('passwords come from the policy and are flagged secret', () => {
    for (const field of ['password', 'confirm_password'] as const) {
      expect(generateFieldValue(field, DEFAULT_TEST_DATA_POLICY)).toEqual({
        value: DEFAULT_TEST_DATA_POLICY.password.value,
        secret: true,
        generator: DEFAULT_TEST_DATA_POLICY.password.generator,
      });
    }
  });

  it('phone and date of birth need an explicit opt-in; an OTP or generic field is never invented', () => {
    expect(generateFieldValue('phone', DEFAULT_TEST_DATA_POLICY)).toBeUndefined();
    expect(generateFieldValue('date_of_birth', DEFAULT_TEST_DATA_POLICY)).toBeUndefined();
    const optIn = { ...DEFAULT_TEST_DATA_POLICY, allowPhone: true, allowDateOfBirth: true };
    expect(generateFieldValue('phone', optIn)?.value).toBe('+15555550123');
    expect(generateFieldValue('date_of_birth', optIn)?.value).toBe('1990-01-15');
    expect(generateFieldValue('otp', optIn)).toBeUndefined();
    expect(generateFieldValue('generic', optIn)).toBeUndefined();
  });

  it('name-like values are deterministic for a given timestamp', () => {
    const a = generateFieldValue('name', DEFAULT_TEST_DATA_POLICY, { timestamp: 3 });
    expect(a).toEqual(generateFieldValue('name', DEFAULT_TEST_DATA_POLICY, { timestamp: 3 }));
    expect(a?.secret).toBe(false);
    expect(generateFieldValue('address', DEFAULT_TEST_DATA_POLICY, { timestamp: 5 })?.value).toBe('105 Test Street');
  });
});
