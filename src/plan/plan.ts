// qa_plan core (PHASE3-PLAN §3.2) — PURE synthesis. Given what we detected about the
// project + what the session declared (fixtures, observed auth, prepared appId), produce a
// safe test plan: which workflows are READY, which are BLOCKED (and why + how to unblock),
// and which are UNSAFE (and why). No device I/O lives here, so it is fully unit-testable;
// the tool wrapper (src/tools/plan.ts) gathers the inputs and calls buildPlan().

import type { Framework } from '../context/detect.js';
import type { AuthState, Fixture } from '../session/store.js';

// Plan-blocker categories are about *readiness*, distinct from qa_note's outcome categories
// (which are about *results*). Keeping them separate avoids overloading one enum's meaning.
export type PlanBlockCategory = 'missing_device' | 'missing_artifact' | 'missing_test_data' | 'missing_toolchain';

export interface ReadyWorkflow {
  workflow: string;
  budgetProfile: string;
  requires: string[]; // fixture names / preconditions already satisfied
}
export interface BlockedWorkflow {
  workflow: string;
  budgetProfile: string;
  category: PlanBlockCategory;
  requiredState: string;
  recommendedSetup: string;
}
export interface UnsafeWorkflow {
  workflow: string;
  reason: string; // stable code, e.g. bundle_cache_loss
  detail: string;
}
export interface Plan {
  ready: ReadyWorkflow[];
  blocked: BlockedWorkflow[];
  unsafe: UnsafeWorkflow[];
  safetyGates: string[];
  notes: string[];
}

export interface PlanInput {
  framework: Framework;
  hasDevice: boolean; // an online device OR a bootable AVD exists
  hasApk: boolean; // a prebuilt app artifact was found (APK, IPA, or .app)
  appPrepared: boolean; // session already has an appId (installed/launched earlier)
  fixtures: Fixture[];
  auth: AuthState;
  blockers: string[]; // environment blockers surfaced by detectContext
  flows: string[]; // names of .swipium/flows/*.yaml found (PR5+; empty for now)
}

const LOGIN_FIXTURE = /login|auth|account|credential|sign[\s_-]?in/i;

function isDebugRN(fw: Framework): boolean {
  return fw === 'expo' || fw === 'bare-react-native';
}

export function buildPlan(i: PlanInput): Plan {
  const ready: ReadyWorkflow[] = [];
  const blocked: BlockedWorkflow[] = [];
  const unsafe: UnsafeWorkflow[] = [];
  const notes: string[] = [];

  const appAvailable = i.appPrepared || i.hasApk;
  const loginFixture = i.fixtures.find((f) => LOGIN_FIXTURE.test(f.name) || !!f.testAccount);

  // Shared gate: every workflow needs a device and the app present. Emit the right blocked
  // entry once per workflow so the agent sees exactly what each one needs.
  const gateEnv = (workflow: string, budgetProfile: string): BlockedWorkflow | null => {
    if (!i.hasDevice) {
      return {
        workflow,
        budgetProfile,
        category: 'missing_device',
        requiredState: 'an online device or a bootable AVD',
        recommendedSetup: 'Create/boot an AVD (see qa_doctor), then qa_prepare_target.',
      };
    }
    if (!appAvailable) {
      return {
        workflow,
        budgetProfile,
        category: 'missing_artifact',
        requiredState: 'the app installed, or a prebuilt app artifact to install',
        recommendedSetup: 'Drop an APK under apps/android or a simulator .app under apps/ios, then run the platform prepare/attach flow.',
      };
    }
    return null;
  };

  // launch_smoke — the cheapest always-valuable check.
  {
    const g = gateEnv('launch_smoke', 'guardrail');
    if (g) blocked.push(g);
    else ready.push({ workflow: 'launch_smoke', budgetProfile: 'guardrail', requires: [] });
  }

  // visual_smoke — screenshot/landmark check for visual-only (map/canvas) screens.
  {
    const g = gateEnv('visual_smoke', 'login_smoke');
    if (g) blocked.push(g);
    else ready.push({ workflow: 'visual_smoke', budgetProfile: 'login_smoke', requires: [] });
  }

  // login_smoke — needs a credential fixture on top of the env gate.
  {
    const g = gateEnv('login_smoke', 'login_smoke');
    if (g) blocked.push(g);
    else if (!loginFixture) {
      blocked.push({
        workflow: 'login_smoke',
        budgetProfile: 'login_smoke',
        category: 'missing_test_data',
        requiredState: 'a test account (credentials)',
        recommendedSetup:
          'Declare a fixture with a testAccount label (and provide TEST_EMAIL/TEST_PASSWORD via env), or add it to .swipium/fixtures.json.',
      });
    } else {
      ready.push({ workflow: 'login_smoke', budgetProfile: 'login_smoke', requires: [loginFixture.name] });
    }
  }

  // Discovered flow files become first-class candidate workflows (PR5+).
  for (const name of i.flows) {
    const g = gateEnv(name, 'full_smoke');
    if (g) blocked.push(g);
    else ready.push({ workflow: name, budgetProfile: 'full_smoke', requires: [] });
  }

  // Fixtures that declare an unmet requiredState surface as blocked workflows so "no saved
  // flight to delete" reads as setup guidance, not a failure (DESIGN §6 / qa_note semantics).
  for (const f of i.fixtures) {
    if (f.requiredState && !LOGIN_FIXTURE.test(f.name) && !f.testAccount) {
      blocked.push({
        workflow: f.name,
        budgetProfile: 'full_smoke',
        category: 'missing_test_data',
        requiredState: f.requiredState,
        recommendedSetup: f.recommendedSetup ?? `Create the precondition: ${f.requiredState}.`,
      });
    }
  }

  // UNSAFE — destructive actions that Swipium will refuse by default.
  if (isDebugRN(i.framework)) {
    unsafe.push({
      workflow: 'fresh_start',
      reason: 'bundle_cache_loss',
      detail:
        'clear_data / fresh_start wipes the JS bundle of a debug RN/Expo build, leaving a RedBox it cannot reload. Use a release APK (embedded bundle) for clean-state tests, or run destructive workflows last.',
    });
  }
  if (!i.fixtures.some((f) => f.disposable === true || f.environment === 'test')) {
    unsafe.push({
      workflow: 'destructive_exploration',
      reason: 'needs_disposable_state',
      detail:
        'Delete/pay/send/logout workflows require a fixture marked disposable:true or environment:"test" before Swipium can approve an exact destructive candidate.',
    });
  }

  // Safety gates the agent should expect (informational; enforced server-side regardless).
  const safetyGates = [
    'Booting an emulator and installing an external APK each require one-time consent.',
    'Network toggle (offline/online) requires consent and is auto-restored at qa_report.',
    'Destructive app actions (clear_data/fresh_start) require consent; refused by default on debug RN/Expo builds.',
    'Destructive exploration requires dry_run_destructive first, then candidate-bound approval with disposable test state.',
  ];

  if (i.auth.authedAtStart === false || i.auth.loginScreenSeen) {
    notes.push('A login screen was observed — authenticated workflows will need credentials.');
  }
  for (const b of i.blockers) notes.push(b);

  return { ready, blocked, unsafe, safetyGates, notes };
}
