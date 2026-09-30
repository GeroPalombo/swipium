// Item 10: overlay false positives on debug builds. OVERLAY_SIGNAL_RE / NAV_CHROME_RE were tested
// against every ancestor's FULL resource-id — with applicationIdSuffix ".debug" every id contains
// "debug" (and package names can contain notification/alert/toolbar), so ordinary edge-pinned
// content read as a banner/snackbar. Only the part after `:id/` counts now, never the root.

import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '../src/snapshot/parse.js';
import { detectTreeOverlays, localResourceId } from '../src/snapshot/overlays.js';

function screen(pkg: string, rows: string): string {
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node class="android.widget.FrameLayout" package="${pkg}" text="" resource-id="${pkg}:id/root_debug_container" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">` +
    `<node class="android.widget.TextView" package="${pkg}" text="Shop" resource-id="${pkg}:id/title" content-desc="" bounds="[40,300][1040,380]" clickable="false" enabled="true"/>` +
    rows +
    `</node></hierarchy>`
  );
}

const checkoutBar = (pkg: string) =>
  `<node class="android.widget.LinearLayout" package="${pkg}" text="" resource-id="${pkg}:id/checkout_bar" content-desc="" bounds="[0,1700][1080,1920]" clickable="false" enabled="true">` +
  `<node class="android.widget.TextView" package="${pkg}" text="Total: $42.00" resource-id="${pkg}:id/total" content-desc="" bounds="[0,1720][1080,1900]" clickable="false" enabled="true"/>` +
  `</node>`;

const overlaysOf = (xml: string) => {
  const p = parseSnapshot(xml);
  return detectTreeOverlays(p.allNodes, p.screen);
};

describe('overlay signals ignore the package part of resource-ids', () => {
  it('localResourceId strips the package prefix (Android) and keeps iOS identifiers whole', () => {
    expect(localResourceId('com.acme.shop.debug:id/promo_banner')).toBe('promo_banner');
    expect(localResourceId('android:id/button1')).toBe('button1');
    expect(localResourceId('id/x')).toBe('x');
    expect(localResourceId('checkout.debugBanner')).toBe('checkout.debugBanner');
  });

  it('com.acme.shop.debug: a bottom checkout bar is NOT a snackbar', () => {
    expect(overlaysOf(screen('com.acme.shop.debug', checkoutBar('com.acme.shop.debug')))).toEqual([]);
  });

  it('package names containing notification/alert are not overlay signals either', () => {
    expect(overlaysOf(screen('com.acme.notification.alerts', checkoutBar('com.acme.notification.alerts')))).toEqual([]);
  });

  it('a real banner id (after :id/) on a debug build is still detected', () => {
    const pkg = 'com.acme.shop.debug';
    const banner =
      `<node class="android.widget.LinearLayout" package="${pkg}" text="" resource-id="${pkg}:id/promo_banner" content-desc="" bounds="[0,1700][1080,1920]" clickable="false" enabled="true">` +
      `<node class="android.widget.TextView" package="${pkg}" text="Free shipping today" resource-id="${pkg}:id/promo_text" content-desc="" bounds="[0,1720][1080,1900]" clickable="false" enabled="true"/>` +
      `</node>`;
    const o = overlaysOf(screen(pkg, banner));
    expect(o.map((x) => x.type)).toEqual(['snackbar']);
  });
});
