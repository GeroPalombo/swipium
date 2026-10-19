// normalizeWdaSource keeps document order across sibling element types. A tag-grouped parse turned
// `Other, Alert, Other` into `Other, Other, Alert`, so a sheet painted above an alert was judged
// covered by it, and reading order followed the tag names instead of the screen.

import { describe, expect, it } from 'vitest';
import { normalizeWdaSource } from '../src/lib/wda.js';
import { parseSnapshot } from '../src/snapshot/parse.js';

const el = (type: string, attrs: string, inner = '') =>
  `<XCUIElementType${type} type="XCUIElementType${type}" ${attrs} enabled="true"${inner ? `>${inner}</XCUIElementType${type}>` : '/>'}`;

// No `visible` attributes (the lean default source), so layering decides what is clickable.
const source = `<?xml version="1.0" encoding="UTF-8"?>${el(
  'Application',
  'name="App" label="App" x="0" y="0" width="393" height="852"',
  el(
    'Window',
    'x="0" y="0" width="393" height="852"',
    el(
      'Other',
      'x="0" y="0" width="393" height="852"',
      el('Button', 'name="Behind" label="Behind" x="96" y="380" width="200" height="40"'),
    ) +
      el(
        'Alert',
        'name="Allow?" label="Allow?" x="50" y="300" width="293" height="200"',
        el('StaticText', 'name="Title" label="Title" x="70" y="320" width="253" height="20"') +
          el('Button', 'name="OK" label="OK" x="96" y="400" width="200" height="30"'),
      ) +
      el(
        'Other',
        'x="0" y="450" width="393" height="402"',
        el('Button', 'name="Sheet" label="Sheet" x="100" y="460" width="193" height="30"') +
          el('StaticText', 'name="Caption" label="Caption" x="100" y="520" width="193" height="20"'),
      ),
  ),
)}`;

describe('normalizeWdaSource document order', () => {
  it('keeps mixed-type siblings in document order', () => {
    const classes = parseSnapshot(normalizeWdaSource(source)).allNodes.map((n) => n.cls.replace('XCUIElementType', ''));
    expect(classes).toEqual(['Application', 'Window', 'Other', 'Button', 'Alert', 'StaticText', 'Button', 'Other', 'Button', 'StaticText']);
  });

  it('layers later siblings over earlier ones: the sheet after the alert stays clickable', () => {
    const nodes = parseSnapshot(normalizeWdaSource(source)).allNodes;
    const clickable = (label: string) => nodes.find((n) => n.desc === label)?.clickable;
    expect(clickable('Behind')).toBe(false); // under the alert
    expect(clickable('OK')).toBe(true);
    expect(clickable('Sheet')).toBe(true); // painted after (above) the alert, inside its rect
  });

  it('single-type children are unchanged', () => {
    const plain = el(
      'Application',
      'name="App" label="App" x="0" y="0" width="393" height="852" visible="true"',
      el('Button', 'name="A" label="A" x="0" y="100" width="100" height="40" visible="true"') +
        el('Button', 'name="B" label="B" x="0" y="200" width="100" height="40" visible="true"'),
    );
    expect(normalizeWdaSource(plain)).toBe(
      '<hierarchy><node class="XCUIElementTypeApplication" text="App" content-desc="App" resource-id="" bounds="[0,0][393,852]" clickable="false" long-clickable="false" scrollable="false" focusable="false" focused="false" enabled="true" password="false">' +
        '<node class="XCUIElementTypeButton" text="A" content-desc="A" resource-id="" bounds="[0,100][100,140]" clickable="true" long-clickable="false" scrollable="false" focusable="false" focused="false" enabled="true" password="false"></node>' +
        '<node class="XCUIElementTypeButton" text="B" content-desc="B" resource-id="" bounds="[0,200][100,240]" clickable="true" long-clickable="false" scrollable="false" focusable="false" focused="false" enabled="true" password="false"></node>' +
        '</node></hierarchy>',
    );
  });

  it('returns non-WDA XML untouched', () => {
    expect(normalizeWdaSource('<hierarchy><node/></hierarchy>')).toBe('<hierarchy><node/></hierarchy>');
  });
});
