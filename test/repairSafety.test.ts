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
    expect('error' in r && r.errorCode).toBe('PATH_OUTSIDE_ROOT');
    expect(readFileSync(victim, 'utf8')).toBe(LOGIN_FLOW);
  });

  it('refuses a ../ escape', () => {
    const root = project();
    const r = repairFlow({ root, flow: '../../../../etc/hosts', failedStep: 0, elements: SCREEN });
    expect('error' in r && r.errorCode).toBe('PATH_OUTSIDE_ROOT');
  });

  it('still accepts an absolute path inside the root', () => {
    const root = project(LOGIN_FLOW);
    const r = repairFlow({ root, flow: join(root, '.swipium', 'flows', 'login.yaml'), failedStep: 1, elements: SCREEN });
    expect('error' in r).toBe(false);
  });
});
