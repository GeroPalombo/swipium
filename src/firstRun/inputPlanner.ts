// SWIPIUM-REQ-02 — planInputForField(): decide what (if anything) to type into a field, with a
// strict priority order so Swipium never invents data unless policy + environment allow it.
//
// Priority:
//   1. Existing secure user input for the matching field (from a NeedsInput resume).
//   2. Declared fixture value or generator.
//   3. Built-in safe generator — ONLY when generated accounts are allowed for this environment.
//   4. NeedsInput when the value is unsafe/unknown but required.
//   5. Skip (blocked) when the field is optional.
//
// PURE w.r.t. the device: it reads the session's secure store + fixtures and returns a decision.
// Recording a freshly generated value (evidence + redaction) is the runner's job, via the
// `record:true` flag on a generator decision.

import { resolveFixtureValue } from '../fixtures/catalog.js';
import type { NeedsInputKind } from '../lib/needsInput.js';
import type { Session } from '../session/store.js';
import { generateFieldValue, type TestDataPolicy } from './generatedDataPolicy.js';
import type { FieldKind, InputRequirement } from './types.js';

export interface InputPlanContext {
  policy: TestDataPolicy;
  /** Whether generated values are allowed at all (from decideGeneratedAccount). */
  generationAllowed: boolean;
  /** For deterministic generation in tests. */
  timestamp?: number;
  index?: number;
}

export type InputPlan =
  | {
      decision: 'secure_input' | 'fixture' | 'generator';
      value: string;
      varName: string;
      secret: boolean;
      source: 'secure_input' | 'fixture' | 'generator';
      generator?: string;
      /** True when the runner must persist this value (generated this run) as evidence + redaction. */
      record?: boolean;
      field: FieldKind;
    }
  | { decision: 'needs_input'; kind: NeedsInputKind; reason: string; field: FieldKind }
  | { decision: 'skip'; reason: string; field: FieldKind };

const CANONICAL_VAR: Partial<Record<FieldKind, string>> = {
  email: 'SWIPIUM_TEST_EMAIL',
  username: 'SWIPIUM_TEST_USERNAME',
  password: 'SWIPIUM_TEST_PASSWORD',
  confirm_password: 'SWIPIUM_TEST_PASSWORD',
  otp: 'SWIPIUM_TEST_OTP',
};

function generatorVarName(field: FieldKind): string {
  return CANONICAL_VAR[field] ?? `SWIPIUM_GEN_${field.toUpperCase()}`;
}

/** Plan the value for one field. Does not mutate the session (the runner records generated values). */
export function planInputForField(session: Session, req: InputRequirement, ctx: InputPlanContext): InputPlan {
  const { field } = req;

  // 1. Existing secure user input for this field.
  const canonical = CANONICAL_VAR[field];
  if (canonical) {
    const existing = session.inputValues.get(canonical);
    if (existing != null) {
      const secret = field === 'password' || field === 'confirm_password' || field === 'otp';
      return { decision: 'secure_input', value: existing, varName: canonical, secret, source: 'secure_input', field };
    }
  }

  // 2. Declared fixture value or generator (existing fixture catalog — may itself mutate session
  //    for fixture-declared generators, which is the intended behavior).
  const fixture = resolveFixtureValue(session, req.label, req.locator?.value, { role: req.field });
  if (fixture) {
    return { decision: 'fixture', value: fixture.value, varName: fixture.varName, secret: fixture.secret, source: 'fixture', generator: fixture.generator, field };
  }

  // OTP is never invented — only a real provider or a secure input may supply it.
  if (field === 'otp') {
    return { decision: 'needs_input', kind: 'otp_or_manual_verification', reason: 'a one-time code is required and cannot be generated', field };
  }

  // 3. Built-in safe generator, gated on the generated-account decision + policy field opt-ins.
  if (ctx.generationAllowed) {
    const gen = generateFieldValue(field, ctx.policy, { timestamp: ctx.timestamp, index: ctx.index });
    if (gen) {
      return { decision: 'generator', value: gen.value, varName: generatorVarName(field), secret: gen.secret, source: 'generator', generator: gen.generator, record: true, field };
    }
    // generation allowed but this field is not safely generatable (phone/dob without opt-in).
    if (req.required) {
      return { decision: 'needs_input', kind: 'create_test_data', reason: `field "${req.label ?? field}" cannot be safely generated under the current policy`, field };
    }
    return { decision: 'skip', reason: `optional field "${req.label ?? field}" left blank (not safely generatable)`, field };
  }

  // 4 / 5. No safe value available.
  if (req.required) {
    const kind: NeedsInputKind = field === 'email' || field === 'username' || field === 'password' || field === 'confirm_password' ? 'credentials' : 'create_test_data';
    return { decision: 'needs_input', kind, reason: `required field "${req.label ?? field}" has no safe value and generation is not allowed here`, field };
  }
  return { decision: 'skip', reason: `optional field "${req.label ?? field}" skipped — no value source and generation not allowed`, field };
}
