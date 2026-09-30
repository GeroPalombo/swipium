// Real-device smoke regression (A): a REGISTERED secret typed into a field the UI does NOT flag as
// secure was recorded as a literal and then written in plaintext into generated JS/Python tests,
// flow YAML, test-suite.json, TC-*.yaml and ~/.swipium/runs/.../state.json — while generation
// reported "secrets clean". Every generator must replace it with an env-var placeholder at emit
// time, the validator must check generated output against session.secrets, and the session store
// must never persist it.
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-secret-assets-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore } = await import('../src/session/store.js');
const { generateFlow } = await import('../src/flows/generate.js');
const { generatePom } = await import('../src/suite/pom.js');
const { generateTestCases } = await import('../src/suite/testcase.js');
const { caseFromPom } = await import('../src/testSuite/generator.js');
const { runFlowGenerate } = await import('../src/services/flowGenerate.js');
const { generateAndCompileSuite } = await import('../src/services/suiteGenerate.js');
const { assembleAutomationSuite } = await import('../src/services/automationGenerate.js');
const { runAutomationGenerate } = await import('../src/automationGen/run.js');
const { validateGeneratedSuite } = await import('../src/automationGen/validation.js');
const { secretSafeActions, findSecretLeaks, assertNoSecretLeaks, SecretLeakError } = await import('../src/suite/secretGuard.js');
type RecordedAction = import('../src/session/store.js').RecordedAction;

const SECRET = 'Zq7!sEcr3t#Pw';
const SCREEN = 'com.android.settings/.wifi.AddNetworkActivity';

const tmpRoots: string[] = [];
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'swipium-secret-assets-proj-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function act(a: Partial<RecordedAction> & { action: string }): RecordedAction {
  return { at: 0, exportability: 'semantic', screen: SCREEN, ...a } as RecordedAction;
}

/** The smoke recording: a secure password field (recorded correctly) + the SAME registered secret
 *  typed into a NON-secure field (`ssid`), recorded as a plain literal. */
function recording(): RecordedAction[] {
  return [
    act({ action: 'tap', selector: 'Add network', selectorKind: 'text' }),
    act({
      action: 'type',
      selector: 'password',
      selectorKind: 'resource_id',
      text: '${SECRET_1}',
      secret: true,
      exportability: 'needs-human-data',
    }),
    act({ action: 'type', selector: 'ssid', selectorKind: 'resource_id', text: SECRET }),
    act({ action: 'type', selector: 'note', selectorKind: 'resource_id', text: `wifi:${SECRET}` }), // contains the secret
    act({ action: 'type', selector: 'name', selectorKind: 'resource_id', text: 'Office' }),
  ];
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

function expectNoPlaintext(dir: string): string[] {
  const files = allFiles(dir);
  for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain(SECRET);
  return files;
}

describe('secretSafeActions (emit-time rewrite)', () => {
  it('turns a literal equal to / containing a registered secret into a needs-human-data secret step', () => {
    const { actions, converted } = secretSafeActions(recording(), [SECRET]);
    expect(converted).toBe(2);
    expect(actions[2]).toMatchObject({ action: 'type', secret: true, exportability: 'needs-human-data' });
    expect(actions[2].text).toBeUndefined();
    expect(actions[3]).toMatchObject({ secret: true, exportability: 'needs-human-data' });
    expect(actions[4].text).toBe('Office'); // non-secret literals untouched
    expect(actions[1].text).toBe('${SECRET_1}'); // existing placeholders kept
    expect(JSON.stringify(actions)).not.toContain(SECRET);
  });

  it('never mutates the input and is a no-op without secrets', () => {
    const input = recording();
    secretSafeActions(input, [SECRET]);
    expect(input[2].text).toBe(SECRET);
    expect(secretSafeActions(input, []).actions).toBe(input);
  });
});

describe('every generator replaces a registered secret with a placeholder', () => {
  it('flow YAML', () => {
    const gen = generateFlow(recording(), { name: 'wifi', appId: 'com.android.settings', secrets: [SECRET] });
    expect(gen.yaml).not.toContain(SECRET);
    expect(gen.yaml).toMatch(/text: \$\{SWIPIUM_SECRET_2\}/); // same naming as the POM/suite generator
    expect(gen.durability.needsHumanData).toBe(3);
  });

  it('POM files, test cases and the canonical (test-suite.json) case', () => {
    const pom = generatePom(recording(), { name: 'wifi', secrets: [SECRET] });
    for (const f of pom.files) expect(f.content, f.path).not.toContain(SECRET);
    expect(pom.steps.filter((s) => s.secret)).toHaveLength(3);
    const tc = generateTestCases(pom, {});
    expect(tc.yaml + tc.markdown).not.toContain(SECRET);
    const c = caseFromPom({ pom, now: new Date().toISOString(), source: 'generate' } as never);
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it('Appium JS and Python suites (assembled from a session) — and validation says secrets clean', () => {
    const store = new SessionStore();
    const s = store.create(projectRoot());
    s.secrets.add(SECRET);
    for (const a of recording()) store.addRecordedAction(s, a);
    for (const language of ['typescript', 'python'] as const) {
      const assembled = assembleAutomationSuite(s, { language, platform: 'android' });
      for (const f of assembled.files) expect(f.content, f.path).not.toContain(SECRET);
      const v = validateGeneratedSuite(assembled.files, { secrets: assembled.model.secrets, secretValues: s.secrets });
      expect(v.secretsClean).toBe(true);
      expect(assembled.model.secrets.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('written files and persisted state never contain the plaintext secret', () => {
  it('qa_generate flow / suite / appium + state.json', async () => {
    const root = projectRoot();
    const store = new SessionStore();
    const s = store.create(root);
    s.appId = 'com.android.settings';
    s.secrets.add(SECRET);
    for (const a of recording()) store.addRecordedAction(s, a);
    store.addNote(s, { at: Date.now(), workflow: 'join wifi', outcome: 'pass', reason: `typed ${SECRET} into ssid` });

    const flow = await runFlowGenerate(store, { sessionId: s.id, name: 'wifi', save: true });
    expect(flow.isError).toBeFalsy();
    const suite = generateAndCompileSuite(store, s, { name: 'wifi', save: true, compile: true });
    expect(suite.skipped).toBe(false);
    expect(suite.failureCode).toBeUndefined();
    const auto = await runAutomationGenerate({} as never, store, { sessionId: s.id, bootstrap: false, language: 'python', save: true });
    expect(auto.isError, JSON.stringify(auto.structuredContent).slice(0, 400)).toBeFalsy();
    expect((auto.structuredContent as { validation: { secretsClean: boolean } }).validation.secretsClean).toBe(true);

    const written = expectNoPlaintext(join(root, '.swipium'));
    expect(written.some((f) => f.endsWith('test-suite.json'))).toBe(true);
    expect(written.some((f) => /flows\/wifi\.yaml$/.test(f))).toBe(true);
    expect(written.some((f) => /automation\/python\/.*\.py$/.test(f))).toBe(true);

    store.flushAll();
    const state = readFileSync(join(s.dir, 'state.json'), 'utf8');
    expect(state).not.toContain(SECRET);
    const persisted = JSON.parse(state) as { recordedActions: RecordedAction[] };
    expect(persisted.recordedActions[2]).toMatchObject({ action: 'type', secret: true, exportability: 'needs-human-data' });
    // In-memory recording is unchanged (generators still rewrite at emit time).
    expect(s.recordedActions[2].text).toBe(SECRET);
  });
});

describe('the secrets scan checks output against session.secrets and fails loudly', () => {
  it('validateGeneratedSuite reports SECRET_IN_GENERATED_OUTPUT (comments included)', () => {
    const files = [
      { path: 'tests/test_smoke.py', content: `# typed ${SECRET}\nscreen.enter_ssid("x")\n` },
      { path: 'config/capabilities.js', content: "platformName: 'Android', 'appium:automationName': 'UiAutomator2'" },
    ];
    const v = validateGeneratedSuite(files, { secretValues: [SECRET] });
    expect(v.ok).toBe(false);
    expect(v.secretsClean).toBe(false);
    expect(v.findings.find((f) => f.code === 'SECRET_IN_GENERATED_OUTPUT')).toMatchObject({
      file: 'tests/test_smoke.py',
      severity: 'error',
    });
    // Encoded spellings (JSON / XML entities) are caught too.
    expect(findSecretLeaks([{ path: 'a.json', content: JSON.stringify({ t: 'P@ss"w&rd' }) }], ['P@ss"w&rd'])).toHaveLength(1);
    expect(() => assertNoSecretLeaks(files, [SECRET], 'unit')).toThrow(SecretLeakError);
  });
});
