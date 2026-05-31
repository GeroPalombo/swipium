// SWIPIUM-REQ-02 — shared types for the first-run smoke / auth / onboarding / safe-test-data lane.
// These describe the data exchanged between the screen classifier, the input planner, the auth /
// onboarding / paywall state machines, and the firstRunPlanner. They are intentionally
// backend-neutral (no Driver references) so the planning layer stays pure + unit-testable; the
// driver loop in firstRunRunner.ts is the only part that touches a real device.

export type ScreenPurpose =
  | 'login'
  | 'create_account'
  | 'login_or_create_account'
  | 'credential_setup'
  | 'otp_or_email_verification'
  | 'onboarding'
  | 'permissions_prompt'
  | 'paywall'
  | 'home'
  | 'feature'
  | 'settings'
  | 'error'
  | 'unknown';

/** Canonical field kinds the input planner understands. */
export type FieldKind =
  | 'email'
  | 'username'
  | 'password'
  | 'confirm_password'
  | 'name'
  | 'first_name'
  | 'last_name'
  | 'phone'
  | 'city'
  | 'address'
  | 'search'
  | 'date_of_birth'
  | 'otp'
  | 'generic';

export interface FieldLocator {
  strategy?: string; // 'id' | 'accessibility' | 'text' | 'coordinate'
  value?: string;
}

/** A field on the current screen that must be filled before the form can advance. */
export interface InputRequirement {
  ref: string; // @eN element ref from the snapshot
  field: FieldKind;
  label?: string;
  secure: boolean; // password / secure-text — value must be masked
  required: boolean;
  locator?: FieldLocator;
  bounds?: [number, number, number, number];
}

export type PlannedActionType = 'tap' | 'type' | 'back' | 'scroll' | 'skip' | 'wait';

/** The value an input action will type — never the raw value (that stays in the secure store). */
export interface PlannedInputValue {
  varName: string; // flow variable the value is stored under (e.g. SWIPIUM_TEST_EMAIL)
  secret: boolean;
  source: 'secure_input' | 'fixture' | 'generator';
  generator?: string; // when source === 'generator'
}

/** A bounded, single action the first-run planner intends to perform on the current screen. */
export interface PlannedAction {
  type: PlannedActionType;
  targetRef?: string;
  label?: string;
  locator?: FieldLocator;
  bounds?: [number, number, number, number];
  field?: FieldKind; // for type actions
  value?: PlannedInputValue; // for type actions
  reason: string;
  risk?: 'safe' | 'unknown' | 'destructive';
}

export interface MapLink {
  kind: 'staticScreen' | 'runtimeScreen' | 'feature';
  id: string;
  confidence: number;
}

export interface ScreenClassification {
  purpose: ScreenPurpose;
  confidence: number; // 0..1
  evidence: string[];
  requiredInputs: InputRequirement[];
  safeActions: PlannedAction[];
  blockedReasons: string[];
  mapLinks: MapLink[];
}

/** A forward-compatible patch into the durable app map (SWIPIUM-REQ-01). Until that module lands
 *  these are persisted as a session artifact + note and returned to the caller, so a later app-map
 *  implementation can replay them without changing this contract. */
export interface AppMapPatch {
  at: number;
  screenSignature: string;
  runtimeScreenId: string;
  purpose: ScreenPurpose;
  confidence: number;
  evidence: string[];
  authState?: string;
  links: MapLink[];
  transition?: { fromSignature?: string; action: string; outcome: 'changed_screen' | 'same_screen' };
}

export type FirstRunState = 'ready' | 'needs_input' | 'blocked' | 'unsafe' | 'completed';

export interface FirstRunPlan {
  state: FirstRunState;
  classification: ScreenClassification;
  actions: PlannedAction[];
  expectedNextPurposes: ScreenPurpose[];
  stopConditions: string[];
  mapUpdates: AppMapPatch[];
  /** Human-readable reason for an unsafe/blocked/needs_input state (e.g. why account creation refused). */
  reason?: string;
  /** The single question to raise when state === 'needs_input' (or 'unsafe' with a fallback ask). */
  needsInput?: { kind: string; reason: string };
  /** The auth/onboarding/paywall path taken on this screen (for reporting). */
  pathTaken?: 'login' | 'create_account' | 'credential_setup' | 'onboarding' | 'paywall' | 'permissions' | 'home' | 'none';
  /** A recommended tool to hand off to when first-run pauses/finishes. */
  nextRecommendedTool?: string;
}
