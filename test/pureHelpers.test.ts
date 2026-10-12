// Pure / hermetic helpers that had no coverage:
//  - typed-text read-back (src/core/readBack.ts): Compose label suffix, hint, masks, truncation;
//  - DirectDriver long-text checks (fieldEndsWithTyped / fieldIsCutTyped);
//  - qa_flow_repair: opposite actions are never proposed, "Book now" is never auto-applied as "OK";
//  - test-suite case ids are one safe path component (no traversal), unsafe ids are re-allocated;
//  - projectRoot: one normalized spelling, broad system / user folders refused before any walk;
//  - init codex TOML sanity check;
//  - scan keeps a user-set appId but refreshes one an earlier scan wrote.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { textFieldReadings, typedReadBack, fieldReadBack } from '../src/core/readBack.js';
import { fieldEndsWithTyped, fieldIsCutTyped } from '../src/drivers/DirectDriver.js';
import { isAntonymPair, repairFlow } from '../src/flows/repair.js';
import { isSafeCaseId, emptySuite, validateCase } from '../src/testSuite/schema.js';
import { mergeCases } from '../src/testSuite/merge.js';
import { isBroadSystemDir, resolveProjectRoot } from '../src/context/projectRoot.js';
import { tomlSanityError } from '../src/cli/init.js';
import { keptConfigAppId, mergeScanIntoConfig } from '../src/cli/scan.js';
import type { SnapshotElement } from '../src/drivers/Driver.js';
import type { CanonicalTestCase } from '../src/testSuite/schema.js';
import type { ProjectScan } from '../src/context/scan.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

const field = (text: string, extra: Partial<{ cls: string; desc: string; hint: string }> = {}) => ({
  cls: extra.cls ?? 'android.widget.EditText',
  text,
  desc: extra.desc ?? '',
  attrs: extra.hint ? { hint: extra.hint } : {},
});

describe('read-back helpers', () => {
  it('textFieldReadings: hint-only is empty, ", <hint>" and a Compose ", <label>" suffix are dropped', () => {
    expect(textFieldReadings(field('Email', { hint: 'Email' }))).toEqual(['']);
    expect(textFieldReadings(field('Dora, First name', { hint: 'First name' }))[0]).toBe('Dora');
    expect(textFieldReadings(field('Dora, First name', { desc: 'Dora, First name' }))).toEqual(['Dora', 'Dora, First name']);
    // Not an EditText, or text != content-desc: kept as is.
    expect(textFieldReadings(field('a, b', { cls: 'android.widget.TextView', desc: 'a, b' }))).toEqual(['a, b']);
    expect(textFieldReadings(field('a, b'))).toEqual(['a, b']);
  });

  it('fieldReadBack picks the best reading and counts the value, not the label', () => {
    const compose = (t: string) => field(t, { desc: t });
    expect(fieldReadBack(compose('Dora, First name'), 'Dora', true)).toEqual({ verdict: 'match', valueLength: 4 });
    // A value that itself contains ", " still matches through the raw reading.
    expect(fieldReadBack(compose('Smith, John, Name'), 'Smith, John', true).verdict).toBe('match');
    expect(fieldReadBack(compose('Bobabc, Name'), 'Bob', true).verdict).toBe('mismatch');
  });

  it('typedReadBack: case/space match, masks and country codes reformatted, cut values truncated, leftovers mismatch', () => {
    expect(typedReadBack('Hello  World ', 'hello world', true)).toBe('match');
    expect(typedReadBack('(555) 123-4567', '5551234567', true)).toBe('reformatted');
    expect(typedReadBack('+1 555 1234', '5551234', true)).toBe('reformatted');
    expect(typedReadBack('12345', '1234567890', true)).toBe('truncated');
    expect(typedReadBack('old textnew', 'new', true)).toBe('mismatch');
    expect(typedReadBack('newold', 'new', true)).toBe('mismatch');
    expect(typedReadBack('', 'abc', true)).toBe('mismatch');
    // Append mode wants the text somewhere in the value.
    expect(typedReadBack('prefix abc', 'abc', false)).toBe('match');
  });

  it('fieldEndsWithTyped / fieldIsCutTyped (long text, masks, max length)', () => {
    expect(fieldEndsWithTyped('abc thanks', 'abc thanks ')).toBe(true);
    expect(fieldEndsWithTyped('ABC-DEF', 'abcdef')).toBe(true);
    expect(fieldEndsWithTyped('abc', 'abd')).toBe(false);
    expect(fieldIsCutTyped('hello', 'hello world')).toBe(true);
    expect(fieldIsCutTyped('help', 'hello world')).toBe(false);
  });
});

describe('qa_flow_repair antonym guard and medium-confidence containment', () => {
  const project = (flowYaml: string) => {
    const root = tmp('swipium-repair-r3-');
    mkdirSync(join(root, '.swipium', 'flows'), { recursive: true });
    writeFileSync(join(root, '.swipium', 'flows', 'f.yaml'), flowYaml);
    return root;
  };
  const btn = (text: string, i: number): SnapshotElement => ({
    ref: `@e${i}`,
    role: 'Button',
    text,
    bounds: [0, i * 50, 100, i * 50 + 40],
    clickable: true,
  });
  const repair = (selector: string, screen: string[], apply = false) => {
    const root = project(`name: f\nsteps:\n  - tap: "${selector}"\n`);
    const r = repairFlow({ root, flow: 'f', failedStep: 0, elements: screen.map(btn), platform: 'android', apply });
    if ('error' in r) throw new Error(r.error);
    return { r, s: r.suggestions[0], file: readFileSync(join(root, '.swipium', 'flows', 'f.yaml'), 'utf8') };
  };

  it('isAntonymPair: sign in/out, log in/out, on/off, lock/unlock; not renames', () => {
    expect(isAntonymPair('Sign out', 'Sign in')).toBe(true);
    expect(isAntonymPair('Log out', 'Log in')).toBe(true);
    expect(isAntonymPair('Turn on', 'Turn off')).toBe(true);
    expect(isAntonymPair('Lock', 'Unlock')).toBe(true);
    expect(isAntonymPair('Sign in', 'Log in')).toBe(false);
    expect(isAntonymPair('Submit', 'Submit order')).toBe(false);
  });

  it('an opposite action is never proposed', () => {
    expect(repair('Sign out', ['Sign in', 'Help']).s.replacementSelector).not.toBe('Sign in');
    expect(repair('Turn on', ['Turn off']).s.replacementSelector).toBeUndefined();
    expect(repair('Lock', ['Unlock']).s.replacementSelector).toBeUndefined();
  });

  it('"Book now" is not repaired to "OK" with medium confidence, and apply does not write it', () => {
    const { r, s, file } = repair('Book now', ['OK', 'Cancel'], true);
    expect(s.confidence).not.toBe('medium');
    expect(s.replacementSelector).not.toBe('OK');
    expect(r.applied).not.toBe(true);
    expect(file).toContain('Book now');
  });

  it('unrelated controls are not proposed; containment with extra words is a low proposal, never applied', () => {
    expect(repair('New message', ['Add contact']).s.replacementSelector).toBeUndefined();
    expect(repair('Battery settings', ['Search Settings']).s.replacementSelector).toBeUndefined();
    // "Submit order" adds a word, so it may be a different action: low, not applied.
    const { r, s: sub, file } = repair('Submit', ['Submit order', 'Cancel'], true);
    expect(sub).toMatchObject({ replacementSelector: 'Submit order', confidence: 'low' });
    expect(r.applied).not.toBe(true);
    expect(file).toContain('tap: "Submit"');
  });
});

describe('test-suite case ids are one safe path component (qa_suite_update)', () => {
  const tc = (id: string): CanonicalTestCase => ({
    schemaVersion: 1,
    id,
    featureId: 'login',
    functionality: 'Login',
    title: 'Login works',
    description: '',
    objective: 'log in',
    priority: 'P1',
    type: 'functional' as CanonicalTestCase['type'],
    creativityLevel: 'standard',
    platforms: ['android'],
    preconditions: [],
    fixtures: [],
    testData: [],
    steps: [],
    expectedResult: [],
    actualResult: { status: 'not_run' } as CanonicalTestCase['actualResult'],
    automation: { status: 'manual' } as CanonicalTestCase['automation'],
    status: 'active',
    risk: [],
    cleanup: [],
    mapLinks: [],
    ticketRefs: [],
    requirementRefs: [],
    evidence: [],
    history: [],
    tags: [],
    createdAt: '',
    updatedAt: '',
    provenance: [],
  });

  it('isSafeCaseId refuses traversal, separators and over-long ids', () => {
    expect(isSafeCaseId('TC-LOGIN-001')).toBe(true);
    expect(isSafeCaseId('../../../../tmp/x')).toBe(false);
    expect(isSafeCaseId('a/b')).toBe(false);
    expect(isSafeCaseId('.hidden')).toBe(false);
    expect(isSafeCaseId('x'.repeat(65))).toBe(false);
    expect(isSafeCaseId('')).toBe(false);
    expect(validateCase(tc('../x')).join(' ')).toMatch(/id/);
  });

  it('mergeCases never keeps an unsafe incoming id (allocates TC-...)', () => {
    const out = mergeCases(emptySuite('com.example'), [tc('../../../../tmp/x')], {
      mode: 'append',
      now: new Date().toISOString(),
      source: 'manual',
    } as never);
    expect(out.created).toHaveLength(1);
    expect(out.created[0]).toMatch(/^TC-/);
    expect(isSafeCaseId(out.created[0])).toBe(true);
  });
});

describe('projectRoot normalization and broad roots', () => {
  const server = { server: { getClientCapabilities: () => ({}), listRoots: async () => ({ roots: [] }) } } as unknown as McpServer;
  const opts = { env: {}, cwd: '/', home: '/nonexistent-home' };

  it('a trailing slash and ".." resolve to one spelling', async () => {
    const dir = tmp('swipium-root-r3-');
    mkdirSync(join(dir, 'sub'));
    expect(await resolveProjectRoot(server, `${dir}/`, opts)).toEqual({ root: dir, source: 'arg' });
    expect(await resolveProjectRoot(server, `${dir}/sub/..`, opts)).toEqual({ root: dir, source: 'arg' });
  });

  it('shared system and user folders are refused before any walk', async () => {
    const home = homedir();
    for (const p of ['/Applications', '/Users', '/tmp', '/Library', join(home, 'Library'), join(home, 'Downloads')]) {
      const t = Date.now();
      const r = await resolveProjectRoot(server, p, { ...opts, home });
      expect(r.source, p).toBe('none');
      expect(r.hint, p).toMatch(/not one app project|filesystem root or the home directory/);
      expect(Date.now() - t).toBeLessThan(1000);
    }
    expect(isBroadSystemDir('/Applications/')).toBe(true);
    expect(isBroadSystemDir(join(tmpdir(), 'my-app'))).toBe(false);
  });
});

describe('init codex TOML sanity check', () => {
  it('refuses the four malformed cases', () => {
    expect(tomlSanityError('a = nope\n')).not.toBeNull();
    expect(tomlSanityError('a = "\\q"\n')).not.toBeNull();
    expect(tomlSanityError('a.b = 1\n[a]\nb = 2\n')).not.toBeNull();
    expect(tomlSanityError('[[t]]\nx = 1\n[t]\ny = 2\n')).not.toBeNull();
  });

  it('accepts valid TOML (arrays of tables with sub-tables, dotted keys, dates, hex numbers, escapes)', () => {
    expect(tomlSanityError('[[arr]]\nx = 1\n[arr.sub]\ny = 2\n[[arr]]\nx = 2\n[arr.sub]\ny = 3\n')).toBeNull();
    expect(tomlSanityError('fruit.apple.color = "red"\n[fruit.apple.texture]\nsmooth = true\n')).toBeNull();
    expect(tomlSanityError('when = 1979-05-27 07:32:00Z\nn = 0xDEAD_BEEF\nf = 6.02e23\nok = false\n')).toBeNull();
    expect(
      tomlSanityError('s = "tab\\tquote\\" unicode \\u00e9"\n[mcp_servers.swipium]\ncommand = "npx"\nargs = ["-y", "swipium"]\n'),
    ).toBeNull();
  });
});

describe('scan appId refresh', () => {
  const scan = { appId: 'com.example.new', appIdSource: 'app.json' } as unknown as ProjectScan;

  it('refreshes an appId an earlier scan wrote, keeps one the user set', () => {
    expect(keptConfigAppId({ appId: 'com.example.old', appIdSource: 'app.json' }, scan)).toBeNull();
    expect(keptConfigAppId({ appId: 'com.example.old', appIdSource: 'gradle' }, scan)).toBeNull();
    expect(keptConfigAppId({ appId: 'com.custom' }, scan)).toBe('com.custom');
    expect(keptConfigAppId({ appId: 'com.custom', appIdSource: 'config.json' }, scan)).toBe('com.custom');
    expect(keptConfigAppId(null, scan)).toBeNull();
    expect(mergeScanIntoConfig({ appId: 'com.example.old', appIdSource: 'app.json' }, scan).appId).toBe('com.example.new');
    expect(mergeScanIntoConfig({ appId: 'com.custom' }, scan)).toMatchObject({ appId: 'com.custom', appIdSource: 'config.json' });
  });
});
