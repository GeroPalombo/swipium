// Issue-ledger integrity (1.6.0-RC §4): lock-guarded writes, stale-cache detection across
// processes, unique temp files, suppressedUntil enforcement + unsuppress, typed mark_fixed
// guard, and pinned report-bridge fingerprints (existing ledgers must keep matching).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, hasIdentitySignal } from '../src/issues/fingerprint.js';
import { markFixed, markSuppressed, markUnsuppressed, queryIssues, recordObservation, verifyFixed } from '../src/issues/index.js';
import { foldRunIntoLedger } from '../src/issues/reportBridge.js';
import { appendEvents, getIndex, issuesDir, issuesIndexPath, loadIndex, readEvents } from '../src/issues/store.js';
import { ISSUE_SCHEMA_VERSION, type IssueEvent } from '../src/issues/schema.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swipium-ledger-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-02T10:00:00.000Z';
const T2 = '2026-09-03T10:00:00.000Z';
const T3 = '2026-09-04T10:00:00.000Z';

const obs = (title: string) => ({ title, summary: title, visibleText: title });

describe('report-bridge fingerprints are unchanged (existing ledgers keep matching)', () => {
  it('pins the fingerprint of a bridge finding and a bridge note', () => {
    // Values computed by the 1.5.0 fingerprint code for the shapes reportBridge produces.
    const finding = fingerprint({
      failureCode: 'NATIVE_CRASH',
      platform: 'android',
      appId: 'com.example',
      observation: {
        title: 'crash on Login',
        summary: 'x',
        failureCode: 'NATIVE_CRASH',
        screenPurpose: 'Login',
        visibleText: 'FATAL EXCEPTION main',
      },
    });
    const note = fingerprint({
      platform: 'ios',
      appId: 'com.example',
      observation: { title: 'checkout → fail', summary: 'x', workflow: 'checkout', visibleText: 'Total shows NaN' },
    });
    // sha256 of the 1.5.0 token strings — recomputed by hand, independent of the implementation.
    expect(finding).toBe('sha256:0844cceead82f9df5c931f107a275512');
    expect(note).toBe('sha256:f4b241d60abb0c6c640376e35fa3d319');
  });

  it('the bridge path does not add a category token', () => {
    foldRunIntoLedger(root, [], [{ workflow: 'checkout', outcome: 'fail', category: 'app_bug', reason: 'Total shows NaN' }], T0, {
      appId: 'com.example',
      platform: 'ios',
    });
    const ev = readEvents(root)[0];
    expect(ev.fingerprint).toBe(
      fingerprint({
        platform: 'ios',
        appId: 'com.example',
        observation: { title: '', summary: '', workflow: 'checkout', screenPurpose: undefined, visibleText: 'Total shows NaN' },
      }),
    );
  });
});

describe('hasIdentitySignal', () => {
  it('rejects scope-only and id-only tokens, accepts a real title', () => {
    expect(hasIdentitySignal(['cat:app_bug', 'plat:android'])).toBe(false);
    expect(hasIdentitySignal(['plat:android', 'text::id :id'])).toBe(false);
    expect(hasIdentitySignal(['plat:android', 'text:login button unresponsive'])).toBe(true);
    expect(hasIdentitySignal(['code:redbox'])).toBe(true);
  });
});

describe('ledger integrity', () => {
  it('rebuilds a cached index that another process made stale by appending to the log', () => {
    const a = recordObservation(root, obs('Login button unresponsive'), T0);
    expect(loadIndex(root)?.records).toHaveLength(1);
    // Simulate a second server instance: it appends an event but its index write never lands here.
    const foreign: IssueEvent = {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      eventId: 'evt_foreign',
      issueId: a.issueId,
      fingerprint: a.fingerprint,
      eventType: 'fixed',
      createdAt: T1,
      lifecycle: { state: 'fixed', fixedAt: T1, fixedInCommit: 'abc123' },
    };
    appendEvents(root, [foreign]);
    expect(loadIndex(root)).toBeNull(); // stamp mismatch → not trusted
    expect(getIndex(root, T1).records[0].state).toBe('fixed');
    // …so the next observation is correctly a regression, not "observed again".
    const again = recordObservation(root, obs('Login button unresponsive'), T2);
    expect(again.reopened).toBe(true);
    expect(again.recurrenceMessage).toContain('abc123');
  });

  it('leaves no lock directory or temp files behind', () => {
    recordObservation(root, obs('Profile avatar blank'), T0);
    const r = recordObservation(root, obs('Checkout total shows NaN'), T0);
    markFixed(root, { issueId: r.issueId }, { fixedInCommit: 'c1' }, T1);
    const leftovers = readdirSync(issuesDir(root)).filter((f) => f !== 'index.json');
    expect(leftovers).toEqual([]);
    expect(existsSync(issuesIndexPath(root))).toBe(true);
    const idx = JSON.parse(readFileSync(issuesIndexPath(root), 'utf8'));
    expect(typeof idx.logSize).toBe('number');
  });

  it('mark_fixed is refused (typed) unless the issue is active', () => {
    const r = recordObservation(root, obs('Settings toggle ignored'), T0);
    expect(markFixed(root, { issueId: r.issueId }, {}, T1).ok).toBe(true);
    const again = markFixed(root, { issueId: r.issueId }, {}, T2);
    expect(again).toMatchObject({ ok: false, code: 'ISSUE_STATE_INVALID' });
    expect(markFixed(root, { issueId: 'iss_nope' }, {}, T2)).toMatchObject({ ok: false, code: 'ISSUE_NOT_FOUND' });
    const s = recordObservation(root, obs('Analytics banner flickers'), T0);
    markSuppressed(root, { issueId: s.issueId }, { suppressionReason: 'known' }, T1);
    expect(markFixed(root, { issueId: s.issueId }, {}, T2)).toMatchObject({ ok: false, code: 'ISSUE_STATE_INVALID' });
    expect(verifyFixed(root, { issueId: s.issueId }, { testCaseId: 't' }, T2)).toMatchObject({ ok: false, code: 'ISSUE_STATE_INVALID' });
  });

  it('suppressedUntil expires: the issue returns to its prior lane in history and on the next observation', () => {
    const r = recordObservation(root, obs('Push permission prompt twice'), T0);
    markSuppressed(root, { issueId: r.issueId }, { suppressionReason: 'OS bug', suppressedUntil: T2 }, T0);
    expect(queryIssues(root, T1).records).toHaveLength(0); // hidden while active
    const after = queryIssues(root, T3).records;
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe('open');
    expect(after[0].suppressedUntil).toBeUndefined();
    const seen = recordObservation(root, obs('Push permission prompt twice'), T3);
    expect(seen.record.state).toBe('observed_again');
    // Durable: a rebuild from the log agrees.
    rmSync(issuesIndexPath(root));
    expect(getIndex(root, T3).records[0].state).toBe('observed_again');
  });

  it('an expired suppression of a fixed issue still reports the regression', () => {
    const r = recordObservation(root, obs('Deep link opens blank screen'), T0);
    markFixed(root, { issueId: r.issueId }, { fixedInCommit: 'f00d' }, T0);
    markSuppressed(root, { issueId: r.issueId }, { suppressedUntil: T1 }, T0);
    const again = recordObservation(root, obs('Deep link opens blank screen'), T2);
    expect(again.reopened).toBe(true);
    expect(again.record.state).toBe('reopened');
  });

  it('unsuppress lifts a suppression early and restores the prior state', () => {
    const r = recordObservation(root, obs('Toast overlaps tab bar'), T0);
    recordObservation(root, obs('Toast overlaps tab bar'), T0); // observed_again
    markSuppressed(root, { issueId: r.issueId }, { suppressionReason: 'cosmetic' }, T1);
    const res = markUnsuppressed(root, { issueId: r.issueId }, T2);
    expect(res.ok).toBe(true);
    expect(res.record?.state).toBe('observed_again');
    expect(res.record?.suppressionReason).toBeUndefined();
    expect(markUnsuppressed(root, { issueId: r.issueId }, T3)).toMatchObject({ ok: false, code: 'ISSUE_STATE_INVALID' });
    rmSync(issuesIndexPath(root));
    expect(getIndex(root, T3).records[0].state).toBe('observed_again');
  });
});
