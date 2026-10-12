// Pure / hermetic helpers:
//  - third-party / OS sign-in detection, the iOS alert cancel picker, generated flows skipping
//    sign-in taps;
//  - init codex TOML check: real Codex headers accepted, unpaired / duplicate headers refused;
//  - scan keeps a hand-edited appId (scanAppId), a corrupt projects.json is moved aside;
//  - test-suite ids: unsafe / duplicate stored ids are renamed on load, never exported;
//  - qa_flow_repair: negations are opposites, containment with extra words is never applied;
//  - foldText, DEVICE_UNRESPONSIVE mapping, Compose label strip only for the known label;
//  - simulator pin / device-name resolution;
//  - loading-screen heuristic: a weak caption counts only when it is the whole screen.
// Hermetic: HOME is a temp dir (test/setupFakeHome.ts), no device, no adb / xcrun.

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isThirdPartySignIn, classifyRisk } from '../src/explore/policy.js';
import { iosAlertCancel } from '../src/snapshot/overlays.js';
import { generateFlow } from '../src/flows/generate.js';
import { tomlSanityError } from '../src/cli/init.js';
import { keptConfigAppId, mergeScanIntoConfig, replacedScanAppId } from '../src/cli/scan.js';
import { registryPath, rememberProject, reloadRegistry } from '../src/appMap/projectRegistry.js';
import { loadSuiteChecked, suiteJsonPath } from '../src/testSuite/store.js';
import { exportYamlFiles } from '../src/testSuite/exporter.js';
import { isSafeCaseId } from '../src/testSuite/schema.js';
import { isAntonymPair, repairFlow } from '../src/flows/repair.js';
import { foldText, resolveTarget } from '../src/core/target.js';
import { classifyFlowDriverError } from '../src/flows/run.js';
import { launchFailureCode } from '../src/services/prepareAndroid.js';
import { composeLabelOf, fieldReadBack, textFieldReadings } from '../src/core/readBack.js';
import { simulatorsForPin } from '../src/session/attach.js';
import { resolveSimulatorArg } from '../src/tools/ios.js';
import { waitForAppRender } from '../src/snapshot/renderWait.js';
import { FakeDriver, dump } from './actFixFake.js';
import { SessionStore } from '../src/session/store.js';
import type { RawNode } from '../src/snapshot/parse.js';
import type { Driver, SnapshotElement } from '../src/drivers/Driver.js';
import type { ProjectScan } from '../src/context/scan.js';
import type { RecordedAction } from '../src/session/store.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

describe('third-party / OS sign-in', () => {
  it("isThirdPartySignIn: provider sign-in labels and ids, not the app's own sign-in", () => {
    for (const label of [
      'Sign up with Apple',
      'Sign in with Apple',
      'Continue with Google',
      'Log in with Facebook',
      'Sign in using GitHub',
    ])
      expect(isThirdPartySignIn({ label }), label).toBe(true);
    for (const id of ['social-signin.apple-button', 'google_sign_in', 'loginWithApple', 'appleAuth'])
      expect(isThirdPartySignIn({ id }), id).toBe(true);
    for (const label of ['Sign in with Email', 'Sign In', 'Settings', 'Continue', 'Apple Music'])
      expect(isThirdPartySignIn({ label }), label).toBe(false);
    expect(isThirdPartySignIn({ id: 'apple-music-tab' })).toBe(false);
    expect(isThirdPartySignIn({ id: 'sign_in_button' })).toBe(false);
  });

  it('classifyRisk never calls a third-party sign-in safe', () => {
    expect(classifyRisk({ label: 'Continue with Google', role: 'Button' }).risk).not.toBe('safe');
  });

  const node = (dfs: number, cls: string, text: string, subtreeEnd = dfs, bounds: RawNode['bounds'] = [0, 0, 100, 40]): RawNode => ({
    cls,
    text,
    desc: '',
    id: '',
    bounds,
    clickable: /Button/.test(cls),
    longClickable: false,
    scrollable: false,
    focusable: false,
    focused: false,
    enabled: true,
    isLeaf: subtreeEnd === dfs,
    attrs: {},
    dfs,
    subtreeEnd,
    drawingOrder: -1,
  });
  const alertTree = (...buttons: string[]): RawNode[] => [
    node(0, 'XCUIElementTypeApplication', 'App', 3 + buttons.length),
    node(1, 'XCUIElementTypeButton', 'Sign up with Apple', 1, [20, 600, 380, 650]),
    node(2, 'XCUIElementTypeAlert', 'Sign in to your Apple Account', 2 + buttons.length, [40, 300, 360, 500]),
    ...buttons.map((b, i) => node(3 + i, 'XCUIElementTypeButton', b, 3 + i, [40 + i * 160, 450, 200 + i * 160, 500])),
  ];

  it('iosAlertCancel picks the cancel side, OK only on a single-button alert, null without an alert', () => {
    const closeVsSettings = iosAlertCancel(alertTree('Settings', 'Close'));
    expect(closeVsSettings?.title).toBe('Sign in to your Apple Account');
    expect(closeVsSettings?.cancel).toEqual({ label: 'Close', x: 280, y: 475 });
    expect(iosAlertCancel(alertTree('Don’t Allow', 'Allow'))?.cancel?.label).toBe('Don’t Allow');
    expect(iosAlertCancel(alertTree('OK'))?.cancel?.label).toBe('OK');
    // Two buttons, no cancel-style one: the alert is reported without a cancel.
    const noCancel = iosAlertCancel(alertTree('Settings', 'OK'));
    expect(noCancel).not.toBeNull();
    expect(noCancel?.cancel).toBeUndefined();
    expect(iosAlertCancel(alertTree().filter((n) => n.cls !== 'XCUIElementTypeAlert'))).toBeNull();
  });

  it('generateFlow leaves recorded taps on a third-party sign-in out and says so', () => {
    const tap = (selector: string, selectorKind: RecordedAction['selectorKind'], at: number): RecordedAction => ({
      at,
      action: 'tap',
      selector,
      selectorKind,
      exportability: 'semantic',
    });
    const r = generateFlow([tap('social-signin.apple-button', 'accessibility_id', 1), tap('Sign In', 'text', 2)], {
      name: 'signin',
      appId: 'com.example.app',
    });
    expect(r.yaml).not.toMatch(/tap: .*social-signin/);
    expect(r.yaml).toMatch(/# left out: tap\(s\) on a third-party \/ OS sign-in \(social-signin\.apple-button\)/);
    expect(r.yaml).toContain('Sign In');
  });
});

describe('init codex TOML check accepts real Codex configs', () => {
  it('accepts quoted table names with /, @, :, non-ASCII and dotted quoted segments', () => {
    const real =
      'model = "o3"\n' +
      '[projects."/Users/gp/Desktop/app"]\ntrust_level = "trusted"\n' +
      '[plugins."documents@openai-primary-runtime"]\nenabled = true\n' +
      '[mcp_servers."a@b".env]\n"K:1" = "x"\n' +
      '["ключ"]\nx = 1\n' +
      '[a."b.c".\'d\']\ny = 2\n';
    expect(tomlSanityError(real)).toBeNull();
    expect(tomlSanityError("[projects.'/literal path']\na = 1\n")).toBeNull();
    expect(tomlSanityError('[projects."~/code:proj#1"] # comment\na = 1\n')).toBeNull();
    expect(tomlSanityError('[ a . "b" ]\nx = 1\n')).toBeNull();
    // A quoted segment with a dot is ONE segment: [a."b.c"] and [a.b.c] are different tables.
    expect(tomlSanityError('[a."b.c"]\nx = 1\n[a.b.c]\ny = 2\n')).toBeNull();
  });

  it('refuses unpaired brackets, an unterminated quoted name and a duplicate quoted header', () => {
    expect(tomlSanityError('[a]]\nx = 1\n')).not.toBeNull();
    expect(tomlSanityError('[[a]\nx = 1\n')).not.toBeNull();
    expect(tomlSanityError('[projects."/x]\nx = 1\n')).not.toBeNull();
    expect(tomlSanityError('[projects."/x"]\na = 1\n[projects."/x"]\nb = 2\n')).not.toBeNull();
    expect(tomlSanityError('[a."b"]\nx = 1\n[a.b]\ny = 2\n')).not.toBeNull();
    expect(tomlSanityError('[ключ]\nx = 1\n')).not.toBeNull();
    expect(tomlSanityError('[]\n')).not.toBeNull();
  });
});

describe('scan appId and projects.json', () => {
  const scan = { appId: 'com.example.new', appIdSource: 'app.json' } as unknown as ProjectScan;

  it('a hand-edited appId is kept even with the scan appIdSource left in place', () => {
    expect(keptConfigAppId({ appId: 'com.hand', appIdSource: 'app.json', scanAppId: 'com.example.old' }, scan)).toBe('com.hand');
    expect(keptConfigAppId({ appId: 'com.example.old', appIdSource: 'app.json', scanAppId: 'com.example.old' }, scan)).toBeNull();
    expect(replacedScanAppId({ appId: 'com.example.old', appIdSource: 'app.json' }, scan)).toBe('com.example.old');
    expect(replacedScanAppId({ appId: 'com.hand', appIdSource: 'app.json', scanAppId: 'com.example.old' }, scan)).toBeNull();
    expect(mergeScanIntoConfig(null, scan).scanAppId).toBe('com.example.new');
  });

  it('a corrupt projects.json is moved aside (projects.json.corrupt-<ms>), not silently replaced', () => {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'garbage{');
    reloadRegistry();
    rememberProject(tmp('swipium-r4-registry-'));
    const backups = readdirSync(dirname(path)).filter((f) => f.startsWith('projects.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(path), backups[0]), 'utf8')).toBe('garbage{');
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });
});

describe('test-suite ids from disk', () => {
  it('loadSuiteChecked renames unsafe and duplicate ids, repairs hand-written cases, and export never writes them', () => {
    const root = tmp('swipium-r4-suite-');
    mkdirSync(dirname(suiteJsonPath(root)), { recursive: true });
    const hand = (id: unknown) => ({ id, functionality: 'Login', title: 'Login works', objective: 'log in', steps: ['open app'] });
    writeFileSync(
      suiteJsonPath(root),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        cases: [hand('../../../../x'), hand('TC-LOGIN-001'), hand('TC-LOGIN-001'), hand(42)],
        retiredIds: ['../y'],
      }),
    );
    const { suite, repairs } = loadSuiteChecked(root);
    const ids = suite.cases.map((c) => c.id);
    expect(ids.every(isSafeCaseId)).toBe(true);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain('TC-LOGIN-001');
    expect(repairs).toHaveLength(3);
    expect(repairs.join('\n')).toMatch(/"\.\.\/\.\.\/\.\.\/\.\.\/x" is not a safe file name/);
    expect(repairs.join('\n')).toMatch(/is a duplicate/);
    expect(suite.retiredIds).toEqual([]);
    // Hand-written cases get the canonical shape (featureId, steps as objects, actualResult).
    expect(suite.cases[0].featureId).toBeTruthy();
    expect(suite.cases[0].steps[0]).toMatchObject({ action: 'open app', index: 1 });
    expect(suite.cases[0].actualResult).toBeTruthy();
    for (const f of exportYamlFiles(suite)) expect(f.path).not.toContain('..');
  });

  it('exportYamlFiles skips a case whose id is not a safe file name', () => {
    const root = tmp('swipium-r4-suite2-');
    mkdirSync(dirname(suiteJsonPath(root)), { recursive: true });
    writeFileSync(
      suiteJsonPath(root),
      JSON.stringify({ schemaVersion: 1, cases: [{ id: 'TC-LOGIN-001', functionality: 'Login', title: 't', steps: [] }] }),
    );
    const { suite } = loadSuiteChecked(root);
    suite.cases.push({ ...suite.cases[0], id: '../../escape' });
    expect(exportYamlFiles(suite).map((f) => f.path)).toEqual([expect.stringMatching(/\/TC-LOGIN-001\.yaml$/)]);
  });
});

describe('qa_flow_repair: negations and containment', () => {
  const btn = (text: string, i: number): SnapshotElement => ({
    ref: `@e${i}`,
    role: 'Button',
    text,
    bounds: [0, i * 50, 100, i * 50 + 40],
    clickable: true,
  });
  const repair = (selector: string, screen: string[], apply = false) => {
    const root = tmp('swipium-r4-repair-');
    mkdirSync(join(root, '.swipium', 'flows'), { recursive: true });
    writeFileSync(join(root, '.swipium', 'flows', 'f.yaml'), `name: f\nsteps:\n  - tap: "${selector}"\n`);
    const r = repairFlow({ root, flow: 'f', failedStep: 0, elements: screen.map(btn), platform: 'android', apply });
    if ('error' in r) throw new Error(r.error);
    return { r, s: r.suggestions[0], file: readFileSync(join(root, '.swipium', 'flows', 'f.yaml'), 'utf8') };
  };

  it('a negation is an opposite: "Allow" is never repaired to "Don\'t allow" (straight or curly) or "Do not allow"', () => {
    expect(isAntonymPair("Don't allow", 'Allow')).toBe(true);
    expect(isAntonymPair('Don’t allow', 'Allow')).toBe(true);
    expect(isAntonymPair('Do not allow', 'Allow')).toBe(true);
    for (const other of ["Don't allow", 'Don’t allow', 'Do not allow']) {
      const { r, s, file } = repair('Allow', [other, 'Settings'], true);
      expect(s?.replacementSelector, other).toBeUndefined();
      expect(r.applied).not.toBe(true);
      expect(file).toContain('tap: "Allow"');
    }
  });

  it('containment with extra words is a low proposal, never applied; same words up to plural stay medium and apply', () => {
    const del = repair('Delete', ['Delete account', 'Cancel'], true);
    expect(del.s).toMatchObject({ replacementSelector: 'Delete account', confidence: 'low' });
    expect(del.r.applied).not.toBe(true);
    expect(del.file).toContain('tap: "Delete"');
    expect(del.file).not.toContain('Delete account');

    const plural = repair('Notification', ['Notifications', 'Cancel'], true);
    expect(plural.s).toMatchObject({ replacementSelector: 'Notifications', confidence: 'medium' });
    expect(plural.r.applied).toBe(true);
    expect(plural.file).toContain('Notifications');

    expect(repair('Settings', ['Search Settings']).s?.replacementSelector).toBeUndefined();
  });
});

describe('selector text and driver error mapping', () => {
  it('foldText folds curly quotes and apostrophes and lower-cases', () => {
    expect(foldText('Don’t Allow')).toBe("don't allow");
    expect(foldText('ʼquoteʼ “x” ‘y’')).toBe("'quote' \"x\" 'y'");
    expect(foldText("Don't allow")).toBe(foldText('Don’t allow'));
  });

  it('a straight-apostrophe text target finds the curly-apostrophe button', async () => {
    const session = new SessionStore().create(tmp('swipium-r4-fold-'));
    session.driver = new FakeDriver(
      dump([
        { text: 'Don’t Allow', bounds: [40, 200, 1040, 280] },
        { text: 'Allow', bounds: [40, 400, 1040, 480] },
      ]),
    );
    expect(await resolveTarget(session, { text: "Don't allow" })).toMatchObject({ x: 540, y: 240 });
  });

  it('an adb timeout is DEVICE_UNRESPONSIVE, not WDA_UNREACHABLE', () => {
    expect(classifyFlowDriverError(new Error('`adb -s emulator-5554 shell input text x` exited null (timed out): '))).toBe(
      'DEVICE_UNRESPONSIVE',
    );
    expect(classifyFlowDriverError(new Error('DEVICE_UNRESPONSIVE: uiautomator dump got no answer within 20 s'))).toBe(
      'DEVICE_UNRESPONSIVE',
    );
    expect(launchFailureCode(new Error('`adb -s emulator-5554 shell monkey -p x 1` exited null (timed out): '))).toBe(
      'DEVICE_UNRESPONSIVE',
    );
    expect(launchFailureCode(new Error('monkey aborted'))).toBe('APP_LAUNCH_FAILED');
  });
});

describe('Compose label strip only for the known label', () => {
  const field = (text: string, desc = text) => ({ cls: 'android.widget.EditText', text, desc, attrs: {} });

  it('composeLabelOf reads the label from the field before typing', () => {
    expect(composeLabelOf(field('Last name'))).toBe('Last name');
    expect(composeLabelOf(field('Ann, First name'))).toBe('First name');
    expect(composeLabelOf(field('', 'Email'))).toBe('Email');
    expect(composeLabelOf(field('typed', 'Email'))).toBeNull();
    expect(composeLabelOf(field('Jo', ''))).toBeUndefined();
    expect(composeLabelOf(undefined)).toBeUndefined();
  });

  it('with a known label only ", <label>" is stripped; leftover text after ", " is a mismatch', () => {
    expect(fieldReadBack(field('Smith, Name'), 'Smith', true, 'Name').verdict).toBe('match');
    expect(fieldReadBack(field('Smith, Jo'), 'Smith', true, 'Name').verdict).toBe('mismatch');
    // Unknown label: the old heuristic (any last ", " part) still applies.
    expect(fieldReadBack(field('Smith, Jo'), 'Smith', true).verdict).toBe('match');
    // No Compose label (null): the raw text only.
    expect(textFieldReadings(field('Smith, Jo'), null)).toEqual(['Smith, Jo']);
    // The bare label = an empty labeled field.
    expect(textFieldReadings(field('Name'), 'Name')[0]).toBe('');
  });
});

describe('simulator pin and device-name resolution', () => {
  const sims = [
    { udid: 'AAAAAAAA-0000-4000-8000-000000000001', name: 'iPhone 16', state: 'Booted', runtime: 'iOS 18.0' },
    { udid: 'AAAAAAAA-0000-4000-8000-000000000002', name: 'iPhone SE (3rd generation)', state: 'Shutdown', runtime: 'iOS 18.0' },
    { udid: 'AAAAAAAA-0000-4000-8000-000000000003', name: 'iPhone 16 Pro', state: 'Shutdown', runtime: 'iOS 18.0' },
  ];

  it('simulatorsForPin: UDID or exact name ignoring case; a shared name is ambiguous', () => {
    expect(simulatorsForPin('iphone 16', sims).map((s) => s.udid)).toEqual([sims[0].udid]);
    expect(simulatorsForPin(sims[1].udid.toLowerCase(), sims).map((s) => s.udid)).toEqual([sims[1].udid]);
    expect(simulatorsForPin('iPhone', sims)).toEqual([]);
    expect(simulatorsForPin('iPhone 16', [...sims, { ...sims[0], udid: 'AAAAAAAA-0000-4000-8000-000000000009' }])).toHaveLength(2);
  });

  it('resolveSimulatorArg: a listed UDID or a unique exact name (ignoring case); substring / ambiguous / unknown refused', async () => {
    expect(await resolveSimulatorArg(sims[2].udid.toLowerCase(), sims)).toMatchObject({ udid: sims[2].udid });
    expect(await resolveSimulatorArg('iPhone 16', sims)).toMatchObject({ udid: sims[0].udid });
    expect(await resolveSimulatorArg('iphone se (3rd generation)', sims)).toMatchObject({ udid: sims[1].udid });
    const substring = await resolveSimulatorArg('iphone se', sims);
    expect('error' in substring && JSON.stringify(substring.error)).toMatch(/INVALID_ARGUMENT/);
    const ambiguous = await resolveSimulatorArg('iPhone 16', [...sims, { ...sims[0], udid: 'AAAAAAAA-0000-4000-8000-000000000009' }]);
    expect('error' in ambiguous && JSON.stringify(ambiguous.error)).toMatch(/MULTIPLE_DEVICES/);
    const unlisted = await resolveSimulatorArg('AAAAAAAA-0000-4000-8000-0000000000FF', sims);
    expect('error' in unlisted && JSON.stringify(unlisted.error)).toMatch(/INVALID_ARGUMENT/);
    const unknown = await resolveSimulatorArg('Pixel', sims);
    expect('error' in unknown && JSON.stringify(unknown.error)).toMatch(/INVALID_ARGUMENT/);
  });
});

describe('loading-screen heuristic', () => {
  const driverFor = (xml: string) => ({ kind: 'direct', dumpXml: async () => xml }) as unknown as Driver;
  const text = (t: string, y: number) => ({
    cls: 'android.widget.TextView',
    text: t,
    bounds: [40, y, 1040, y + 60] as [number, number, number, number],
    clickable: false,
  });
  const button = (t: string, y: number) => ({ text: t, bounds: [40, y, 1040, y + 80] as [number, number, number, number] });
  const wait = (xml: string) => waitForAppRender(driverFor(xml), { timeoutMs: 400, pollMs: 100 });

  it('a weak caption alone is a loading screen (not ready)', async () => {
    const r = await wait(dump([text('Looking for your plane in the sky…', 900)]));
    expect(r.ready).toBe(false);
    expect(r.loadingText).toMatch(/Looking for your plane/);
  });

  it('a weak caption with other text or a control is a real screen (ready)', async () => {
    expect((await wait(dump([text('Looking for nearby devices…', 900), text('Pair your watch', 200)]))).ready).toBe(true);
    expect((await wait(dump([text('Fetching your rides…', 900), button('Cancel', 1500)]))).ready).toBe(true);
  });

  it('a strong caption ("Loading…") with up to 2 controls is still loading', async () => {
    const r = await wait(dump([text('Loading…', 900), button('Skip', 1500), button('Cancel', 1600)]));
    expect(r.ready).toBe(false);
    expect(r.loadingText).toBe('Loading…');
  });
});

// Keep the fake-HOME registry tidy for later files in the same worker.
afterAll(() => {
  if (existsSync(registryPath())) rmSync(registryPath(), { force: true });
  reloadRegistry();
});
