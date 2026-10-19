// WdaDriver typing fallbacks retype only after an error that proves nothing was typed (a stale or
// missing element). A timeout or dropped connection mid-typing may have delivered the text, so it
// is rethrown instead of typing the same text again through another path. lib/wda.js mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFocusedWdaElement: vi.fn(),
  clearWdaElement: vi.fn(),
  typeWdaElement: vi.fn(),
  typeWdaKeys: vi.fn(),
  wdaActiveAppInfo: vi.fn(),
}));
vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return { ...actual, ...m };
});

const { WdaDriver, wdaTypeFailedBeforeTyping } = await import('../src/drivers/WdaDriver.js');
const { WdaHttpError } = await import('../src/lib/wda.js');
const { runWithSignal } = await import('../src/lib/abortScope.js');

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.findFocusedWdaElement.mockResolvedValue({ elementId: 'el-1' });
  m.clearWdaElement.mockResolvedValue(undefined);
  m.typeWdaElement.mockResolvedValue(undefined);
  m.typeWdaKeys.mockResolvedValue(undefined);
});

const driver = () => new WdaDriver('http://127.0.0.1:8100', { udid: 'SIM-1', sessionId: 'sess-1' });
const typedTimes = () => m.typeWdaElement.mock.calls.length + m.typeWdaKeys.mock.calls.length;

describe('wdaTypeFailedBeforeTyping', () => {
  it('accepts only errors WDA raises before sending a key', () => {
    expect(wdaTypeFailedBeforeTyping(new WdaHttpError(404, 'no such element', '{}'))).toBe(true);
    expect(wdaTypeFailedBeforeTyping(new WdaHttpError(400, 'stale element reference', '{}'))).toBe(true);
    expect(wdaTypeFailedBeforeTyping(new Error('stale element reference'))).toBe(true);
    expect(wdaTypeFailedBeforeTyping(new Error('WDA POST /session/s/element/e/value timed out after 15000ms'))).toBe(false);
    expect(wdaTypeFailedBeforeTyping(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))).toBe(false);
    expect(wdaTypeFailedBeforeTyping(new WdaHttpError(500, 'Internal error', '{}'))).toBe(false);
  });
});

describe('WdaDriver.inputText fallbacks', () => {
  it('a typing timeout on the reused element is rethrown, never typed again', async () => {
    const d = driver();
    await d.clearFocusedText(5);
    m.typeWdaElement.mockRejectedValueOnce(new Error('WDA POST /session/sess-1/element/el-1/value timed out after 15000ms'));
    await expect(d.inputText('hello')).rejects.toThrow(/timed out/);
    expect(typedTimes()).toBe(1);
  });

  it('a dropped connection while typing into the focused element does not fall back to /wda/keys', async () => {
    m.typeWdaElement.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(driver().inputText('hello')).rejects.toThrow(/fetch failed/);
    expect(m.typeWdaKeys).not.toHaveBeenCalled();
  });

  it('a stale focused element still falls back to /wda/keys', async () => {
    m.typeWdaElement.mockRejectedValueOnce(new WdaHttpError(404, 'stale element reference', '{}'));
    await driver().inputText('hello');
    expect(m.typeWdaKeys).toHaveBeenCalledWith(expect.any(String), 'sess-1', 'hello');
  });

  it('a failed focused-element lookup (nothing typed) still falls back to /wda/keys', async () => {
    m.findFocusedWdaElement.mockRejectedValueOnce(new Error('No keyboard-focused element found'));
    await driver().inputText('hello');
    expect(m.typeWdaElement).not.toHaveBeenCalled();
    expect(m.typeWdaKeys).toHaveBeenCalledTimes(1);
  });
});

describe('WdaDriver.foregroundOwner retry', () => {
  it('a cancel during the retry pause unwinds at once instead of retrying', async () => {
    m.wdaActiveAppInfo.mockRejectedValue(new Error('WDA busy'));
    const ac = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ac.signal, () => driver().foregroundOwner());
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'CancelledError' });
    expect(Date.now() - started).toBeLessThan(250);
    expect(m.wdaActiveAppInfo).toHaveBeenCalledTimes(1);
  });
});
