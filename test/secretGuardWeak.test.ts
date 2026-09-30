// Pre-launch finding (HIGH): the secret guard substring-matched every registered secret ≥4 chars in
// every string field and every generated line. Common QA passwords ("test", "password", "admin",
// "Login") then (a) failed POM generation with SECRET_IN_GENERATED_OUTPUT on template text
// ("testID", "tests:", "tests/x.smoke.yaml"), (b) rewrote a resource_id "password" selector to
// «redacted» (unusable locator) — and persisted it to state.json — and (c) rewrote `screen` fields.
// Also (P1): an email given via qa_continue_from_blocker (SWIPIUM_TEST_EMAIL) typed raw was written
// as a literal into generated tests/flows, and flow vs suite generators named the same password
// differently (SECRET_1 vs SWIPIUM_TEST_PASSWORD).
// Hermetic: HOME points at a temp dir BEFORE the store module is loaded.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-secret-weak-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';

const { SessionStore, serializeSecretSafe } = await import('../src/session/store.js');
const { generateFlow } = await import('../src/flows/generate.js');
const { generatePom } = await import('../src/suite/pom.js');
const { generateTestCases } = await import('../src/suite/testcase.js');
const { runFlowGenerate } = await import('../src/services/flowGenerate.js');
const { generateAndCompileSuite } = await import('../src/services/suiteGenerate.js');
const { secretSafeActions, findSecretLeaks, structuralLiterals, isWeakSecret, generatedOutputRedactor } =
  await import('../src/suite/secretGuard.js');
type RecordedAction = import('../src/session/store.js').RecordedAction;

const tmpRoots: string[] = [];
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'swipium-secret-weak-proj-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  tmpRoots.push(root);
  return root;
}
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function act(a: Partial<RecordedAction> & { action: string }): RecordedAction {
  return { at: 0, exportability: 'semantic', screen: 'Login', ...a } as RecordedAction;
}

/** A login recording on a screen titled "Login" with resource ids "email" / "password". */
function loginRecording(email = 'qa@example.com'): RecordedAction[] {
  return [
    act({ action: 'tap', selector: 'email', selectorKind: 'resource_id' }),
    act({ action: 'type', selector: 'email', selectorKind: 'resource_id', text: email }),
    act({ action: 'type', selector: 'password', selectorKind: 'resource_id', secret: true, exportability: 'needs-human-data' }),
    act({ action: 'tap', selector: 'Sign in', selectorKind: 'text' }),
    act({ action: 'assert_visual', assertion: 'Welcome back' }),
  ];
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

describe('weak (dictionary-like) secrets', () => {
  it('classifies weak vs strong', () => {
    for (const w of ['test', 'password', 'admin', 'demo', 'Login', 'abc123']) expect(isWeakSecret(w), w).toBe(true);
    for (const s of ['Zq7!sEcr3t#Pw', 'P@ssw0rd', 'secret12345']) expect(isWeakSecret(s), s).toBe(false);
  });

  it('secret "test": POM/suite generation does not fail on template text (testID, tests:, tests/x.smoke.yaml)', () => {
    const pom = generatePom(loginRecording(), { name: 'x', secrets: ['test'] });
    const tc = generateTestCases(pom, {});
    const files = [
      ...pom.files,
      { path: 'testcases/x.cases.yaml', content: tc.yaml },
      { path: 'testcases/x.cases.md', content: tc.markdown },
    ];
    expect(findSecretLeaks(files, ['test'], { structural: structuralLiterals(loginRecording()) })).toEqual([]);
    // Template text alone never matches a weak secret.
    expect(
      findSecretLeaks([{ path: 'a.yaml', content: 'testID: x\ntests:\n  - tests/x.smoke.yaml\n"test": "vitest run"' }], ['test']),
    ).toEqual([]);
  });

  it('secret "password": the resource_id "password" selector is kept (never «redacted») and persisted intact', () => {
    const { actions } = secretSafeActions(loginRecording(), ['password']);
    expect(actions[2].selector).toBe('password');
    const persisted = serializeSecretSafe({
      secrets: new Set(['password']),
      recordedActions: loginRecording(),
      notes: [],
      findings: [],
      toolErrors: [],
    });
    expect(persisted.recordedActions[2].selector).toBe('password');
    expect(JSON.stringify(persisted.recordedActions)).not.toContain('«redacted»');
    const pom = generatePom(loginRecording(), { name: 'x', secrets: ['password'] });
    expect(findSecretLeaks(pom.files, ['password'], { structural: structuralLiterals(loginRecording()) })).toEqual([]);
    expect(pom.pages.flatMap((p) => p.elements.map((e) => e.selector))).toContain('password');
  });

  it('secret "Login": `screen` fields are not rewritten', () => {
    const { actions } = secretSafeActions(loginRecording(), ['Login']);
    expect(actions.every((a) => a.screen === 'Login')).toBe(true);
    const flow = generateFlow(loginRecording(), { name: 'x', secrets: ['Login'] });
    expect(
      findSecretLeaks([{ path: 'x.yaml', content: flow.yaml }], ['Login'], { structural: structuralLiterals(loginRecording()) }),
    ).toEqual([]);
  });

  it('a weak secret actually TYPED as text still never appears in the output', () => {
    const rec = [...loginRecording(), act({ action: 'type', selector: 'note', selectorKind: 'resource_id', text: 'admin' })];
    const flow = generateFlow(rec, { name: 'x', secrets: ['admin'] });
    expect(flow.yaml).not.toMatch(/text: admin\b/);
    const pom = generatePom(rec, { name: 'x', secrets: ['admin'] });
    for (const f of pom.files) expect(f.content, f.path).not.toMatch(/["' ]admin["'\n]/);
    // …and the scan still catches a weak secret emitted as a data literal.
    expect(findSecretLeaks([{ path: 't.js', content: "await page.type('admin');" }], ['admin'])).toHaveLength(1);
    expect(findSecretLeaks([{ path: 't.yaml', content: '    text: admin' }], ['admin'])).toHaveLength(1);
  });

  it('generatedOutputRedactor: whole-value weak match only, structural values kept, strong still substring', () => {
    const r = generatedOutputRedactor(['password', 'Zq7!sEcr3t#Pw'], ['password']);
    expect(r('password')).toBe('password'); // selector — structural
    expect(r('Enter your password')).toBe('Enter your password');
    expect(r('x Zq7!sEcr3t#Pw y')).toBe('x «redacted» y');
    expect(generatedOutputRedactor(['admin'])('admin')).toBe('«redacted»');
  });
});

describe('stored session inputs become placeholders; one naming rule across generators', () => {
  it('flow and suite name the password the same and template the provided email', async () => {
    const root = projectRoot();
    const store = new SessionStore();
    const s = store.create(root);
    s.appId = 'com.example.app';
    store.setInput(s, 'SWIPIUM_TEST_EMAIL', 'qa@example.com', false, 'needs_input:credentials');
    store.setInput(s, 'SWIPIUM_TEST_PASSWORD', 'Hunter2!pw', true, 'needs_input:credentials');
    for (const a of loginRecording()) store.addRecordedAction(s, a);

    const flow = await runFlowGenerate(store, { sessionId: s.id, name: 'login', save: true });
    expect(flow.isError).toBeFalsy();
    const vars = (flow.structuredContent as { variables: string[] }).variables;
    expect(vars).toContain('SWIPIUM_TEST_PASSWORD');
    expect(vars).toContain('SWIPIUM_TEST_EMAIL');
    expect(vars.some((v) => /^SECRET_\d+$/.test(v))).toBe(false);

    const suite = generateAndCompileSuite(store, s, { name: 'login', save: true, compile: true });
    expect(suite.skipped).toBe(false);
    expect(suite.variables).toContain('SWIPIUM_TEST_PASSWORD');
    expect(suite.variables).toContain('SWIPIUM_TEST_EMAIL');

    const written = allFiles(join(root, '.swipium'));
    expect(written.length).toBeGreaterThan(3);
    for (const f of written) {
      const c = readFileSync(f, 'utf8');
      expect(c, f).not.toContain('qa@example.com');
      expect(c, f).not.toContain('Hunter2!pw');
    }
    expect(readFileSync(join(root, '.swipium', 'flows', 'login.yaml'), 'utf8')).toContain('${SWIPIUM_TEST_EMAIL}');
  });

  it('generation time: recorded raw email → ${SWIPIUM_TEST_EMAIL} in flow and POM (recordings made before the input was stored)', () => {
    const inputs = [
      { varName: 'SWIPIUM_TEST_EMAIL', value: 'qa@example.com', secret: false },
      { varName: 'SWIPIUM_TEST_PASSWORD', value: 'Hunter2!pw', secret: true },
    ];
    const flow = generateFlow(loginRecording(), { name: 'x', secrets: ['Hunter2!pw'], inputs });
    expect(flow.yaml).not.toContain('qa@example.com');
    expect(flow.yaml).toContain('text: ${SWIPIUM_TEST_EMAIL}');
    expect(flow.variables).toEqual(expect.arrayContaining(['SWIPIUM_TEST_EMAIL', 'SWIPIUM_TEST_PASSWORD']));
    const pom = generatePom(loginRecording(), { name: 'x', secrets: ['Hunter2!pw'], inputs });
    for (const f of pom.files) expect(f.content, f.path).not.toContain('qa@example.com');
    expect(pom.variables).toEqual(expect.arrayContaining(['SWIPIUM_TEST_EMAIL', 'SWIPIUM_TEST_PASSWORD']));
  });

  it('the store records a typed stored-input value as its placeholder (state.json never holds the email)', () => {
    const store = new SessionStore();
    const s = store.create(projectRoot());
    store.setInput(s, 'SWIPIUM_TEST_EMAIL', 'qa@example.com', false, 'needs_input:credentials');
    store.addRecordedAction(s, loginRecording()[1]);
    expect(s.recordedActions[0].text).toBe('${SWIPIUM_TEST_EMAIL}');
    store.flushAll();
    expect(readFileSync(join(s.dir, 'state.json'), 'utf8')).not.toContain('qa@example.com');
  });

  it('a literal that is NOT a stored input value is left as typed', () => {
    const { actions } = secretSafeActions(
      loginRecording('someone@else.com'),
      [],
      [{ varName: 'SWIPIUM_TEST_EMAIL', value: 'qa@example.com', secret: false }],
    );
    expect(actions[1].text).toBe('someone@else.com');
  });
});
