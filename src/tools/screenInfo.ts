// qa_screen_info — device + screen metadata for coordinate-driven (visual-fallback) work,
// so the agent doesn't shell out to `adb shell wm size/density` or measure screenshots.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { getOrientation } from '../lib/device.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';

export function registerScreenInfo(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_screen_info',
    {
      title: 'Screen info',
      description:
        'Device + screen metadata for coordinate work: width/height (px), density (dpi), session mode (structured | visual-fallback), the latest screenshot URI, and budget counters. Use this in visual-fallback mode to place coordinate taps instead of shelling out to wm size/density.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) {
        return qaError({
          what: 'No device attached to this session',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_prepare_target first.'],
        });
      }
      const serial = driver.currentDevice();
      const [size, density, orient] = await Promise.all([driver.screenSize(), driver.screenDensity(), serial ? getOrientation(serial).catch(() => null) : Promise.resolve(null)]);
      const orientation = orient ? (orient.rotation === 1 || orient.rotation === 3 ? 'landscape' : 'portrait') : 'unknown';
      const lastShot = [...session.artifacts].reverse().find((a) => a.kind === 'screenshot');

      // Coordinate landmarks (P1.7) for visual-fallback taps — so the agent places taps from
      // named anchors instead of guessing pixels off a screenshot.
      let landmarks: Record<string, [number, number]> | undefined;
      let bands: Record<string, { yFrom: number; yTo: number }> | undefined;
      if (size) {
        const w = size.width;
        const h = size.height;
        const X = (fx: number) => Math.round(w * fx);
        const Y = (fy: number) => Math.round(h * fy);
        landmarks = {
          topNavCenter: [X(0.5), Y(0.06)],
          bottomNavCenter: [X(0.5), Y(0.96)],
          center: [X(0.5), Y(0.5)],
          topLeft: [X(0.08), Y(0.06)],
          topRight: [X(0.92), Y(0.06)],
          bottomLeft: [X(0.08), Y(0.96)],
          bottomRight: [X(0.92), Y(0.96)],
          primaryCtaArea: [X(0.5), Y(0.88)], // most apps put the main CTA in the bottom band
        };
        bands = {
          topNav: { yFrom: 0, yTo: Y(0.12) },
          content: { yFrom: Y(0.12), yTo: Y(0.85) },
          bottomNav: { yFrom: Y(0.9), yTo: h },
          ctaBand: { yFrom: Y(0.78), yTo: Y(0.95) },
        };
      }

      return qaOk(
        {
          device: session.device ?? null,
          screen: size ? { width: size.width, height: size.height, density } : null,
          orientation,
          coordinateNote: 'landmarks/bands are DEVICE pixels (origin top-left) — pass directly as qa_act {x,y}. For screenshot-space hits (qa_visual find_image) convert with coordinateSpace.scale.',
          mode: session.mode,
          headless: session.headless ?? null,
          latestScreenshot: lastShot?.uri ?? null,
          landmarks,
          bands,
          counters: session.counters,
          budget: session.budget,
        },
        `device=${session.device} screen=${size ? `${size.width}x${size.height}@${density ?? '?'}dpi` : 'unknown'} mode=${session.mode}` +
          (landmarks ? `\nlandmarks: center=${landmarks.center} bottomNav=${landmarks.bottomNavCenter} cta=${landmarks.primaryCtaArea}` : '') +
          (lastShot ? `\nlatest screenshot: ${lastShot.uri}` : '\n(no screenshot yet — call qa_screenshot)'),
      );
    },
  );
}
