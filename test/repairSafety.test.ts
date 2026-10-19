// qa_flow_repair safety (pre-launch review):
//  - a renamed button ("Sign in" → "Log in") is repaired to the same-role, most-similar control,
//    never to an unrelated stable element such as the "Email" field;
//  - apply never writes at low confidence (applied:false + note);
//  - flow paths are confined to the project root (no absolute / ../ writes elsewhere).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairFlow, textSimilarity } from '../src/flows/repair.js';
import type { SnapshotElement } from '../src/drivers/Driver.js';

const dirs: string[] = [];
function project(flowYaml?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swipium-repair-')));
  dirs.push(root);
  mkdirSync(join(root, '.swipium', 'flows'), { recursive: true });
  if (flowYaml) writeFileSync(join(root, '.swipium', 'flows', 'login.yaml'), flowYaml);
  return root;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const LOGIN_FLOW = 'name: login\nsteps:\n  - inputText:\n      into: "Email"\n      text: "a@b.c"\n  - tap: "Sign in"\n';

const SCREEN: SnapshotElement[] = [
  { ref: '@e1', role: 'text-field', label: 'Email', id: 'com.example:id/email', bounds: [0, 0, 100, 40], clickable: true },
  { ref: '@e2', role: 'text-field', label: 'Password', id: 'com.example:id/password', bounds: [0, 50, 100, 90], clickable: true },
  { ref: '@e3', role: 'Button', text: 'Forgot password?', bounds: [0, 100, 100, 140], clickable: true },
  { ref: '@e4', role: 'Button', text: 'Log in', bounds: [0, 150, 100, 190], clickable: true },
];

describe('qa_flow_repair candidate choice', () => {
  it('a renamed button is repaired to the most similar button, not the Email field', () => {
    const root = project(LOGIN_FLOW);
    const r = repairFlow({ root, flow: 'login', failedStep: 1, elements: SCREEN, platform: 'android' });
    if ('error' in r) throw new Error(r.error);
    const s = r.suggestions[0];
    expect(s.replacementSelector).toBe('Log in');
    expect(s.replacementSelector).not.toContain('email');
    expect(s.confidence).toBe('low');
    expect(textSimilarity('Sign in', 'Log in')).toBeGreaterThan(textSimilarity('Sign in', 'Forgot password?'));
  });

  it('an inputText target is only repaired to a text field', () => {
    const root = project();
    const inline = repairFlow({
      root,
      flowYaml: 'name: f\nsteps:\n  - inputText:\n      into: "E-mail address"\n      text: "x"\n',
      failedStep: 0,
      elements: SCREEN.slice().reverse(),
      platform: 'android',
    });
    if ('error' in inline) throw new Error(inline.error);
    expect(inline.suggestions[0].replacementSelector?.toLowerCase()).toContain('email');
  });

  it('apply is refused at low confidence (applied:false + note, file untouched)', () => {
    const root = project(LOGIN_FLOW);
    const path = join(root, '.swipium', 'flows', 'login.yaml');
    const r = repairFlow({ root, flow: 'login', failedStep: 1, elements: SCREEN, platform: 'android', apply: true });
    if ('error' in r) throw new Error(r.error);
    expect(r.applied).toBe(false);
    expect(r.patched).toBe(false);
    expect(r.notes?.join(' ')).toMatch(/low confidence/);
    expect(r.proposedYaml).toContain('Log in');
    expect(readFileSync(path, 'utf8')).toBe(LOGIN_FLOW);
  });

  it('apply still writes at high confidence (exact match)', () => {
    const root = project('name: login\nsteps:\n  - tap: "log in"\n');
    const r = repairFlow({ root, flow: 'login', failedStep: 0, elements: SCREEN, platform: 'android', apply: true });
    if ('error' in r) throw new Error(r.error);
    expect(r.suggestions[0].confidence).toBe('high');
    expect(r.applied).toBe(true);
  });
});

describe('qa_flow_repair path confinement', () => {
  it('refuses an absolute flow path outside the project root and never writes it', () => {
    const root = project();
    const outside = project(LOGIN_FLOW);
    const victim = join(outside, '.swipium', 'flows', 'login.yaml');
    const r = repairFlow({ root, flow: victim, failedStep: 1, elements: SCREEN, apply: true });
    expect('error' in r && r.errorCode).toBe('UNSAFE_ACTION_REFUSED');
    expect(readFileSync(victim, 'utf8')).toBe(LOGIN_FLOW);
  });

  it('refuses a ../ escape', () => {
    const root = project();
    const r = repairFlow({ root, flow: '../../../../etc/hosts', failedStep: 0, elements: SCREEN });
    expect('error' in r && r.errorCode).toBe('UNSAFE_ACTION_REFUSED');
  });

  it('still accepts an absolute path inside the root', () => {
    const root = project(LOGIN_FLOW);
    const r = repairFlow({ root, flow: join(root, '.swipium', 'flows', 'login.yaml'), failedStep: 1, elements: SCREEN });
    expect('error' in r).toBe(false);
  });
});

describe('qa_flow_repair uses the qa_flow_run flow loader', () => {
  it('refuses a non-flow file such as .env without reading it', () => {
    const root = project();
    writeFileSync(join(root, '.env'), 'API_KEY=shh\n');
    // A path is refused for its extension; a bare name only looks under .swipium/flows.
    const byPath = repairFlow({ root, flow: './.env', failedStep: 0, elements: SCREEN });
    expect('error' in byPath && byPath.errorCode).toBe('UNSAFE_ACTION_REFUSED');
    const byName = repairFlow({ root, flow: '.env', failedStep: 0, elements: SCREEN });
    expect('error' in byName && byName.errorCode).toBe('FLOW_NOT_FOUND');
    for (const r of [byPath, byName]) expect('error' in r && r.error).not.toContain('shh');
  });

  it('a directory named like a flow is FLOW_NOT_FOUND, not an EISDIR crash', () => {
    const root = project();
    mkdirSync(join(root, '.swipium', 'flows', 'login.yaml'));
    const r = repairFlow({ root, flow: 'login', failedStep: 0, elements: SCREEN });
    expect('error' in r && r.errorCode).toBe('FLOW_NOT_FOUND');
  });

  it('a missing flow is FLOW_NOT_FOUND and an unparsable one INVALID_FLOW', () => {
    const root = project('name: login\nsteps:\n  - bogus: 1\n');
    const missing = repairFlow({ root, flow: 'nope', failedStep: 0, elements: SCREEN });
    expect('error' in missing && missing.errorCode).toBe('FLOW_NOT_FOUND');
    const invalid = repairFlow({ root, flow: 'login', failedStep: 0, elements: SCREEN });
    expect('error' in invalid && invalid.errorCode).toBe('INVALID_FLOW');
  });

  it('a failedStep outside the flow is INVALID_ARGUMENT', () => {
    const root = project(LOGIN_FLOW);
    const r = repairFlow({ root, flow: 'login', failedStep: 9, elements: SCREEN });
    expect('error' in r && r.errorCode).toBe('INVALID_ARGUMENT');
  });

  it('applying to a .json flow keeps the file JSON', () => {
    const root = project();
    const path = join(root, '.swipium', 'flows', 'login.json');
    writeFileSync(path, JSON.stringify({ name: 'login', steps: [{ tap: 'log in' }] }));
    const r = repairFlow({ root, flow: 'login', failedStep: 0, elements: SCREEN, platform: 'android', apply: true });
    if ('error' in r) throw new Error(r.error);
    expect(r.applied).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { steps: Array<{ tap: string }> };
    expect(written.steps[0].tap).toBe(r.suggestions[0].replacementSelector);
  });
});
