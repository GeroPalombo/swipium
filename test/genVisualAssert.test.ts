// Real-device smoke regression (D): a qa_visual mode:"assert" step records free-form PROSE
// ("Settings home shows General row"). The POM mapped it to assertVisible.text, so every generated
// suite emitted assertTextVisible("Settings home shows General row") — a text check that can never
// pass. It must be a clearly-marked MANUAL visual checkpoint; only real text asserts become
// assertTextVisible.

import { describe, expect, it } from 'vitest';
import { generatePom, type PomResult } from '../src/suite/pom.js';
import { compileTest } from '../src/suite/compile.js';
import { generateTestCases } from '../src/suite/testcase.js';
import { caseFromPom } from '../src/testSuite/generator.js';
import { buildAppiumModel } from '../src/automationGen/appiumModel.js';
import { emitJsSuite } from '../src/automationGen/jsEmitter.js';
import { emitPythonSuite } from '../src/automationGen/pythonEmitter.js';
import type { RecordedAction } from '../src/session/store.js';
import { parse } from 'yaml';

const PROSE = 'Settings home shows General row';
const actions: RecordedAction[] = [
  { at: 0, action: 'tap', selector: 'General', selectorKind: 'text', exportability: 'semantic', screen: 'Settings' },
  { at: 1, action: 'assert_visual', assertion: PROSE, exportability: 'semantic', screen: 'Settings' },
];

const all = (files: Array<{ content: string }>) => files.map((f) => f.content).join('\n');

describe('visual assertion prose is a manual checkpoint, not a text assertion', () => {
  const pom = generatePom(actions, { name: 'settings' });
  const model = buildAppiumModel(pom, { platforms: { android: true, ios: true } });

  it('POM step is visualCheck (manual), never assertVisible', () => {
    const step = pom.steps.at(-1)!;
    expect(step).toMatchObject({ action: 'visualCheck', text: PROSE });
    expect(pom.steps.some((s) => s.action === 'assertVisible')).toBe(false);
    const test = pom.files.find((f) => f.path.startsWith('tests/'))!;
    expect(parse(test.content).steps.at(-1)).toMatchObject({ action: 'visualCheck', text: PROSE, manual: true });
  });

  it('JS/TS and Python emit a marked TODO comment, not assertTextVisible / assert_text_visible', () => {
    for (const files of [
      emitJsSuite({ model, profile: {} as never, language: 'javascript' }),
      emitJsSuite({ model, profile: {} as never, language: 'typescript' }),
      emitPythonSuite({ model, profile: {} as never, framework: 'pytest' }),
    ]) {
      const src = all(files.filter((f) => /test|e2e/i.test(f.path)));
      expect(src).toContain(`TODO(manual visual check, not automated): ${PROSE}`);
      expect(src).not.toContain(`assertTextVisible(${JSON.stringify(PROSE)})`);
      expect(src).not.toMatch(/assert_text_visible\(["']Settings home/);
    }
  });

  it('compiled Flow V2 uses the evidence-capturing assertVisual step; test cases say MANUAL', () => {
    const test = parse(pom.files.find((f) => f.path.startsWith('tests/'))!.content) as Record<string, unknown>;
    const pages = new Map(
      pom.files
        .filter((f) => f.path.startsWith('pages/'))
        .map((f) => {
          const d = parse(f.content) as { name: string };
          return [d.name, d as never];
        }),
    );
    const { flow, errors } = compileTest(test, pages);
    expect(errors).toEqual([]);
    const steps = flow.steps as Array<Record<string, unknown>>;
    expect(steps).toContainEqual({ assertVisual: PROSE });
    expect(steps.some((s) => typeof s === 'object' && 'assertVisible' in s && s.assertVisible === PROSE)).toBe(false);
    const tc = generateTestCases(pom, {});
    expect(tc.markdown).toContain(`MANUAL visual check on`);
    expect(tc.cases[0].expected.join(' ')).not.toContain(`${PROSE} is visible`);
    const c = caseFromPom({ pom, now: new Date().toISOString(), source: 'generate' } as never)!;
    expect(c.steps.at(-1)?.expected).toBe(`MANUAL visual check: ${PROSE}`);
  });

  it('a REAL text assertion still becomes assertTextVisible', () => {
    const textPom: PomResult = { ...pom, steps: [{ page: 'SettingsPage', action: 'assertVisible', text: 'General' }] };
    const m = buildAppiumModel(textPom, { platforms: { android: true, ios: true } });
    expect(all(emitJsSuite({ model: m, profile: {} as never, language: 'javascript' }))).toContain('assertTextVisible("General")');
    expect(all(emitPythonSuite({ model: m, profile: {} as never, framework: 'pytest' }))).toContain('assert_text_visible("General")');
  });
});
