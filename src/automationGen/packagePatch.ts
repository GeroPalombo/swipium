// SWIPIUM-REQ-04 — package/dependency patch computation. Pure: computes WHAT would need to change
// in the user's package.json / requirements to run a project-native suite, WITHOUT mutating anything.
// Per the non-goals, Swipium never silently installs deps or edits package.json/pyproject.toml
// outside .swipium — this just describes the diff so the tool can request explicit consent.

import type { AutomationProjectProfile } from './projectProfile.js';

export interface DependencyPatch {
  manifest: 'package.json' | 'requirements.txt' | 'pyproject.toml';
  /** Dependencies to add (name → version range). */
  addDevDependencies: Record<string, string>;
  /** Scripts to add (name → command). */
  addScripts: Record<string, string>;
  /** Plain requirement lines (Python). */
  addRequirements: string[];
  notes: string[];
}

const JS_DEV_DEPS: Record<string, string> = {
  '@wdio/cli': '^9.0.0',
  '@wdio/local-runner': '^9.0.0',
  '@wdio/mocha-framework': '^9.0.0',
  '@wdio/appium-service': '^9.0.0',
  '@wdio/spec-reporter': '^9.0.0',
  appium: '^2.11.0',
};

export function computeDependencyPatch(profile: AutomationProjectProfile): DependencyPatch {
  if (profile.automationLanguage === 'python') {
    const reqs = ['Appium-Python-Client>=4.0.0', 'selenium>=4.20.0'];
    if (profile.testFramework === 'pytest') reqs.push('pytest>=8.0.0');
    return {
      manifest: profile.packageManager === 'poetry' ? 'pyproject.toml' : 'requirements.txt',
      addDevDependencies: {},
      addScripts: {},
      addRequirements: reqs,
      notes: [
        'Install with `pip install -r requirements.txt` (or your project package manager).',
        'A local Appium 2 server with the relevant driver (uiautomator2 / xcuitest) is required.',
      ],
    };
  }
  const devDeps = { ...JS_DEV_DEPS };
  if (profile.automationLanguage === 'typescript') {
    devDeps.typescript = '^5.7.0';
    devDeps.tsx = '^4.19.0';
    devDeps['@types/node'] = '^22.0.0';
  }
  return {
    manifest: 'package.json',
    addDevDependencies: devDeps,
    addScripts: { 'test:e2e': `wdio run ./wdio.conf.${profile.automationLanguage === 'typescript' ? 'ts' : 'js'}` },
    addRequirements: [],
    notes: [
      `Install with \`${installCmd(profile)}\`.`,
      'A local Appium 2 server with the relevant driver (uiautomator2 / xcuitest) is required.',
    ],
  };
}

function installCmd(profile: AutomationProjectProfile): string {
  switch (profile.packageManager) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    default:
      return 'npm install';
  }
}
