// Durable qa_test_this intent per session: the goal/flags a user asked for, so a resume
// (qa_continue_from_blocker → qa_test_this) replays them instead of silently falling back to the
// default goal, plus the "login declined" choice from a credentials question.
//
// Storage, in lookup order (tolerant of each being absent):
//   1. `session.lastTestThisArgs` ({goal, goalText, flags}) — persisted + rehydrated by the store;
//   2. a module-level map keyed by sessionId (same server process) — fallback when the field is absent.
// The login-declined flag rides on the generic persisted `milestones` record.

import type { Session, SessionStore } from '../../session/store.js';
import type { TestThisInput } from './types.js';

/** qa_test_this inputs that express the user's INTENT (never device/consent/one-shot plumbing). */
export const TEST_THIS_INTENT_KEYS = [
  'goal',
  'goalText',
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

/** Record that the user chose "test pre-login only" — login is out of scope for this session. */
export function markLoginDeclined(sessions: SessionStore, session: Session): void {
  sessions.milestone(session, LOGIN_DECLINED);
}

export function isLoginDeclined(session: Pick<Session, 'milestones'>): boolean {
  return session.milestones?.[LOGIN_DECLINED] != null;
}

/** Login credentials usable RIGHT NOW: metadata alone is not enough — raw values live only in
 *  memory and are gone after a server restart, so the question must be asked again. */
export function hasUsableCredentials(session: Pick<Session, 'inputs' | 'inputValues'>): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName) && session.inputValues.has(i.varName));
}

/** Credentials whose metadata survived a restart but whose values did not. */
export function credentialsLostOnRestart(session: Pick<Session, 'inputs' | 'inputValues'>): boolean {
  return session.inputs.some((i) => /EMAIL|PASSWORD/.test(i.varName)) && !hasUsableCredentials(session);
}
