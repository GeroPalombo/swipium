// Shared fake device + session for the capture-guard tests: put a secure (password) field or a
// clean screen on a fake Android driver, optionally cache it as the session's fresh snapshot, and
// list the image files the session wrote. Not a test file itself.
//
// Import this BEFORE any src/ module (test files load src/ with `await import(...)` after it): it
// points HOME at a temp dir so the session registry never touches the real ~/.swipium.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Driver } from '../../src/drivers/Driver.js';
import type { Session, SessionStore } from '../../src/session/store.js';
import { FakeDriver, dump } from '../actFixFake.js';

const fakeHome = mkdtempSync(join(tmpdir(), 'swipium-capture-home-'));
process.env.HOME = fakeHome;
process.env.SWIPIUM_DISABLE_DEVICE_DISCOVERY = '1';
const roots: string[] = [fakeHome];

export const APP_ID = 'com.example.app';

/** A login screen: an Android password EditText (isSecureNode via password="true"). */
export const SECURE_SCREEN = dump([
  { cls: 'android.widget.TextView', text: 'Sign in', bounds: [40, 100, 1040, 180], clickable: false },
  { cls: 'android.widget.EditText', text: '', id: `${APP_ID}:id/email`, bounds: [40, 300, 1040, 400] },
  { cls: 'android.widget.EditText', text: '', id: `${APP_ID}:id/pin`, bounds: [40, 450, 1040, 550], extra: 'password="true"' },
  { text: 'Log in', id: `${APP_ID}:id/login`, bounds: [40, 600, 1040, 700] },
]);

/** An ordinary screen with no secure field. */
export const CLEAN_SCREEN = dump([
  { cls: 'android.widget.TextView', text: 'Home', bounds: [40, 100, 1040, 180], clickable: false },
  { text: 'Settings', id: `${APP_ID}:id/settings`, bounds: [40, 300, 1040, 400] },
]);

/** A 1x1 PNG, so code that reads image dimensions gets a real header. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** FakeDriver that counts screenshots (every pixel grab, whether or not it gets written). */
export class CaptureDriver extends FakeDriver {
  shots = 0;
  dumpFails = false;
  override async screenshot() {
    this.rec('screenshot');
    this.shots++;
    return PNG_1X1;
  }
  override async dumpXml(opts?: Parameters<FakeDriver['dumpXml']>[0]) {
    this.rec('dumpXml', opts);
    if (this.dumpFails) throw new Error('dump failed');
    return this.xml;
  }
}

export interface CaptureHarness {
  sessions: SessionStore;
  session: Session;
  driver: CaptureDriver;
  root: string;
  /** Put `xml` on the device; `cache:true` also stores it as the session's fresh snapshot. */
  show(xml: string, opts?: { cache?: boolean }): Promise<void>;
  /** Image files written under the session directory (any depth). */
  imageFiles(): string[];
}

export interface CaptureHarnessOptions {
  /** What is on screen (default: the secure login screen). */
  screen?: string;
  /** Cache the screen as the session's fresh snapshot (default false: the guard must dump). */
  cache?: boolean;
  sensitive?: boolean;
  kind?: Driver['kind'];
}

function imagesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...imagesUnder(p));
    else if (/\.(png|jpe?g)$/i.test(e.name)) out.push(p);
  }
  return out;
}

export async function captureHarness(opts: CaptureHarnessOptions = {}): Promise<CaptureHarness> {
  const { SessionStore } = await import('../../src/session/store.js');
  const { adoptSnapshot } = await import('../../src/snapshot/fresh.js');
  const { parseSnapshot } = await import('../../src/snapshot/parse.js');
  const root = mkdtempSync(join(tmpdir(), 'swipium-capture-proj-'));
  roots.push(root);
  const sessions = new SessionStore();
  const session = sessions.create(root, undefined, { sensitive: opts.sensitive ?? false });
  session.appId = APP_ID;
  const driver = new CaptureDriver(opts.screen ?? SECURE_SCREEN);
  // The class field is a plain own property, so a test can model an iOS simulator / WDA backend.
  if (opts.kind) Object.defineProperty(driver, 'kind', { value: opts.kind });
  const h: CaptureHarness = {
    sessions,
    session,
    driver,
    root,
    async show(xml, o = {}) {
      driver.xml = xml;
      if (o.cache) adoptSnapshot(session, parseSnapshot(xml));
    },
    imageFiles: () => imagesUnder(session.dir),
  };
  if (opts.cache) await h.show(driver.xml, { cache: true });
  return h;
}

/** Remove every temp dir the harness created (call from afterAll). */
export function cleanupCaptureHarnesses(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** One guarded capture path for the table test (test/captureGuardSites.test.ts). `run` drives the
 *  site once on the harness's screen and returns the withheld note the site recorded (undefined when
 *  it captured). `clean:false` skips the clean-screen control (a site that needs more than a fake
 *  device to finish, e.g. an OCR provider). */
export interface CaptureSiteRow {
  site: string;
  run(h: CaptureHarness): Promise<string | undefined>;
  clean?: boolean;
  /** The site records that a capture was withheld (a counter) but not which rule withheld it, so
   *  the table only checks that something was recorded. */
  recordsCount?: boolean;
  /** The site grabs pixels alongside its dump (in memory) and drops them once the dump shows a
   *  secure field: no file is ever written, but the grab count is not zero on a secure screen. */
  grabsBeforeGuard?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;

/** Register one tool module against a stub server and hand back its handler, so a row can call a
 *  tool on the harness's own SessionStore (no MCP transport, no device attach). */
export function toolHandler(
  register: (server: McpServer, sessions: SessionStore) => void,
  sessions: SessionStore,
  name: string,
): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = { registerTool: (n: string, _meta: unknown, fn: ToolHandler) => handlers.set(n, fn) } as unknown as McpServer;
  register(server, sessions);
  const fn = handlers.get(name);
  if (!fn) throw new Error(`tool ${name} was not registered`);
  return fn;
}
