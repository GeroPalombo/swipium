// Shared types for the qa_test_this orchestration state machine (split out of
// src/tools/testThis.ts). Pure declarations + tiny helpers — no side effects.

import type { ProjectScan } from '../../context/scan.js';
import type { TestGoal } from '../goal.js';
import type { ResolveResult } from '../../artifacts/resolve.js';
import type { BuildPlatform } from '../../build/plan.js';
import type { TargetSelection, TargetPlan } from '../../core/targetPlan.js';
import type { AppKnowledgeMap } from '../../appMap/schema.js';
import { NeedsInput } from '../../lib/needsInput.js';

export type State = 'ready' | 'needs_input' | 'blocked' | 'unsafe';

export type ExecState = 'completed' | 'blocked' | 'unsafe';

export interface PlanStep {
  tool: string;
  why: string;
  args?: Record<string, unknown>;
  status: 'pending' | 'satisfied';
  /** Symbolic outputs this step produces (e.g. artifact.path) — Milestone E. */
  produces?: string[];
  /** Symbolic inputs a later step needs before it can run. */
  requires?: string[];
}

export const selToPlatform: Record<TargetSelection, BuildPlatform> = {
  'android-emulator': 'android',
  'android-real': 'android',
  'ios-simulator': 'ios',
  'ios-real': 'ios',
};

export function isAndroidEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+/.test(serial);
}

/** The qa_test_this input arguments (mirrors the tool's zod input schema). */
export interface TestThisInput {
  sessionId?: string;
  projectRoot?: string;
  mode?: 'plan' | 'execute' | 'interactive';
  goal?: TestGoal;
  goalText?: string;
  fastSmoke?: boolean;
  platform?: 'android' | 'ios';
  device?: string;
  preferRealDevice?: boolean;
  allowOutsideRoot?: boolean;
  buildIfNeeded?: boolean;
  generateSuite?: boolean;
  explore?: boolean;
  stopOnNeedsInput?: boolean;
  waitForCompletion?: boolean;
  timeoutMs?: number;
  consentId?: string;
  approve?: boolean;
}

export interface ExecuteArgs {
  mode: 'execute' | 'interactive';
  scan: ProjectScan;
  art: ResolveResult;
  target: TargetPlan;
  isAndroid: boolean;
  isIosReal: boolean;
  isAab: boolean;
  needBuild: boolean;
  effectiveApk?: string;
  platform?: 'android' | 'ios';
  goal: TestGoal;
  goalText?: string;
  releaseGate: boolean;
  requiredOutputs: string[];
  artifactChoice: { path?: string; why: string; alternatives: string[] } | null;
  targetChoice: { target?: string; why: string; alternatives: string[] } | null;
  generateSuite: boolean;
  explore: boolean;
  stopOnNeedsInput: boolean;
  waitForCompletion?: boolean;
  timeoutMs?: number;
  consentId?: string;
  approve?: boolean;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
  testThisPlanMutation?: { affects: Record<string, unknown>; risk: 'low' | 'medium' | 'high' };
  optionalQuestion?: ReturnType<typeof NeedsInput.credentials>;
  workaroundLog: () => string[];
  /** Pre-launch static app map (Vision Gap Fix 1) — feeds first-run static candidates + report context. */
  prelaunchMap?: AppKnowledgeMap;
  appMapUri?: string;
}
