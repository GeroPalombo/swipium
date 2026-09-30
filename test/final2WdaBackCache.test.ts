// Item 3: iOS `press back` may reuse the last page source only briefly (≤ 3 s) and never after an
// out-of-WDA screen change on that simulator (simctl launch/terminate/openurl, app control).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  wdaSource: vi.fn(),
  tapWdaPoint: vi.fn(),
  wdaWindowSize: vi.fn(),
}));
vi.mock('../src/lib/wda.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wda.js')>();
  return { ...actual, ...m };
});
const simMock = vi.hoisted(() => ({ launchApp: vi.fn(), openUrl: vi.fn(), terminateApp: vi.fn() }));
vi.mock('../src/lib/simctl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/simctl.js')>();
  return { ...actual, ...simMock };
});

const { WdaDriver, WDA_BACK_SOURCE_FRESH_MS, invalidateWdaPageSource } = await import('../src/drivers/WdaDriver.js');
const { SimctlDriver } = await import('../src/drivers/SimctlDriver.js');

const source = (backX: number) =>
  `<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" label="App" x="0" y="0" width="393" height="852" enabled="true" visible="true">` +
  `<XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Details" x="0" y="50" width="393" height="44" enabled="true" visible="true">` +
  `<XCUIElementTypeButton type="XCUIElementTypeButton" name="Back" label="Back" x="${backX}" y="56" width="60" height="32" enabled="true" visible="true"/>` +
  `</XCUIElementTypeNavigationBar></XCUIElementTypeApplication>`;

const noopSim = { launchApp: vi.fn(), terminateApp: vi.fn(), openUrl: vi.fn(), simulatorLogs: vi.fn() };
const driver = (udid = 'SIM-1') => new WdaDriver('http://127.0.0.1:8100', { udid, sessionId: 'sess-1', simulator: noopSim });

beforeEach(() => {
  for (const f of [...Object.values(m), ...Object.values(simMock)]) f.mockReset();
  m.wdaSource.mockResolvedValueOnce(source(8)).mockResolvedValue(source(100)); // first dump, then the "new" screen
  m.tapWdaPoint.mockResolvedValue(undefined);
  m.wdaWindowSize.mockResolvedValue({ width: 393, height: 852 });
  simMock.launchApp.mockResolvedValue(undefined);
  simMock.openUrl.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('WDA press-back source reuse', () => {
  it('the reuse window is at most 3 s', () => {
    expect(WDA_BACK_SOURCE_FRESH_MS).toBeLessThanOrEqual(3_000);
  });

  it('a fresh (<3 s) cached source is still reused (no /source)', async () => {
    const d = driver();
    await d.dumpXml();
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(1);
    expect(m.tapWdaPoint).toHaveBeenLastCalledWith(expect.any(String), 'sess-1', 38, 72);
  });

  it('a source older than the window is not reused (the app may have navigated by itself)', async () => {
    const d = driver();
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await d.dumpXml();
    now.mockReturnValue(t0 + WDA_BACK_SOURCE_FRESH_MS + 500);
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(2);
    expect(m.tapWdaPoint).toHaveBeenLastCalledWith(expect.any(String), 'sess-1', 130, 72); // the NEW back button
  });

  it('invalidateWdaPageSource(udid) (qa_ios launch/terminate/openurl) drops the cached source', async () => {
    const d = driver();
    await d.dumpXml();
    invalidateWdaPageSource('SIM-1');
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(2);
    expect(m.tapWdaPoint).toHaveBeenLastCalledWith(expect.any(String), 'sess-1', 130, 72);
  });

  it('invalidating another simulator leaves this one’s cache alone', async () => {
    const d = driver();
    await d.dumpXml();
    invalidateWdaPageSource('SIM-OTHER');
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(1);
  });

  it('simctl app control through another driver instance on the same udid invalidates it', async () => {
    const d = driver();
    await d.dumpXml();
    await new SimctlDriver('SIM-1').launchApp('com.example.app');
    await d.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(2);

    const d2 = driver();
    m.wdaSource.mockResolvedValue(source(8));
    await d2.dumpXml();
    await driver().openUrl('myapp://deep'); // flow openUrl / qa_app_control path via a WdaDriver
    await d2.pressKey('back');
    expect(m.wdaSource).toHaveBeenCalledTimes(4);
  });
});
