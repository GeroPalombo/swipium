// 2.3.0 P4 visibility heuristic (sources without `visible`), shapes taken from real iOS 18.4
// simulator sources (iPhone SE, 375x667): keyboard with an accessory bar, tab bar, and window
// layers (alert, sheet) over the app content.
import { describe, expect, it } from 'vitest';
import { normalizeWdaSource } from '../src/lib/wda.js';

const el = (type: string, label: string, x: number, y: number, w: number, h: number, inner = '') =>
  `<XCUIElementType${type} type="XCUIElementType${type}" name="${label}" label="${label}" enabled="true" x="${x}" y="${y}" width="${w}" height="${h}">${inner}</XCUIElementType${type}>`;
const app = (inner: string) =>
  `<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="375" height="667">${inner}</XCUIElementTypeApplication>`;
const clickable = (xml: string) =>
  Object.fromEntries(
    [...normalizeWdaSource(xml).matchAll(/content-desc="(\w+)"[^>]*? clickable="(\w+)"/g)].map((m) => [m[1], m[2] === 'true']),
  );

describe('P4 visibility heuristic without `visible`', () => {
  it('the keyboard hides rows under it; its own keys, an accessory toolbar and rows above stay tappable', () => {
    const src = app(
      el(
        'Window',
        'Main',
        0,
        0,
        375,
        667,
        el('Cell', 'Above', 0, 380, 375, 44) + el('Cell', 'UnderKeyboard', 0, 532, 375, 44) + el('Cell', 'UnderAccessory', 0, 410, 375, 30),
      ) +
        el(
          'Window',
          'Keys',
          0,
          0,
          375,
          667,
          el('Toolbar', 'Accessory', 0, 407, 375, 44, el('Button', 'Done', 300, 407, 60, 44)) +
            el('Keyboard', 'Keyboard', 0, 451, 375, 216, el('Button', 'shift', 0, 566, 48, 46) + el('Button', 'Return', 281, 620, 94, 46)),
        ),
    );
    expect(clickable(src)).toMatchObject({
      Above: true,
      UnderKeyboard: false,
      UnderAccessory: false,
      Done: true,
      shift: true,
      Return: true,
    });
  });

  it('a tab bar and its buttons stay tappable; a row under the tab bar is not', () => {
    const src = app(
      el(
        'Window',
        'Main',
        0,
        0,
        375,
        667,
        el('Cell', 'Row', 0, 300, 375, 44) +
          el('Cell', 'UnderTabs', 0, 620, 375, 44) +
          el('TabBar', 'Tabs', 0, 618, 375, 49, el('Button', 'Recents', 0, 619, 125, 48) + el('Button', 'Browse', 250, 619, 125, 48)),
      ),
    );
    expect(clickable(src)).toMatchObject({ Row: true, UnderTabs: false, Tabs: true, Recents: true, Browse: true });
  });

  it('a later layer of the window (alert, sheet) hides the content behind it, bar buttons included', () => {
    const background = el(
      'Other',
      'Content',
      0,
      0,
      375,
      667,
      el('NavigationBar', 'Nav', 0, 20, 375, 44, el('Button', 'Lists', 0, 20, 76, 44)) + el('Cell', 'Row', 0, 300, 375, 44),
    );
    const alert = app(
      el(
        'Window',
        'Main',
        0,
        0,
        375,
        667,
        background +
          el(
            'Other',
            'Layer',
            0,
            0,
            375,
            667,
            el('Other', 'Dim', 0, 0, 375, 667) + el('Alert', 'Alert', 52, 224, 271, 239, el('Button', 'NotNow', 52, 419, 271, 44)),
          ),
      ),
    );
    expect(clickable(alert)).toMatchObject({ Lists: false, Row: false, NotNow: true });
    // A sheet: its full-screen container wraps the sheet, which starts lower; only that area hides.
    const sheet = app(
      el(
        'Window',
        'Main',
        0,
        0,
        375,
        667,
        background +
          el(
            'Other',
            'Layer',
            0,
            0,
            375,
            667,
            el('Other', 'Sheet', 0, 400, 375, 267, el('Button', 'Continue', 24, 556, 327, 51) + el('Other', 'Body', 24, 420, 327, 100)),
          ),
      ),
    );
    expect(clickable(sheet)).toMatchObject({ Lists: true, Row: true, Continue: true });
    // A single-layer window is unaffected.
    expect(clickable(app(el('Window', 'Main', 0, 0, 375, 667, background)))).toMatchObject({ Lists: true, Row: true });
  });
});
