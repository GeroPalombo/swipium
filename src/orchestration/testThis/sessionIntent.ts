// Durable qa_test_this intent per session: the goal/flags a user asked for, so a resume
// (qa_continue_from_blocker > qa_test_this) replays them instead of silently falling back to the
// default goal, plus the "login declined" choice from a credentials question.
//
// Storage, in lookup order (tolerant of each being absent):
//   1. `session.lastTestThisArgs` ({goal, goalText, flags}), persisted + rehydrated by the store;
//   2. a module-level map keyed by sessionId (same server process), the fallback when the field is absent.
// The login-declined flag rides on the generic persisted `milestones` record.

import type { Session, SessionStore } from '../../session/store.js';
import type { TestThisInput } from './types.js';

/** qa_test_this inputs that express the user's INTENT (never consent/one-shot plumbing). The
 *  device the user named is intent too: a resume that drops it can land on another simulator or
 *  emulator. */
export const TEST_THIS_INTENT_KEYS = [
  'goal',
  'goalText',
  'device',
  'fastSmoke',
  'explore',
  'generateSuite',
  'stopOnNeedsInput',
  'platform',
  'buildIfNeeded',
] as const;

export type TestThisIntent = Partial<Pick<TestThisInput, (typeof TEST_THIS_INTENT_KEYS)[number]>>;

const memory = new Map<string, TestThisIntent>();

function pickIntent(input: Record<string, unknown>): TestThisIntent {
  const out: Record<string, unknown> = {};
  for (const k of TEST_THIS_INTENT_KEYS) if (input[k] !== undefined) out[k] = input[k];
  return out as TestThisIntent;
}

/** Remember the intent keys of a qa_test_this call (merged over any earlier call's). */
export function rememberTestThisIntent(sessions: SessionStore, session: Session, input: TestThisInput): TestThisIntent {
  const current = pickIntent(input as Record<string, unknown>);
  const merged: TestThisIntent = { ...recallTestThisIntent(session), ...current };
  memory.set(session.id, merged);
  const { goal, goalText, ...flags } = merged;
  const record = { goal, goalText, flags: flags as Record<string, unknown> };
  // Tolerate a store without the typed setter (older build): fall back to the plain field.
  const store = sessions as SessionStore & { setLastTestThisArgs?: (s: Session, r: typeof record) => void };
  if (typeof store.setLastTestThisArgs === 'function') store.setLastTestThisArgs(session, record);
  else (session as unknown as { lastTestThisArgs?: unknown }).lastTestThisArgs = record;
  return merged;
}

/** The remembered intent for a session ({} when none). */
export function recallTestThisIntent(session: Pick<Session, 'id' | 'dir'>): TestThisIntent {
  const field = (session as { lastTestThisArgs?: unknown }).lastTestThisArgs as
    { goal?: unknown; goalText?: unknown; flags?: unknown } | undefined;
  if (field && typeof field === 'object') {
    const flags = field.flags && typeof field.flags === 'object' ? (field.flags as Record<string, unknown>) : {};
    return pickIntent({ ...flags, goal: field.goal, goalText: field.goalText });
  }
  const mem = memory.get(session.id);
  if (mem) return { ...mem };
  return {};
}

const LOGIN_DECLINED = 'login_declined';

/** Record that the user chose "test pre-login only": login is out of scope for this session. */
export function markLoginDeclined(sessions: SessionStore, session: Session): void {
  sessions.milestone(session, LOGIN_DECLINED);
}

export function isLoginDeclined(session: Pick<Session, 'milestones'>): boolean {
  return session.milestones?.[LOGIN_DECLINED] != null;
}

/** Login credentials usable RIGHT NOW: metadata alone is not enough. Raw values live only in
 *  memory and are gone after a server restart, so the question must be asked again. */
export function hasUsableCredentials(session: Pick<Session, 'inputs' | 'inputValues'>): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName) && session.inputValues.has(i.varName));
}

/** SWIPIUM_TEST_EMAIL and SWIPIUM_TEST_PASSWORD are both set to non-empty values in the server env
 *  (a blank placeholder is missing). Pure: plan mode uses it to skip the login question too. */
export function envCredentialsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.SWIPIUM_TEST_EMAIL?.trim() && !!env.SWIPIUM_TEST_PASSWORD?.trim();
}

/** SWIPIUM_TEST_EMAIL / SWIPIUM_TEST_PASSWORD (+ SWIPIUM_TEST_OTP) in the server env ARE the
 *  credentials (README "Test login", qa_status rules.credentials): register them as session inputs
 *  (password/OTP redacted) so the login question is not asked and the login path can type them.
 *  No-op unless both email and password are set, or when the session already has usable ones. */
export function seedEnvCredentials(sessions: SessionStore, session: Session, env: NodeJS.ProcessEnv = process.env): boolean {
  const email = env.SWIPIUM_TEST_EMAIL?.trim();
  const password = env.SWIPIUM_TEST_PASSWORD;
  if (!envCredentialsAvailable(env) || !email || !password || hasUsableCredentials(session)) return false;
  sessions.setInput(session, 'SWIPIUM_TEST_EMAIL', email, false, 'env');
  sessions.setInput(session, 'SWIPIUM_TEST_PASSWORD', password, true, 'env');
  if (env.SWIPIUM_TEST_OTP) sessions.setInput(session, 'SWIPIUM_TEST_OTP', env.SWIPIUM_TEST_OTP, true, 'env');
  return true;
}

/** Credentials whose metadata survived a restart but whose values did not. */
export function credentialsLostOnRestart(session: Pick<Session, 'inputs' | 'inputValues'>): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName)) && !hasUsableCredentials(session);
}
