// WdaDriver round-trip savings (item 6), lib/wda.js mocked — no WDA server:
//  - clearFocusedText + inputText share ONE focused-element lookup
//  - imeState() = one keyboard lookup (no separate "shown" query)
//  - screenSize() does not call /orientation on every call; a rotated page source drops the cache
//  - `press back` uses the latest post-settle source when nothing acted since (no fresh /source)

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFocusedWdaElement: vi.fn(),
  clearWdaElement: vi.fn(),
  typeWdaElement: vi.fn(),
  wdaOrientation: vi.fn(),
  wdaWindowSize: vi.fn(),
  wdaSource: vi.fn(),
  tapWdaPoint: vi.fn(),
  wdaKeyboardFrame: vi.fn(),
  wdaKeyboardShown: vi.fn(),
}));
vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return { ...actual, ...m };
});

const { WdaDriver } = await import('../src/drivers/WdaDriver.js');

const source = (w: number, h: number, withBack = true) =>
  `<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" label="App" x="0" y="0" width="${w}" height="${h}" enabled="true" visible="true">` +
  (withBack
    ? `<XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Details" x="0" y="50" width="${w}" height="44" enabled="true" visible="true">` +
      `<XCUIElementTypeButton type="XCUIElementTypeButton" name="Back" label="Back" x="8" y="56" width="60" height="32" enabled="true" visible="true"/>` +
      `</XCUIElementTypeNavigationBar>`
    : '') +
  `</XCUIElementTypeApplication>`;

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.findFocusedWdaElement.mockResolvedValue({ elementId: 'el-1' });
  m.clearWdaElement.mockResolvedValue(undefined);
  m.typeWdaElement.mockResolvedValue(undefined);
  m.wdaOrientation.mockResolvedValue('PORTRAIT');
  m.wdaWindowSize.mockResolvedValue({ width: 393, height: 852 });
  m.wdaSource.mockResolvedValue(source(393, 852));
  m.tapWdaPoint.mockResolvedValue(undefined);
  m.wdaKeyboardFrame.mockResolvedValue(null);
  m.wdaKeyboardShown.mockResolvedValue(false);
});

const driver = () => new WdaDriver('http://127.0.0.1:8100', { udid: 'SIM-1', sessionId: 'sess-1' });

describe('WdaDriver round trips', () => {
  it('replace-mode typing: one focused-element lookup for clear + type', async () => {
    const d = driver();
    await d.clearFocusedText(5);
    await d.inputText('hello');
    expect(m.findFocusedWdaElement).toHaveBeenCalledTimes(1);
    expect(m.typeWdaElement).toHaveBeenCalledWith(expect.any(String), 'sess-1', 'el-1', 'hello');
  });

  it('a stale reused element falls back to a fresh lookup', async () => {
    const d = driver();
    await d.clearFocusedText(5);
    m.typeWdaElement.mockRejectedValueOnce(new Error('stale element reference'));
    await d.inputText('hello');
    expect(m.findFocusedWdaElement).toHaveBeenCalledTimes(2);
    expect(m.typeWdaElement).toHaveBeenCalledTimes(2);
  });

  it('imeState: one keyboard lookup, no separate shown query', async () => {
    m.wdaKeyboardFrame.mockResolvedValue([0, 500, 393, 852]);
    expect(await driver().imeState()).toEqual({ shown: true, frame: [0, 500, 393, 852] });
    expect(m.wdaKeyboardFrame).toHaveBeenCalledTimes(1);
    expect(m.wdaKeyboardShown).not.toHaveBeenCalled();
  });

  it('screenSize: /orientation only on a miss; a rotated page source drops the cache', async () => {
    const d = driver();
    for (let i = 0; i < 4; i++) expect(await d.screenSize()).toEqual({ width: 393, height: 852 });
    expect(m.wdaOrientation).toHaveBeenCalledTimes(1);
    expect(m.wdaWindowSize).toHaveBeenCalledTimes(1);
    m.wdaSource.mockResolvedValue(source(852, 393));
    m.wdaOrientation.mockResolvedValue('LANDSCAPE');
    m.wdaWindowSize.mockResolvedValue({ width: 852, height: 393 });
    await d.dumpXml();
    expect(await d.screenSize()).toEqual({ width: 852, height: 393 });
  });

  it('press back reuses the latest post-settle source; after another action it fetches fresh', async () => {
    const d = driver();
    await d.dumpXml();
    expect(m.wdaSource).toHaveBeenCalledTimes(1);
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(1); // no fresh /source
    expect(m.tapWdaPoint).toHaveBeenLastCalledWith(expect.any(String), 'sess-1', 38, 72);
    expect(d.lastBackVia).toBe('nav_button');
    // the back tap itself invalidated the cached source → the next back fetches /source
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(2);
  });
});
