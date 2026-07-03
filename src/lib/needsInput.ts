// NeedsInput protocol (roadmap §3.2) — a single, consistent shape for the missing-input
// blockers a QA run hits, so an agent forwards ONE concise question to the user instead of
// improvising. It is NOT an error: the run is paused, recoverable, and resumable. The payload
// rides on a normal (ok:true) tool result with `needsInput:true`, and is also embeddable in a
// blocker via `embedNeedsInput`.
//
// Secret fields (passwords, OTPs, tokens) are flagged so the caller redacts them everywhere:
// once provided, the value goes into session.secrets and never appears in artifacts/logs.
//
// Developer 1 contract (Milestone B): EVERY NeedsInput response carries one concise question,
// typed fields (with secret flags), safe fallback options, the EXACT resume call, what Swipium
// already tried (`attempted`), and what happens if the user declines (`ifDeclined`). Agents ask
// one question — never a bundle of guesses — and resume deterministically.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { currentResponseMode } from './result.js';

export interface NeedsInputField {
  name: string;
  /** Secret values are redacted everywhere — never logged, never written to artifacts. */
  secret?: boolean;
  description?: string;
  example?: string;
}

/** The exact tool call that resumes the run once the user answers. */
export interface NeedsInputResume {
  tool: string;
  args: Record<string, unknown>;
}

export interface NeedsInputPayload {
  needsInput: true;
  /** Stable id for the kind of input requested — lets an agent/CLI route the answer. */
  kind: NeedsInputKind;
  /** One concise, user-facing question. */
  question: string;
  fields: NeedsInputField[];
  /** Safe alternatives the user can pick instead of providing the input. */
  fallbackOptions: string[];
  /** The exact resume tool + args (sessionId is injected by qaNeedsInput). */
  resume: NeedsInputResume;
  /** What Swipium already tried before having to ask (filled by qaNeedsInput from the session). */
  attempted: string[];
  /** What happens if the user declines / cannot provide the input. */
  ifDeclined: string;
}

export type NeedsInputKind =
  // roadmap §3.2 Milestone B required set:
  | 'monorepo_target'
  | 'preferred_platform'
  | 'credentials'
  | 'otp_or_manual_verification'
  | 'destructive_exploration_approval'
  | 'signing_team'
  | 'artifact_outside_root'
  | 'external_service_required'
  // retained for backward compatibility with existing callers:
  | 'destructive_reset_approval'
  | 'create_test_data'
  | 'visual_only_fallback';

/** Default resume: hand the answer to qa_continue_from_blocker, which routes by kind. */
function resumeVia(kind: NeedsInputKind): NeedsInputResume {
  return { tool: 'qa_continue_from_blocker', args: { kind } };
}

/**
 * The standardized QA questions (roadmap §3.2). Builders, not constants, so callers can splice
 * in context (which app, which screen) while keeping the field/fallback/resume contract stable.
 * `attempted` is left empty here and filled by qaNeedsInput from the live session.
 */
export const NeedsInput = {
  credentials(context?: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'credentials',
      question:
        (context ? `${context} ` : '') + 'This app appears to require login. Provide test credentials, or ask Swipium to stay pre-login.',
      fields: [
        { name: 'email', secret: false, description: 'Test account email/username' },
        { name: 'password', secret: true, description: 'Test account password' },
      ],
      fallbackOptions: ['test pre-login only', 'use saved session', 'seed login state'],
      resume: resumeVia('credentials'),
      attempted: [],
      ifDeclined: 'Swipium tests pre-login coverage only; authenticated flows are reported as blocked, not failed.',
    };
  },
  otp(context?: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'otp_or_manual_verification',
      question:
        (context ? `${context} ` : '') +
        'A one-time code / manual verification step is required. Provide the code, or approve manual completion.',
      fields: [{ name: 'otp', secret: true, description: 'One-time code from SMS/email/authenticator' }],
      fallbackOptions: ['complete this step manually, then continue', 'skip flows requiring verification'],
      resume: resumeVia('otp_or_manual_verification'),
      attempted: [],
      ifDeclined: 'Flows behind the verification step are skipped and reported as blocked.',
    };
  },
  monorepoTarget(candidates: string[]): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'monorepo_target',
      question: `This is a monorepo with multiple app targets. Which one should Swipium test?`,
      fields: [{ name: 'target', secret: false, description: 'App package/directory to test', example: candidates[0] }],
      fallbackOptions: candidates.slice(0, 6),
      resume: { tool: 'qa_continue_from_blocker', args: { kind: 'monorepo_target' } },
      attempted: [],
      ifDeclined: 'Swipium cannot guess the intended app; the run does not start until a target is chosen.',
    };
  },
  preferredPlatform(available: string[]): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'preferred_platform',
      question: `More than one platform is available. Which should Swipium test first?`,
      fields: [{ name: 'platform', secret: false, example: available[0] }],
      fallbackOptions: available,
      resume: resumeVia('preferred_platform'),
      attempted: [],
      ifDeclined: 'Swipium picks the first available platform automatically and records it as a workaround.',
    };
  },
  destructiveExplorationApproval(what: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'destructive_exploration_approval',
      question: `${what} Exploring it may trigger destructive actions (delete/reset/purchase). Approve, or keep exploration read-only?`,
      fields: [{ name: 'approveDestructive', secret: false, description: 'true to allow potentially destructive exploration' }],
      fallbackOptions: [
        'keep exploration non-destructive (skip risky controls)',
        'approve destructive exploration',
        'run destructive steps last',
      ],
      resume: resumeVia('destructive_exploration_approval'),
      attempted: [],
      ifDeclined: 'Swipium explores non-destructively and skips controls flagged as risky.',
    };
  },
  signingTeam(): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'signing_team',
      question:
        'A simulator build needs Xcode signing/build settings. Provide a development team if your project requires one, or adjust the simulator build.',
      fields: [
        { name: 'developmentTeam', secret: false, description: 'Apple Developer Team ID' },
        { name: 'provisioningProfile', secret: false, description: 'Provisioning profile name (optional)' },
      ],
      fallbackOptions: ['test on simulator instead', 'set up signing in Xcode, then retry'],
      resume: resumeVia('signing_team'),
      attempted: [],
      ifDeclined: 'Swipium reports simulator preparation as blocked until the build settings are fixed.',
    };
  },
  artifactOutsideRoot(path: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'artifact_outside_root',
      question: `The best artifact is outside the project root (${path}). Use it anyway?`,
      fields: [{ name: 'allowOutsideRoot', secret: false }],
      fallbackOptions: ['use it (allowOutsideRoot)', 'build inside the project instead', 'pass an explicit path'],
      resume: resumeVia('artifact_outside_root'),
      attempted: [],
      ifDeclined: 'Swipium ignores the outside-root artifact and tries to build inside the project, or blocks if it cannot.',
    };
  },
  externalServiceRequired(service: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'external_service_required',
      question: `This run needs an external service: ${service}. Provide access/approval to use it, or choose a fallback.`,
      fields: [
        { name: 'serviceEndpoint', secret: false, description: 'URL/host of the required service (if applicable)' },
        { name: 'serviceToken', secret: true, description: 'Access token/key for the service (if required)' },
      ],
      fallbackOptions: ['provide service access', 'mock/stub the service', 'skip flows that need it'],
      resume: resumeVia('external_service_required'),
      attempted: [],
      ifDeclined: 'Flows depending on the external service are skipped and reported as blocked.',
    };
  },

  // ---- retained legacy builders (backward compatibility) ----
  destructiveResetApproval(what: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'destructive_reset_approval',
      question: `${what} This is destructive. Approve it, or choose a non-destructive path.`,
      fields: [{ name: 'approve', secret: false, description: 'true to approve the destructive reset' }],
      fallbackOptions: ['use a release build for clean-state tests', 'run destructive steps last', 'do not reset'],
      resume: resumeVia('destructive_reset_approval'),
      attempted: [],
      ifDeclined: 'Swipium skips the destructive reset and tests from the current app state.',
    };
  },
  createTestData(what: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'create_test_data',
      question: `${what} Should Swipium create the required account/test data, or will you provide it?`,
      fields: [{ name: 'createTestData', secret: false, description: 'true to let Swipium seed it (consent-gated)' }],
      fallbackOptions: ['provide existing test data', 'skip flows needing this data'],
      resume: resumeVia('create_test_data'),
      attempted: [],
      ifDeclined: 'Flows needing the data are skipped and reported as blocked.',
    };
  },
  visualOnlyFallback(screen?: string): NeedsInputPayload {
    return {
      needsInput: true,
      kind: 'visual_only_fallback',
      question:
        `${screen ? `Screen "${screen}" ` : 'This screen '}has no usable UI tree (canvas/map/webview). ` +
        'Use visual-only verification (screenshots), which is weaker evidence?',
      fields: [{ name: 'allowVisualOnly', secret: false }],
      fallbackOptions: ['use visual-only fallback', 'skip this screen', 'add accessibility identifiers and retry'],
      resume: resumeVia('visual_only_fallback'),
      attempted: [],
      ifDeclined: 'Swipium skips the screen and reports it as not verifiable via the UI tree.',
    };
  },
};

function renderQuestion(p: NeedsInputPayload): string {
  const fields = p.fields.map((f) => `${f.name}${f.secret ? ' (secret)' : ''}`).join(', ');
  return [
    `❓ ${p.question}`,
    fields ? `provide: ${fields}` : '',
    p.fallbackOptions.length ? `or: ${p.fallbackOptions.join(' | ')}` : '',
    p.ifDeclined ? `if declined: ${p.ifDeclined}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a NeedsInput result (not an error). The question text is shown in every mode; the
 * full payload is always in structuredContent. `extra` lets a tool attach context (sessionId,
 * what was already tried) the agent needs to resume. When `extra.sessionId` is present it is
 * injected into `resume.args`; `extra.attempted` (string[]) populates `payload.attempted`.
 */
export function qaNeedsInput(p: NeedsInputPayload, extra?: Record<string, unknown>): CallToolResult {
  const sessionId = extra?.sessionId;
  const attempted = Array.isArray(extra?.attempted) ? (extra!.attempted as string[]) : p.attempted;
  const resume: NeedsInputResume = {
    tool: p.resume.tool,
    args: { ...(typeof sessionId === 'string' ? { sessionId } : {}), ...p.resume.args },
  };
  const enriched: NeedsInputPayload = { ...p, attempted, resume };
  const payload = { ok: true, ...enriched, ...(extra ?? {}) };
  const head = renderQuestion(enriched);
  const text = currentResponseMode() === 'compact' ? head : `${head}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  return { content: [{ type: 'text', text }], structuredContent: payload };
}
