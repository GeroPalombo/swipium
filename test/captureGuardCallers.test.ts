// Every `.screenshot(` call in src/ goes through the capture guard (lib/captureGuard.ts) or is an
// allowlisted capture that never persists pixels. A new capture path that skips the guard fails here.
//
// The rule, per call (driver implementations in src/drivers/ are exempt):
//   - the line(s) right above carry `// capture-guard: <reason>`;
//   - a reason claiming the guard ("guarded ...", "checked ...", or naming the guard function) needs
//     a canCaptureScreenshot / captureGuardSync call within GUARD_WINDOW lines above the marker;
//   - "saved only after <guard>" (capture runs alongside the dump the guard reads) needs the guard
//     call within POST_GUARD_WINDOW lines below;
//   - any other reason (in-memory compare, own refusal) is only accepted in ALLOWLIST files, and
//     each file may have at most its pinned number of them.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** Files allowed an unguarded capture, why, and how many such captures each may have. Keep it short:
 *  raising a count means a new capture path that skips the guard, so it needs a reason. */
const ALLOWLIST: Record<string, { why: string; max: number }> = {
  'tools/act.ts': { why: 'pixel-change check before/after an action, compared in memory', max: 2 },
  'flows/run.ts': { why: 'template match / image diff, compared in memory', max: 3 },
  'tools/screenshot.ts': {
    why: 'qa_screenshot: shared secure rule with its own CAPTURE_WITHHELD_SECURE refusal and force:true',
    max: 1,
  },
  'tools/visual.ts': { why: 'qa_visual: shared secure rule with its own CAPTURE_WITHHELD_SECURE refusal and force:true', max: 1 },
  'snapshot/renderWait.ts': { why: 'visual-only render wait, two frames compared in memory', max: 1 },
};

/** How far above a "guarded" marker the guard call must be. Anywhere in the file proves nothing. */
const GUARD_WINDOW = 15;
/** A capture taken alongside the dump and saved only once the guard passed on that dump. */
const POST_GUARD_RE = /^saved only after\b/i;
const POST_GUARD_WINDOW = 80;

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
  const out: CaptureViolation[] = [];
  let unguarded = 0;
  lines.forEach((line, i) => {
    if (!line.includes('.screenshot(') || isCommentLine(line)) return;
    // The marker sits in the comment block right above the call.
    let reason: string | undefined;
    let markerAt = -1;
    for (let j = i - 1; j >= 0 && isCommentLine(lines[j]); j--) {
      const m = MARKER_RE.exec(lines[j]);
      if (m) {
        reason = m[1].trim();
        markerAt = j;
        break;
      }
    }
    const where = `src/${file}:${i + 1}`;
    if (!reason) out.push({ where, problem: 'no `// capture-guard: <reason>` comment above this capture' });
    else if (POST_GUARD_RE.test(reason)) {
      const later = lines.slice(i + 1, i + 1 + POST_GUARD_WINDOW).some((l) => GUARD_CALL_RE.test(l));
      if (!later)
        out.push({ where, problem: `marked "saved only after" the guard but no guard call within ${POST_GUARD_WINDOW} lines below` });
    } else if (GUARD_CLAIM_RE.test(reason)) {
      const near = lines.slice(Math.max(0, markerAt - GUARD_WINDOW), markerAt).some((l) => GUARD_CALL_RE.test(l));
      if (!near)
        out.push({
          where,
          problem: `marked guarded but no canCaptureScreenshot / captureGuardSync call within ${GUARD_WINDOW} lines above`,
        });
    } else if (!ALLOWLIST[file]) out.push({ where, problem: `unguarded capture ("${reason}") in a file not on the allowlist` });
    else if (++unguarded > ALLOWLIST[file].max)
      out.push({ where, problem: `more unguarded captures than the ${ALLOWLIST[file].max} pinned for this file ("${reason}")` });
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
    expect(captureViolations('x/new.ts', falseGuard)[0].problem).toMatch(/no canCaptureScreenshot/);
    const offList = '// capture-guard: in-memory compare only\nconst png = await d.screenshot();';
    expect(captureViolations('x/new.ts', offList)[0].problem).toMatch(/not on the allowlist/);
    expect(captureViolations('tools/act.ts', offList)).toEqual([]);
    const guarded =
      'const v = captureGuardSync(session, nodes);\n// why it is fine\n// capture-guard: guarded above\nconst png = await d.screenshot();';
    expect(captureViolations('x/new.ts', guarded)).toEqual([]);
    expect(captureViolations('x/new.ts', '// call driver.screenshot() here')).toEqual([]);
  });

  it('a guard call far above the "guarded" marker does not count', () => {
    const far = `const g = await canCaptureScreenshot(session, d);\n${'doOther();\n'.repeat(20)}// capture-guard: guarded above\nconst png = await d.screenshot();`;
    expect(captureViolations('x/new.ts', far)[0].problem).toMatch(/within 15 lines/);
  });

  it('a "saved only after" capture needs the guard call shortly below it', () => {
    const marker = '// capture-guard: saved only after captureGuardSync passes\nconst png = await d.screenshot();\n';
    expect(captureViolations('x/new.ts', `${marker}const g = captureGuardSync(session, nodes);`)).toEqual([]);
    expect(captureViolations('x/new.ts', `const g = captureGuardSync(session, nodes);\n${marker}`)[0].problem).toMatch(/lines below/);
  });

  it('an allowlisted file may not add unguarded captures past its pinned count', () => {
    const one = '// capture-guard: in-memory compare only\nconst png = await d.screenshot();\n';
    expect(captureViolations('snapshot/renderWait.ts', one)).toEqual([]);
    const two = captureViolations('snapshot/renderWait.ts', one + one);
    expect(two).toHaveLength(1);
    expect(two[0].problem).toMatch(/more unguarded captures than the 1 pinned/);
    expect(captureViolations('tools/act.ts', one + one)).toEqual([]);
    expect(captureViolations('tools/act.ts', one + one + one)).toHaveLength(1);
  });
});
