// The shared capture guard itself: sensitive sessions, secure / clean trees in hand, a fresh cached
// tree, a stale cache that a structured backend re-dumps, a simulator that can't dump, a failed dump.

import { afterAll, describe, expect, it } from 'vitest';
import { CLEAN_SCREEN, SECURE_SCREEN, captureHarness, cleanupCaptureHarnesses } from './helpers/captureHarness.js';

const { canCaptureScreenshot, captureGuardSync } = await import('../src/lib/captureGuard.js');
const { parseSnapshot } = await import('../src/snapshot/parse.js');

afterAll(() => cleanupCaptureHarnesses());

const nodesOf = (xml: string) => parseSnapshot(xml).allNodes;
const SECURE_NOTE = { ok: false, reason: 'secure_field', note: 'screenshot withheld (secure field)' };
const SENSITIVE_NOTE = { ok: false, reason: 'sensitive', note: 'screenshot withheld (sensitive session)' };

describe('captureGuardSync', () => {
  it('a sensitive session is always withheld, even with a clean tree in hand', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN, sensitive: true });
    expect(captureGuardSync(h.session, nodesOf(CLEAN_SCREEN))).toEqual(SENSITIVE_NOTE);
  });

  it('secure nodes in hand withhold; clean nodes allow', async () => {
    const h = await captureHarness();
    expect(captureGuardSync(h.session, nodesOf(SECURE_SCREEN))).toEqual(SECURE_NOTE);
    expect(captureGuardSync(h.session, nodesOf(CLEAN_SCREEN))).toEqual({ ok: true });
  });

  it('nodes in hand win over the cached tree', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, cache: true });
    expect(captureGuardSync(h.session, nodesOf(CLEAN_SCREEN))).toEqual({ ok: true });
  });

  it('no nodes: a fresh cached secure tree withholds, a stale one is unknown (allowed), never a device call', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, cache: true });
    expect(captureGuardSync(h.session)).toEqual(SECURE_NOTE);
    h.sessions.bump(h.session, 'actions'); // an action since the dump: the cache is stale
    expect(captureGuardSync(h.session)).toEqual({ ok: true });
    expect(h.driver.got('dumpXml')).toHaveLength(0);
  });
});

describe('canCaptureScreenshot', () => {
  it('sensitive: withheld without touching the device', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN, sensitive: true });
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual(SENSITIVE_NOTE);
    expect(h.driver.got('dumpXml')).toHaveLength(0);
  });

  it('secure / clean nodes in hand decide with no dump', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN });
    expect(await canCaptureScreenshot(h.session, h.driver, { nodes: nodesOf(CLEAN_SCREEN) })).toEqual({ ok: true });
    expect(await canCaptureScreenshot(h.session, h.driver, { nodes: nodesOf(SECURE_SCREEN) })).toEqual(SECURE_NOTE);
    expect(h.driver.got('dumpXml')).toHaveLength(0);
  });

  it('a fresh cached tree decides with no dump', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN, cache: true });
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual({ ok: true });
    await h.show(SECURE_SCREEN, { cache: true });
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual(SECURE_NOTE);
    expect(h.driver.got('dumpXml')).toHaveLength(0);
  });

  it('a stale "clean" cache re-dumps once and catches the login screen now showing', async () => {
    const h = await captureHarness({ screen: CLEAN_SCREEN, cache: true });
    h.sessions.bump(h.session, 'actions');
    await h.show(SECURE_SCREEN);
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual(SECURE_NOTE);
    expect(h.driver.got('dumpXml')).toHaveLength(1);
    // The guard's dump never replaces the agent's snapshot (its @ref numbering).
    expect([...h.session.lastSnapshot!.fullByRef.values()].some((n) => n.attrs?.password === 'true')).toBe(false);
  });

  it('refresh:false skips the dump (stale cache reads as unknown: allowed)', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN });
    expect(await canCaptureScreenshot(h.session, h.driver, { refresh: false })).toEqual({ ok: true });
    expect(h.driver.got('dumpXml')).toHaveLength(0);
  });

  it('a simulator (no tree) never dumps and is allowed', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, kind: 'simulator' });
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual({ ok: true });
    expect(h.driver.got('dumpXml')).toHaveLength(0);
  });

  it('a WDA backend dumps like adb', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, kind: 'wda' });
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual(SECURE_NOTE);
  });

  it('a failed dump is unknown: allowed, never throws', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN });
    h.driver.dumpFails = true;
    expect(await canCaptureScreenshot(h.session, h.driver)).toEqual({ ok: true });
    expect(h.driver.got('dumpXml')).toHaveLength(1);
  });

  it('no driver: falls back to the sync rule', async () => {
    const h = await captureHarness({ screen: SECURE_SCREEN, cache: true });
    expect(await canCaptureScreenshot(h.session)).toEqual(SECURE_NOTE);
  });
});
