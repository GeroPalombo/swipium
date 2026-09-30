// Real-device regression (Android 16 emulator, landscape Settings): uiautomator keeps rows that
// were scrolled off the list with INVERTED bounds. They must not surface as elements, or
// `scroll untilVisible` reports an off-screen row as found and taps land on the list edge.
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '../src/snapshot/parse.js';

const node = (attrs: Record<string, string>, children = '') =>
  `<node ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}>${children}</node>`;

const dump = (rows: string) =>
  `<?xml version="1.0"?><hierarchy rotation="1">${node(
    { class: 'android.widget.FrameLayout', bounds: '[0,0][2400,1080]', text: '', 'content-desc': '' },
    node({ class: 'androidx.recyclerview.widget.RecyclerView', scrollable: 'true', bounds: '[0,315][2400,1080]' }, rows),
  )}</hierarchy>`;

const row = (text: string, bounds: string) =>
  node({ class: 'android.widget.TextView', text, bounds, clickable: 'true', 'content-desc': '' });

describe('parseSnapshot drops nodes the user cannot see', () => {
  it('skips a row clipped off the list (inverted bounds) and keeps visible rows', () => {
    const p = parseSnapshot(dump(row('Network & internet', '[210,315][646,247]') + row('Apps', '[210,400][646,480]')));
    const texts = p.elements.map((e) => e.text);
    expect(texts).toContain('Apps');
    expect(texts).not.toContain('Network & internet');
    // the raw node is still available for geometry (largest scrollable rect etc.)
    expect(p.allNodes.some((n) => n.text === 'Network & internet')).toBe(true);
  });

  it('skips zero-area and wholly off-screen nodes', () => {
    const p = parseSnapshot(dump(row('Empty', '[210,500][210,560]') + row('Below', '[210,1200][646,1260]')));
    const texts = p.elements.map((e) => e.text);
    expect(texts).not.toContain('Empty');
    expect(texts).not.toContain('Below');
  });

  it('keeps nodes that carry no bounds attribute (unknown geometry)', () => {
    const p = parseSnapshot(dump(node({ class: 'android.widget.TextView', text: 'No bounds', clickable: 'true' })));
    expect(p.elements.map((e) => e.text)).toContain('No bounds');
  });
});
