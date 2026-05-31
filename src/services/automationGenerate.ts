// SWIPIUM-REQ-04 — automation-suite assembly service. Ties the pure automationGen modules to a
// session's recorded actions: build the project profile, reuse the canonical Swipium POM as the
// intermediate model, build the cross-platform Appium model, and emit JS/TS or Python suite files
// (+ README, optional CI example). Writing to disk is the caller's job (so plan/preview stay pure).

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { GeneratedFile } from '../suite/pom.js';
import { pomForSession, appIdOf } from './suiteGenerate.js';
import { buildProjectProfile, type AutomationProjectProfile, type ProfileInputs } from '../automationGen/projectProfile.js';
import { buildAppiumModel, type AppiumSuiteModel } from '../automationGen/appiumModel.js';
import { emitJsSuite } from '../automationGen/jsEmitter.js';
import { emitPythonSuite } from '../automationGen/pythonEmitter.js';
import { emitReadme } from '../automationGen/readmeEmitter.js';
import { emitCiExample } from '../automationGen/ciEmitter.js';
import { buildSuitePlan, outputDirFor, type AutomationSuitePlan } from '../automationGen/suitePlan.js';
import { computeDependencyPatch, type DependencyPatch } from '../automationGen/packagePatch.js';
import type { Session } from '../session/store.js';

export interface AssembledSuite {
  profile: AutomationProjectProfile;
  model: AppiumSuiteModel;
  outputDir: string; // relative to project root
  /** Files with paths relative to `outputDir`. */
  files: GeneratedFile[];
  dependencyPatch: DependencyPatch;
  plan: AutomationSuitePlan;
}

/** True when .swipium/config.json (app map / scan) exists for the project. */
export function mapPresent(root: string): boolean {
  return existsSync(join(root, '.swipium', 'config.json'));
}

export function buildAutomationProfile(session: Session, inputs: ProfileInputs = {}): AutomationProjectProfile {
  return buildProjectProfile(session.root, { ...inputs, appId: inputs.appId ?? appIdOf(session) });
}

/**
 * Assemble (but do not write) the full automation suite from a session's recorded actions.
 * Returns null-free file list with paths relative to the chosen output dir.
 */
export function assembleAutomationSuite(
  session: Session,
  inputs: ProfileInputs & { name?: string; includeCi?: boolean } = {},
): AssembledSuite {
  const profile = buildAutomationProfile(session, inputs);
  const { pom } = pomForSession(session, inputs.name);
  const appId = appIdOf(session);
  const platforms = {
    android: profile.platforms.android.level !== 'none',
    ios: profile.platforms.ios.level !== 'none',
  };
  const outputDir = outputDirFor(profile.automationLanguage);
  const model = buildAppiumModel(pom, { platforms, sourceFilePrefix: '../../../' });

  const codeFiles = profile.automationLanguage === 'python'
    ? emitPythonSuite({ model, profile, appId, framework: profile.testFramework === 'pytest' ? 'pytest' : 'unittest' })
    : emitJsSuite({ model, profile, appId, language: profile.automationLanguage });

  const files: GeneratedFile[] = [...codeFiles];
  files.push({ path: 'README.md', content: emitReadme({ model, profile, language: profile.automationLanguage, appId, outputDir }) });
  if (inputs.includeCi) files.push({ path: 'ci.example.yml', content: emitCiExample(profile.automationLanguage, { appId }) });

  const dependencyPatch = computeDependencyPatch(profile);
  const plan = buildSuitePlan(profile, { model, appId, mapPresent: mapPresent(session.root), includeCi: inputs.includeCi });

  return { profile, model, outputDir, files, dependencyPatch, plan };
}

/** Write assembled files under <root>/<outputDir>, returning absolute paths written. */
export function writeAutomationFiles(root: string, outputDir: string, files: GeneratedFile[]): string[] {
  const base = join(root, outputDir);
  const written: string[] = [];
  for (const f of files) {
    const abs = join(base, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(abs);
  }
  return written;
}
