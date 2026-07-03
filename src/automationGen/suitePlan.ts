// SWIPIUM-REQ-04 — suite-generation plan. Pure: assembles the read-only plan behind
// the qa_generate target:"appium" plan from the project profile + (optional) Appium model. No device, no writes.
// Honest about prerequisites (map/recorded actions) and locator readiness.

import { emitJsSuite } from './jsEmitter.js';
import { emitPythonSuite } from './pythonEmitter.js';
import type { AppiumSuiteModel } from './appiumModel.js';
import type { AutomationLanguage, AutomationProjectProfile } from './projectProfile.js';

export interface PlanBlocker {
  code: string;
  detail: string;
  nextStep: string;
}

export type LocatorReadiness = 'durable' | 'mixed' | 'brittle' | 'unknown';

export interface AutomationSuitePlan {
  profile: AutomationProjectProfile;
  language: AutomationLanguage;
  outputDir: string;
  platforms: { android: boolean; ios: boolean };
  backends: { default: string; secondary?: string };
  mapCoverage: {
    hasActions: boolean;
    actionCount: number;
    screenCount: number;
    durable: number;
    semi: number;
    brittle: number;
    brittlePct: number;
  } | null;
  prerequisites: string[];
  filesPlanned: string[];
  blockers: PlanBlocker[];
  locatorReadiness: LocatorReadiness;
  nextAction: string;
}

/** .swipium/automation/<dir> — js for TS/JS, python for Python (matches REQ-04 layout). */
export function outputDirFor(language: AutomationLanguage): string {
  return `.swipium/automation/${language === 'python' ? 'python' : 'js'}`;
}

function readinessFromPct(brittlePct: number, hasActions: boolean): LocatorReadiness {
  if (!hasActions) return 'unknown';
  if (brittlePct === 0) return 'durable';
  if (brittlePct < 40) return 'mixed';
  return 'brittle';
}

export interface BuildPlanOptions {
  model?: AppiumSuiteModel;
  /** Number of recorded actions available (used when no model is built yet). */
  actionCount?: number;
  /** Whether an app map / config exists for the project. */
  mapPresent?: boolean;
  appId?: string;
  includeCi?: boolean;
}

export function buildSuitePlan(profile: AutomationProjectProfile, opts: BuildPlanOptions = {}): AutomationSuitePlan {
  const language = profile.automationLanguage;
  const outputDir = outputDirFor(language);
  const platforms = { android: profile.platforms.android.level !== 'none', ios: profile.platforms.ios.level !== 'none' };
  const blockers: PlanBlocker[] = [];
  const prerequisites: string[] = [];

  const hasActions = !!opts.model && opts.model.steps.length > 0;
  const actionCount = opts.model ? opts.model.steps.length : (opts.actionCount ?? 0);

  let mapCoverage: AutomationSuitePlan['mapCoverage'] = null;
  let filesPlanned: string[] = [];
  if (opts.model) {
    const a = opts.model.audit;
    mapCoverage = {
      hasActions,
      actionCount,
      screenCount: opts.model.screens.length,
      durable: a.durable,
      semi: a.semi,
      brittle: a.brittle,
      brittlePct: a.brittlePct,
    };
    const files =
      language === 'python'
        ? emitPythonSuite({
            model: opts.model,
            profile,
            appId: opts.appId,
            framework: profile.testFramework === 'pytest' ? 'pytest' : 'unittest',
          })
        : emitJsSuite({ model: opts.model, profile, appId: opts.appId, language });
    filesPlanned = files.map((f) => `${outputDir}/${f.path}`);
    filesPlanned.push(`${outputDir}/README.md`);
    if (opts.includeCi) filesPlanned.push(`${outputDir}/ci.example.yml`);
  } else {
    // No model yet — list the skeleton we WOULD generate, and require a recording/map pass first.
    blockers.push({
      code: 'NO_RECORDED_ACTIONS',
      detail: 'No recorded actions / app map to turn into a POM suite.',
      nextStep:
        'Run qa_test_this { goal: "create_automation_suite" } (smoke + explore records actions), or qa_explore to build the app map, then re-run qa_generate target:"appium".',
    });
    prerequisites.push('Record actions via qa_test_this/qa_smoke/qa_explore, or build the app map first.');
  }

  if (!platforms.android && !platforms.ios) {
    blockers.push({
      code: 'NO_PLATFORM_SUPPORT',
      detail: 'Neither Android nor iOS support was detected for this project.',
      nextStep: 'Pass platform=android|ios|both, or point projectRoot at the mobile app target.',
    });
  }

  if (!opts.mapPresent && !opts.model) {
    prerequisites.push('Build/refresh the app map (qa_explore) for cross-platform screen evidence.');
  }

  const locatorReadiness = readinessFromPct(mapCoverage?.brittlePct ?? 0, hasActions);
  if (mapCoverage && mapCoverage.brittle > 0) {
    blockers.push({
      code: 'BRITTLE_LOCATORS',
      detail: `${mapCoverage.brittle} brittle/coordinate locator(s) (${mapCoverage.brittlePct}% brittle) — not release-grade.`,
      nextStep: 'Add durable accessibility id / resource-id / testID; generated suite marks these as candidate-only.',
    });
  }

  const nextAction = blockers.some((b) => b.code === 'NO_RECORDED_ACTIONS')
    ? 'qa_test_this { goal: "create_automation_suite" }'
    : blockers.some((b) => b.code === 'NO_PLATFORM_SUPPORT')
      ? 'qa_generate { target: "appium", mode: "plan", platform: "android" }'
      : 'qa_generate { target: "appium", save: true }';

  return {
    profile,
    language,
    outputDir,
    platforms,
    backends: { default: profile.defaultBackend, secondary: profile.secondaryBackend },
    mapCoverage,
    prerequisites,
    filesPlanned,
    blockers,
    locatorReadiness,
    nextAction,
  };
}
