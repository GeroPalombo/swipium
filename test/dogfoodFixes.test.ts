import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotElement } from '../src/drivers/Driver.js';
import type { RecordedAction } from '../src/session/store.js';
import { buildCodeIndex, fileMatchDimensions, scoreFile } from '../src/appMap/codeIndex.js';
import { actionLikeNonInteractive } from '../src/explore/candidates.js';
import { FAILURES, failureOwner, isSelfFixable } from '../src/oracle/failures.js';
import { generatePom } from '../src/suite/pom.js';

describe('dogfood regression fixes', () => {
  it('classifies unresolved build artifacts as a Swipium resolution issue', () => {
    const code = 'BUILD_ARTIFACT_UNRESOLVED_AFTER_SUCCESS';
    expect(FAILURES[code].summary).toMatch(/Build succeeded/);
    expect(FAILURES[code].recovery).toMatch(/not an app build failure/);
    expect(failureOwner(code)).toBe('swipium');
    expect(isSelfFixable(code)).toBe(true);
  });

  it('surfaces visible action-like text that is not exposed as interactive', () => {
    const elements: SnapshotElement[] = [
      { ref: '@e1', role: 'text', text: 'Continue with basic functions', bounds: [20, 840, 360, 870], clickable: false },
      { ref: '@e2', role: 'text', text: 'Ancient Wisdom for Modern Challenges', bounds: [20, 100, 360, 140], clickable: false },
      { ref: '@e3', role: 'button', text: 'Profile', bounds: [260, 820, 360, 870], clickable: true },
    ];

    expect(actionLikeNonInteractive(elements)).toEqual([
      {
        ref: '@e1',
        visibleText: 'Continue with basic functions',
        role: 'text',
        bounds: { x: 20, y: 840, w: 340, h: 30 },
        clickable: false,
      },
    ]);
  });

  it('indexes visible copy so app-map queries can match user-facing concepts', () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-code-index-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const file = join(root, 'src', 'HomeScreen.tsx');
      writeFileSync(file, `export function HomeScreen() { return <Text>Tap to unlock today's wisdom</Text>; }`);

      const index = buildCodeIndex(root, [file], '2026-06-01T00:00:00.000Z');
      expect(index.files).toHaveLength(1);
      expect(index.files[0].textTokens).toEqual(expect.arrayContaining(['unlock', 'today', 'wisdom']));
      expect(scoreFile(index.files[0], ['wisdom'])).toBeGreaterThan(0);
      expect(fileMatchDimensions(index.files[0], ['wisdom'])).toContain('visible_text');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('segments generated POM pages by recorded screen identity', () => {
    const actions: RecordedAction[] = [
      {
        at: 1,
        action: 'tap',
        selector: 'Create Account',
        selectorKind: 'text',
        exportability: 'semantic',
        screen: 'Sign up',
        screenSig: 'sig-signup',
      },
      {
        at: 2,
        action: 'tap',
        selector: 'Begin My Journey',
        selectorKind: 'text',
        exportability: 'semantic',
        screen: 'Onboarding',
        screenSig: 'sig-onboarding',
      },
      {
        at: 3,
        action: 'tap',
        x: 20,
        y: 20,
        selectorKind: 'coords',
        exportability: 'coordinate',
        screen: 'Paywall',
        screenSig: 'sig-paywall',
      },
    ];

    const pom = generatePom(actions, {
      name: 'dogfood flow',
      screenLabels: {
        'sig-signup': 'Signup',
        'sig-onboarding': 'Onboarding',
        'sig-paywall': 'Paywall',
      },
    });

    expect(pom.pages.map((p) => p.name)).toEqual(['SignupPage', 'OnboardingPage', 'PaywallPage']);
    expect(pom.steps.map((s) => s.page)).toEqual(['SignupPage', 'OnboardingPage', 'PaywallPage']);
    expect(pom.files.map((f) => f.path)).toEqual(expect.arrayContaining([
      'pages/signup-page.page.yaml',
      'pages/onboarding-page.page.yaml',
      'pages/paywall-page.page.yaml',
    ]));
  });
});
