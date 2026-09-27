// Real-device smoke (2.0.0) regressions for the WDA snapshot path, using a REAL WDA page source
// (iOS Settings with the search field focused and "P@ss&w0rd!$ a{b}" typed; keyboard subtree and
// empty containers trimmed): test/fixtures/wda-ios-settings-search.xml.
//  - ids: WDA's XML has no `identifier`; `name` carries the accessibilityIdentifier when it differs
//    from the label (name="com.apple.settings.general", label="General") → idCoverage > 0;
//  - XCUIElementTypeSearchField (with children) is surfaced as a focusable text-field whose typed
//    value is readable; SecureTextField stays masked (password attr → secure);
//  - nothing in src/lib/wda.ts calls the nonexistent WDA /session/:id/back route (404 on device);
//    iOS back is WdaDriver's nav-bar-button / edge-swipe (covered in deviceIos.test.ts).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeWdaSource, wdaNodeIdentifier } from '../src/lib/wda.js';
import { parseSnapshot } from '../src/snapshot/parse.js';

const RAW = readFileSync(join(import.meta.dirname, 'fixtures', 'wda-ios-settings-search.xml'), 'utf8');

describe('WDA snapshot fidelity (real iOS Settings source)', () => {
  const parsed = parseSnapshot(normalizeWdaSource(RAW));

  it('reads accessibility identifiers from `name` (idCoverage > 0)', () => {
    expect(parsed.quality.signals.idCoverage).toBeGreaterThan(0);
    const general = parsed.elements.find((e) => e.id === 'com.apple.settings.general');
    expect(general).toBeTruthy();
    expect(general!.label).toBe('General');
    // name === label is NOT an id (it is the label echoed back).
    expect(parsed.elements.find((e) => e.label === 'Cancelar' && e.role === 'button')?.id).toBeUndefined();
  });

  it('surfaces the SearchField as a focusable text-field with its typed value', () => {
    const search = parsed.elements.find((e) => e.role === 'text-field');
    expect(search).toBeTruthy();
    expect(search!.text).toBe('P@ss&w0rd!$ a{b}');
    expect(search!.label).toBe('Buscar');
    expect(search!.clickable).toBe(true);
    const raw = parsed.fullByRef.get(search!.ref)!;
    expect(raw.cls).toBe('XCUIElementTypeSearchField');
    expect(raw.focusable).toBe(true);
    expect(raw.isLeaf).toBe(false); // has children (magnifier, clear button) and is still surfaced
  });

  it('keeps SecureTextField masked and maps iOS TextField / TextView to text-field', () => {
    const xml = `<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" label="App" x="0" y="0" width="400" height="800">
      <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="email_input" label="Email" value="me@example.com" x="10" y="100" width="300" height="40"/>
      <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" name="password_input" label="Password" value="••••••" x="10" y="160" width="300" height="40"/>
      <XCUIElementTypeTextView type="XCUIElementTypeTextView" name="notes" label="Notes" value="hello" x="10" y="220" width="300" height="120"/>
    </XCUIElementTypeApplication>`;
    const p = parseSnapshot(normalizeWdaSource(xml));
    const byId = (id: string) => p.elements.find((e) => e.id === id)!;
    expect(byId('email_input').role).toBe('text-field');
    expect(byId('notes').role).toBe('text-field');
    const pw = byId('password_input');
    expect(pw.role).toBe('text-field');
    expect(pw.secure).toBe(true);
  });

  it('wdaNodeIdentifier: explicit identifier wins; name counts only when it differs from label', () => {
    expect(wdaNodeIdentifier({ identifier: 'x', name: 'y', label: 'z' })).toBe('x');
    expect(wdaNodeIdentifier({ name: 'login_btn', label: 'Log in' })).toBe('login_btn');
    expect(wdaNodeIdentifier({ name: 'Log in', label: 'Log in' })).toBe('');
    expect(wdaNodeIdentifier({ name: 'Title' })).toBe('');
  });
});

describe('no WDA /back route', () => {
  it('src/lib/wda.ts exposes no pressWdaBack and never builds a /session/:id/back URL (404 on WDA)', async () => {
    const mod = (await import('../src/lib/wda.js')) as Record<string, unknown>;
    expect(mod.pressWdaBack).toBeUndefined();
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'wda.ts'), 'utf8');
    expect(src).not.toMatch(/\/session\/\$\{sessionId\}\/back[`'"]/);
  });
});
