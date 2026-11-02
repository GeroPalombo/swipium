// Every `.screenshot(` call in src/ goes through the capture guard (lib/captureGuard.ts) or is an
// allowlisted capture that never persists pixels. A new capture path that skips the guard fails here.
//
// The rule, per call (driver implementations in src/drivers/ are exempt):
//   - the line(s) right above carry `// capture-guard: <reason>`;
//   - a reason claiming the guard ("guarded ...", "checked ...", or naming the guard function) needs
//     the file to call canCaptureScreenshot / captureGuardSync;
//   - any other reason (in-memory compare, own refusal) is only accepted in ALLOWLIST files.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** Files allowed an unguarded capture, and why. Keep this short. */
const ALLOWLIST: Record<string, string> = {
  'tools/act.ts': 'pixel-change check before/after an action, compared in memory',
  'flows/run.ts': 'template match / image diff, compared in memory',
  'tools/screenshot.ts': 'qa_screenshot: shared secure rule with its own CAPTURE_WITHHELD_SECURE refusal and force:true',
  'tools/visual.ts': 'qa_visual: shared secure rule with its own CAPTURE_WITHHELD_SECURE refusal and force:true',
  'snapshot/renderWait.ts': 'visual-only render wait, two frames compared in memory',
};

const GUARD_CALL_RE = /\b(canCaptureScreenshot|captureGuardSync)\(/;
const MARKER_RE = /\/\/\s*capture-guard:\s*(\S.*)$/;
const GUARD_CLAIM_RE = /^(guarded|checked)\b|canCaptureScreenshot|captureGuardSync/i;

export interface CaptureViolation {
  where: string;
  problem: string;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** The violations in one source file (`file` is relative to src/, with forward slashes). */
export function captureViolations(file: string, text: string): CaptureViolation[] {
  const lines = text.split('\n');
  const callsGuard = GUARD_CALL_RE.test(text);
  const out: CaptureViolation[] = [];
  lines.forEach((line, i) => {
    if (!line.includes('.screenshot(') || isCommentLine(line)) return;
    // The marker sits in the comment block right above the call.
    let reason: string | undefined;
    for (let j = i - 1; j >= 0 && isCommentLine(lines[j]); j--) {
      const m = MARKER_RE.exec(lines[j]);
      if (m) {
        reason = m[1].trim();
        break;
      }
    }
    const where = `src/${file}:${i + 1}`;
    if (!reason) out.push({ where, problem: 'no `// capture-guard: <reason>` comment above this capture' });
    else if (GUARD_CLAIM_RE.test(reason)) {
      if (!callsGuard) out.push({ where, problem: 'marked guarded but the file never calls canCaptureScreenshot / captureGuardSync' });
    } else if (!ALLOWLIST[file]) out.push({ where, problem: `unguarded capture ("${reason}") in a file not on the allowlist` });
  });
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    // iCloud duplicates ("foo 2.ts") are not part of the build.
    else if (e.name.endsWith('.ts') && !/ \d+\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('screenshot callers go through the capture guard', () => {
  it('every src/ capture outside the drivers is guarded or allowlisted', () => {
    const violations: CaptureViolation[] = [];
    for (const path of sourceFiles(SRC)) {
      const file = relative(SRC, path).split(sep).join('/');
      if (file.startsWith('drivers/')) continue;
      violations.push(...captureViolations(file, readFileSync(path, 'utf8')));
    }
    expect(violations.map((v) => `${v.where}: ${v.problem}`)).toEqual([]);
  });

  it('the scanner flags an unmarked capture, a false "guarded" claim and an off-list reason', () => {
    const unmarked = 'const png = await d.screenshot();';
    expect(captureViolations('x/new.ts', unmarked)).toHaveLength(1);
    const falseGuard = '// capture-guard: guarded by nothing\nconst png = await d.screenshot();';
    expect(captureViolations('x/new.ts', falseGuard)[0].problem).toMatch(/never calls/);
    const offList = '// capture-guard: in-memory compare only\nconst png = await d.screenshot();';
    expect(captureViolations('x/new.ts', offList)[0].problem).toMatch(/not on the allowlist/);
    expect(captureViolations('tools/act.ts', offList)).toEqual([]);
    const guarded =
      'const v = captureGuardSync(session, nodes);\n// why it is fine\n// capture-guard: guarded above\nconst png = await d.screenshot();';
    expect(captureViolations('x/new.ts', guarded)).toEqual([]);
    expect(captureViolations('x/new.ts', '// call driver.screenshot() here')).toEqual([]);
  });
});
