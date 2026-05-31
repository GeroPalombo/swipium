// Uniform terminal result envelope for qa_test_this (Developer 1, roadmap §3.1 Milestone B).
// Every terminal orchestration state — completed | blocked | unsafe | needs_input | running —
// is summarizable from STRUCTURED output, with no log parsing: what was attempted, what safe
// fallbacks were taken, which artifact/target was chosen and why, typed blockers with owner +
// fix, the report URI, and the single exact next call.
//
// Developer 1 owns the ENVELOPE shape, not the source data: artifact/target explanations come
// from Developer 2's services; suite/report/readiness summaries come from Developer 3's. This
// module only normalizes those into one stable contract.

import { FAILURES, failureOwner, isSelfFixable, type FailureCode } from '../oracle/failures.js';

export type TerminalState = 'completed' | 'blocked' | 'unsafe' | 'needs_input' | 'running';

export interface ChoiceExplanation {
  /** The chosen value (artifact path / target id). */
  path?: string;
  target?: string;
  /** Why Swipium chose it (from the resolver/planner). */
  why: string;
  /** Other viable options not chosen. */
  alternatives: string[];
}

export interface TypedBlocker {
  failureCode: string;
  owner: 'app' | 'environment' | 'swipium' | 'user';
  /** Whether retrying the same call could succeed without changing anything. */
  retrySafe: boolean;
  /** Whether Swipium can resolve this itself. */
  canSwipiumFix: boolean;
  whatItMeans: string;
  howToFix: string;
}

export interface NextRecommendedAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface TerminalEnvelope {
  state: TerminalState;
  sessionId: string;
  jobId: string | null;
  summary: string;
  /** Steps Swipium actually ran (build, prepare, smoke, …). */
  attempted: string[];
  /** Safe fallbacks Swipium chose on its own (honesty trail, §11). */
  workaroundsAttempted: string[];
  artifactChoice: ChoiceExplanation | null;
  targetChoice: ChoiceExplanation | null;
  blockers: TypedBlocker[];
  reportUri: string | null;
  nextRecommendedAction: NextRecommendedAction | null;
}

export interface EnvelopeInput {
  state: TerminalState;
  sessionId: string;
  jobId?: string | null;
  summary: string;
  attempted?: string[];
  workaroundsAttempted?: string[];
  artifactChoice?: ChoiceExplanation | null;
  targetChoice?: ChoiceExplanation | null;
  blockers?: TypedBlocker[];
  reportUri?: string | null;
  nextRecommendedAction?: NextRecommendedAction | null;
}

/** Build a typed blocker from a Swipium failure code (owner + retry-safety + fix come from the
 *  failure taxonomy, so an agent can route the blocker without a second lookup). */
export function typedBlockerFromCode(code: string, override?: Partial<TypedBlocker>): TypedBlocker {
  const info = FAILURES[code as FailureCode];
  if (!info) {
    return {
      failureCode: code,
      owner: 'swipium',
      retrySafe: true,
      canSwipiumFix: false,
      whatItMeans: 'Unrecognized failure code.',
      howToFix: 'Inspect the run report; call qa_explain_blocker for guidance.',
      ...override,
    };
  }
  return {
    failureCode: code,
    owner: failureOwner(code as FailureCode),
    retrySafe: info.retrySafe,
    canSwipiumFix: isSelfFixable(code as FailureCode),
    whatItMeans: info.summary,
    howToFix: info.recovery,
    ...override,
  };
}

/** Normalize the orchestration outcome into the uniform terminal envelope (never throws). */
export function buildTerminalEnvelope(input: EnvelopeInput): TerminalEnvelope {
  return {
    state: input.state,
    sessionId: input.sessionId,
    jobId: input.jobId ?? null,
    summary: input.summary,
    attempted: input.attempted ?? [],
    workaroundsAttempted: input.workaroundsAttempted ?? [],
    artifactChoice: input.artifactChoice ?? null,
    targetChoice: input.targetChoice ?? null,
    blockers: input.blockers ?? [],
    reportUri: input.reportUri ?? null,
    nextRecommendedAction: input.nextRecommendedAction ?? null,
  };
}
