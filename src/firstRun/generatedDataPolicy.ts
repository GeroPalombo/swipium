// SWIPIUM-REQ-02 — safe generated-data policy + environment classifier + built-in safe generators.
//
// Controlled autonomy: Swipium will only invent values for input fields (to create a throwaway
// account, fill onboarding, etc.) when policy AND the classified environment say it is safe. The
// guardrails follow the MCP security best-practices (consent, least privilege) and Anthropic's
// "use environmental ground truth at each step" guidance — if production cannot be ruled out we do
// NOT create an account; we ask one NeedsInput question instead.
//
// Secrets (generated passwords) are flagged so they go into the session redaction set and never
// appear in reports/artifacts/app map. Generated emails are non-secret and recorded as evidence so
// a developer can reproduce the throwaway account.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldKind } from './types.js';

export type AllowGeneratedAccounts = 'never' | 'test_or_staging_only' | 'always';
export type Environment = 'test' | 'staging' | 'production' | 'unknown';

export interface TestDataPolicy {
  schemaVersion: 1;
  allowGeneratedAccounts: AllowGeneratedAccounts;
  email: {
    generator: string;
    pattern: string; // contains <timestamp>
    externalMailboxProvider?: string; // e.g. 'yopmail' — only used when set + requiresNetwork honored
    requiresNetwork: boolean;
  };
  password: {
    generator: string;
    value: string;
    secret: boolean;
  };
  /** Optional generators that are off by default and require explicit policy opt-in. */
  allowPhone?: boolean;
  allowDateOfBirth?: boolean;
  forbiddenEnvironments: string[];
  requiresDisposableStateForDestructiveActions: boolean;
  recordGeneratedValues: boolean;
  cleanup: {
    requiredWhenSupported: boolean;
    strategy: string;
  };
}

export const DEFAULT_TEST_DATA_POLICY: TestDataPolicy = {
  schemaVersion: 1,
  allowGeneratedAccounts: 'test_or_staging_only',
  email: {
    generator: 'swipium_timestamp',
    pattern: 'swipium_<timestamp>@yopmail.com',
    externalMailboxProvider: 'yopmail',
    requiresNetwork: true,
  },
  password: {
    generator: 'strong_default',
    value: 'Celtics1230!',
    secret: true,
  },
  allowPhone: false,
  allowDateOfBirth: false,
  forbiddenEnvironments: ['production'],
  requiresDisposableStateForDestructiveActions: true,
  recordGeneratedValues: true,
  cleanup: {
    requiredWhenSupported: true,
    strategy: 'app_or_api_if_declared',
  },
};

export const DEFAULT_POLICY_PATH = '.swipium/test-data-policy.json';

/** Load `.swipium/test-data-policy.json` from the project root (or an explicit path), deep-merged
 *  over the safe default. A missing/corrupt file falls back to the default — never throws. */
export function loadTestDataPolicy(root: string, explicitPath?: string): { policy: TestDataPolicy; source: string } {
  const path = explicitPath
    ? (explicitPath.startsWith('/') ? explicitPath : join(root, explicitPath))
    : join(root, DEFAULT_POLICY_PATH);
  if (!existsSync(path)) return { policy: DEFAULT_TEST_DATA_POLICY, source: 'default' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TestDataPolicy>;
    const policy: TestDataPolicy = {
      ...DEFAULT_TEST_DATA_POLICY,
      ...raw,
      email: { ...DEFAULT_TEST_DATA_POLICY.email, ...(raw.email ?? {}) },
      password: { ...DEFAULT_TEST_DATA_POLICY.password, ...(raw.password ?? {}) },
      cleanup: { ...DEFAULT_TEST_DATA_POLICY.cleanup, ...(raw.cleanup ?? {}) },
      forbiddenEnvironments: raw.forbiddenEnvironments ?? DEFAULT_TEST_DATA_POLICY.forbiddenEnvironments,
    };
    return { policy, source: path };
  } catch {
    return { policy: DEFAULT_TEST_DATA_POLICY, source: 'default (unreadable policy file)' };
  }
}

// ---------------------------------------------------------------------------------------------
// Environment classifier — decides whether the app under test is test / staging / production.
// ---------------------------------------------------------------------------------------------

export interface EnvironmentSignalsInput {
  appId?: string; // package / bundle id
  buildType?: string; // 'debug' | 'release' | …
  apiBaseUrls?: string[]; // discovered from config, if any
  /** A developer-declared disposable/test fixture is the strongest "safe to generate" signal. */
  hasDisposableState?: boolean;
  /** An explicit environment a fixture declared (test/staging/production). */
  declaredEnvironment?: string;
  configText?: string; // raw app config blob to scan (app.json/strings/etc.)
}

export interface EnvironmentClassification {
  environment: Environment;
  confidence: number; // 0..1
  signals: string[];
  /** True when production cannot be confidently ruled out. */
  productionRisk: boolean;
}

const TEST_TOKEN = /\b(test|qa|uat|sandbox|staging|stage|dev|develop|development|debug|internal|preview|nonprod|non-prod)\b/i;
const STAGING_TOKEN = /\b(staging|stage|uat|preprod|pre-prod)\b/i;
const PROD_TOKEN = /\b(prod|production|release|live|www)\b/i;
const PROD_HOST = /https?:\/\/(?:api\.|www\.)?(?!.*(?:staging|stage|test|qa|uat|sandbox|dev|preprod|localhost|127\.0\.0\.1|10\.|192\.168)).+\.(?:com|net|org|io|app|co)\b/i;

/** Classify the environment from app id / build / config signals. Conservative: when nothing rules
 *  production out, `productionRisk` is true so the caller asks before creating an account. */
export function classifyEnvironment(input: EnvironmentSignalsInput): EnvironmentClassification {
  const signals: string[] = [];

  // 1. An explicitly declared disposable/test fixture is authoritative.
  if (input.declaredEnvironment) {
    const env = input.declaredEnvironment.toLowerCase();
    if (env === 'production' || env === 'prod' || env === 'live') {
      signals.push('fixture declares environment=production');
      return { environment: 'production', confidence: 0.95, signals, productionRisk: true };
    }
    if (env === 'staging') {
      signals.push('fixture declares environment=staging');
      return { environment: 'staging', confidence: 0.9, signals, productionRisk: false };
    }
    signals.push(`fixture declares environment=${env}`);
    return { environment: 'test', confidence: 0.9, signals, productionRisk: false };
  }
  if (input.hasDisposableState) {
    signals.push('a disposable/test fixture is declared for this session');
    return { environment: 'test', confidence: 0.85, signals, productionRisk: false };
  }

  const idHay = `${input.appId ?? ''}`;
  const apiHay = (input.apiBaseUrls ?? []).join(' ');
  const cfgHay = `${input.configText ?? ''}`;

  // 2. Production signals (any one of these flips productionRisk on).
  let prodHits = 0;
  if (PROD_TOKEN.test(idHay)) { signals.push(`app id "${input.appId}" contains a production-like token`); prodHits++; }
  for (const url of input.apiBaseUrls ?? []) {
    if (STAGING_TOKEN.test(url) || TEST_TOKEN.test(url)) continue;
    if (PROD_HOST.test(url) || PROD_TOKEN.test(url)) { signals.push(`API base URL looks production: ${url}`); prodHits++; }
  }

  // 3. Test/staging signals.
  let testHits = 0;
  let stagingHits = 0;
  if (STAGING_TOKEN.test(idHay) || STAGING_TOKEN.test(apiHay)) { signals.push('app id / API contains a staging token'); stagingHits++; }
  if (TEST_TOKEN.test(idHay)) { signals.push(`app id "${input.appId}" contains a test/dev token`); testHits++; }
  if (TEST_TOKEN.test(apiHay)) { signals.push('API base URL contains a test/dev token'); testHits++; }
  if (input.buildType && /debug/i.test(input.buildType)) { signals.push('build type is debug'); testHits++; }
  if (TEST_TOKEN.test(cfgHay)) { signals.push('app config contains a test/dev token'); testHits++; }

  if (stagingHits > 0 && prodHits === 0) {
    return { environment: 'staging', confidence: 0.75, signals, productionRisk: false };
  }
  if (testHits > 0 && prodHits === 0) {
    return { environment: 'test', confidence: Math.min(0.8, 0.5 + testHits * 0.12), signals, productionRisk: false };
  }
  if (prodHits > 0) {
    return { environment: 'production', confidence: Math.min(0.85, 0.55 + prodHits * 0.15), signals, productionRisk: true };
  }

  // 4. Nothing decisive → unknown, and we MUST treat unknown as production-risk (fail safe).
  signals.push('no decisive test/staging signal — environment cannot be confirmed as non-production');
  return { environment: 'unknown', confidence: 0.3, signals, productionRisk: true };
}

export interface GeneratedAccountDecision {
  allowed: boolean;
  reason: string;
  environment: EnvironmentClassification;
}

/** Combine policy + environment into the single "may Swipium create a throwaway account?" verdict. */
export function decideGeneratedAccount(policy: TestDataPolicy, env: EnvironmentClassification, override?: boolean): GeneratedAccountDecision {
  if (override === false) {
    return { allowed: false, reason: 'generated-account creation was explicitly disabled for this run', environment: env };
  }
  if (policy.forbiddenEnvironments.map((e) => e.toLowerCase()).includes(env.environment)) {
    return { allowed: false, reason: `policy forbids generated accounts in "${env.environment}" environments`, environment: env };
  }
  if (env.productionRisk && override !== true) {
    return {
      allowed: false,
      reason: env.environment === 'production'
        ? 'environment classified as production — refusing automatic account creation'
        : 'environment could not be confirmed as non-production — refusing automatic account creation',
      environment: env,
    };
  }
  if (policy.allowGeneratedAccounts === 'never') {
    return { allowed: false, reason: 'policy disallows generated accounts (allowGeneratedAccounts="never")', environment: env };
  }
  if (policy.allowGeneratedAccounts === 'always' || override === true) {
    return { allowed: true, reason: override === true ? 'generated account explicitly approved for this run' : 'policy allows generated accounts (always)', environment: env };
  }
  // test_or_staging_only
  if (env.environment === 'test' || env.environment === 'staging') {
    return { allowed: true, reason: `policy allows generated accounts in ${env.environment} (test_or_staging_only)`, environment: env };
  }
  return { allowed: false, reason: `policy allows generated accounts only in test/staging; environment is "${env.environment}"`, environment: env };
}

// ---------------------------------------------------------------------------------------------
// Built-in safe generators.
// ---------------------------------------------------------------------------------------------

export interface GeneratedValue {
  value: string;
  secret: boolean;
  generator: string;
}

export interface GeneratorOptions {
  /** Injected for deterministic tests; defaults to Date.now() at runtime. */
  timestamp?: number;
  index?: number; // disambiguate multiple generated values in one run
}

const GIVEN_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Riley', 'Morgan', 'Jamie'];
const FAMILY_NAMES = ['Tester', 'Quality', 'Sample', 'Probe', 'Fixture'];
const CITIES = ['Springfield', 'Rivertown', 'Lakeview', 'Fairview', 'Brookside'];

function emailFromPattern(pattern: string, ts: number, index?: number): string {
  const stamp = index != null ? `${ts}${index}` : `${ts}`;
  return pattern.includes('<timestamp>') ? pattern.replace('<timestamp>', stamp) : `swipium_${stamp}@yopmail.com`;
}

/** Generate a safe value for a field kind under the policy. Returns undefined when the field kind
 *  is not safely generatable without explicit policy opt-in (phone/date_of_birth) or never
 *  (otp — must come from a real provider). */
export function generateFieldValue(field: FieldKind, policy: TestDataPolicy, opts: GeneratorOptions = {}): GeneratedValue | undefined {
  const ts = opts.timestamp ?? Date.now();
  const i = opts.index;
  switch (field) {
    case 'email':
      return { value: emailFromPattern(policy.email.pattern, ts, i), secret: false, generator: policy.email.generator };
    case 'username':
      // Derive a safe, unique handle from the email local-part so it's collision-resistant per run.
      return { value: emailFromPattern(policy.email.pattern, ts, i).split('@')[0], secret: false, generator: 'username_default' };
    case 'password':
    case 'confirm_password':
      return { value: policy.password.value, secret: policy.password.secret, generator: policy.password.generator };
    case 'name':
      return { value: `${GIVEN_NAMES[ts % GIVEN_NAMES.length]} ${FAMILY_NAMES[ts % FAMILY_NAMES.length]}`, secret: false, generator: 'name_default' };
    case 'first_name':
      return { value: GIVEN_NAMES[ts % GIVEN_NAMES.length], secret: false, generator: 'name_default' };
    case 'last_name':
      return { value: FAMILY_NAMES[ts % FAMILY_NAMES.length], secret: false, generator: 'name_default' };
    case 'city':
      return { value: CITIES[ts % CITIES.length], secret: false, generator: 'city_default' };
    case 'address':
      return { value: `${100 + (ts % 900)} Test Street`, secret: false, generator: 'address_default' };
    case 'search':
      return { value: 'test', secret: false, generator: 'search_default' };
    case 'phone':
      return policy.allowPhone ? { value: '+15555550123', secret: false, generator: 'phone_default' } : undefined;
    case 'date_of_birth':
      return policy.allowDateOfBirth ? { value: '1990-01-15', secret: false, generator: 'dob_default' } : undefined;
    case 'otp':
      return undefined; // never invented — only a declared provider may supply it
    default:
      return undefined;
  }
}
