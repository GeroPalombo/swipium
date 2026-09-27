// Real-device smoke (2.0.0) overlay false positives: the heuristic banner/snackbar detector
// flagged (iOS) the Settings navigation-bar title as a "banner" and the last list row as a
// "snackbar", and (Android) the search text field as a "top banner" and Settings list category
// titles as banner/snackbar. The heuristic now excludes text fields, navigation chrome and rows
// inside scrolling lists, and requires an overlay signal (class/id, dismiss affordance, wording).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeWdaSource } from '../src/lib/wda.js';
import { parseSnapshot } from '../src/snapshot/parse.js';
import { detectTreeOverlays } from '../src/snapshot/overlays.js';

const IOS_SETTINGS = readFileSync(join(import.meta.dirname, 'fixtures', 'wda-ios-settings-search.xml'), 'utf8');

function overlaysOf(xml: string) {
  const p = parseSnapshot(xml);
  return detectTreeOverlays(p.allNodes, p.screen);
}

const node = (attrs: string, children = '') =>
  `<node ${attrs} content-desc="" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false">${children}</node>`;

describe('overlay heuristic false positives (real-device smoke)', () => {
  it('iOS Settings: nav-bar title and last list row are not banner/snackbar', () => {
    const o = overlaysOf(normalizeWdaSource(IOS_SETTINGS));
    expect(o.filter((x) => x.type === 'banner' || x.type === 'snackbar')).toEqual([]);
  });

  it('Android Settings › Display: category titles inside the RecyclerView are not overlays', () => {
    const xml = `<hierarchy rotation="0">${node(
      'class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]"',
      node('class="android.widget.ImageButton" text="" resource-id="" bounds="[0,63][126,252]"') +
        node(
          'class="androidx.recyclerview.widget.RecyclerView" text="" resource-id="com.android.settings:id/recycler_view" bounds="[0,252][1080,2337]"',
          node('class="android.widget.TextView" text="Appearance" resource-id="android:id/title" bounds="[63,365][1038,416]"') +
            node('class="android.widget.TextView" text="Dark theme" resource-id="android:id/title" bounds="[63,500][900,560]"') +
            node(
              'class="android.widget.TextView" text="Other display controls" resource-id="android:id/title" bounds="[63,2110][1038,2161]"',
            ),
        ).replace('scrollable="false"', 'scrollable="true"'),
    )}</hierarchy>`;
    expect(overlaysOf(xml).filter((x) => x.type === 'banner' || x.type === 'snackbar')).toEqual([]);
  });

  it('Android search screen: the focused search EditText is not a "top banner"', () => {
    const xml = `<hierarchy rotation="0">${node(
      'class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]"',
      node('class="android.widget.ImageButton" text="" resource-id="" bounds="[0,63][126,252]"') +
        node(
          'class="android.widget.EditText" text="a" resource-id="com.google.android.settings.intelligence:id/open_search_view_edit_text" bounds="[126,63][933,252]"',
        ) +
        node('class="android.widget.TextView" text="No results for a" resource-id="x:id/no_results_text" bounds="[0,702][1080,753]"'),
    )}</hierarchy>`;
    expect(overlaysOf(xml).filter((x) => x.type === 'banner')).toEqual([]);
  });

  it('a plain wide text at the top with no overlay signal is not a banner', () => {
    const xml = `<hierarchy rotation="0">${node(
      'class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]"',
      node('class="android.widget.TextView" text="Welcome back" resource-id="" bounds="[0,80][1080,200]"'),
    )}</hierarchy>`;
    expect(overlaysOf(xml)).toEqual([]);
  });
});

describe('overlay heuristic still detects real banners', () => {
  it('a debug banner (overlay-like id) at the top is a banner', () => {
    const xml = `<hierarchy rotation="0">${node(
      'class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]"',
      node(
        'class="android.view.ViewGroup" text="" resource-id="com.example:id/debug_banner" bounds="[0,80][1080,200]"',
        node('class="android.widget.TextView" text="Test Store — purchases are simulated" resource-id="" bounds="[20,90][1060,190]"'),
      ),
    )}</hierarchy>`;
    const o = overlaysOf(xml);
    expect(o.map((x) => x.type)).toContain('banner');
  });

  it('a bottom message with a dismiss button is a snackbar', () => {
    const xml = `<hierarchy rotation="0">${node(
      'class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]"',
      node(
        'class="android.view.ViewGroup" text="" resource-id="" bounds="[0,2150][1080,2300]"',
        node('class="android.widget.TextView" text="You are offline" resource-id="" bounds="[20,2160][800,2290]"') +
          node('class="android.widget.Button" text="Dismiss" resource-id="" bounds="[820,2160][1060,2290]"').replace(
            'clickable="false"',
            'clickable="true"',
          ),
      ),
    )}</hierarchy>`;
    expect(overlaysOf(xml).map((x) => x.type)).toContain('snackbar');
  });

  it('Material snackbar by id is still reported', () => {
    const xml = `<hierarchy rotation="0">${node(
      'class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]"',
      node('class="android.widget.TextView" text="Saved" resource-id="com.example.app:id/snackbar_text" bounds="[0,1800][1080,1900]"'),
    )}</hierarchy>`;
    expect(overlaysOf(xml).map((x) => x.type)).toContain('snackbar');
  });
});
