import { describe, expect, it } from 'vitest';
import { parseSnapshot, weakTreeHint } from '../src/snapshot/parse.js';

const node = (attrs: string, kids = '') => `<node ${attrs}>${kids}</node>`;
const b = (y: number) => `bounds="[0,${y}][1080,${y + 200}]"`;
const row = (y: number, label: string) =>
  node(
    `class="android.widget.LinearLayout" clickable="true" ${b(y)}`,
    node(`class="android.widget.TextView" resource-id="android:id/title" text="${label}" ${b(y)}`),
  );
const bare = (y: number) => node(`class="android.view.View" clickable="true" ${b(y)}`);
const screen = (rows: string) =>
  `<?xml version="1.0"?><hierarchy rotation="0">${node('class="android.widget.FrameLayout" package="com.x" bounds="[0,0][1080,2400]"', rows)}</hierarchy>`;

describe('weakTreeHint: labels in child nodes count', () => {
  it('a list of clickable rows labeled by child TextViews is not a weak tree', () => {
    const parsed = parseSnapshot(screen([0, 200, 400, 600, 800].map((y, i) => row(y, `Item ${i}`)).join('')));
    expect(weakTreeHint(parsed)).toBeUndefined();
  });
  it('clickables with no text/desc/id anywhere in their subtree still trigger the hint', () => {
    const parsed = parseSnapshot(screen([0, 200, 400, 600].map(bare).join('') + row(800, 'One')));
    expect(weakTreeHint(parsed)).toMatch(/80% of clickable nodes have no text\/label\/id/);
  });
});
