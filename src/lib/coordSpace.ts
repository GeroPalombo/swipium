// Coordinate-convention audit (PHASE3-PLAN §8.1). The vision-MCP audit found that visual tools
// returning coordinates WITHOUT declaring their space cause wrong taps. So every visual result
// self-describes: screenshot vs device pixels, the scale between them, density, orientation, and
// origin. An agent (or our own tools) can then convert a screenshot-space hit into a device-space
// tap correctly instead of guessing.

import { pngSize } from './png.js';
import { getOrientation } from './device.js';
import type { Driver } from '../drivers/Driver.js';

export interface CoordinateSpace {
  origin: 'top-left';
  screenshot: { width: number; height: number } | null;
  device: { width: number; height: number } | null;
  density: number | null;
  scale: number | null; // screenshot.width / device.width (1 on most emulators)
  orientation: 'portrait' | 'landscape' | 'unknown';
}

/** Assemble the coordinate space for a screenshot buffer using the driver's device metrics. */
export async function captureCoordinateSpace(driver: Driver, screenshotBuf: Buffer): Promise<CoordinateSpace> {
  const shot = pngSize(screenshotBuf);
  const [device, density] = await Promise.all([driver.screenSize().catch(() => null), driver.screenDensity().catch(() => null)]);
  const serial = driver.currentDevice();
  const o = serial ? await getOrientation(serial).catch(() => null) : null;
  const orientation: CoordinateSpace['orientation'] = o ? (o.rotation === 1 || o.rotation === 3 ? 'landscape' : 'portrait') : 'unknown';
  const scale = shot && device && device.width ? Math.round((shot.width / device.width) * 1000) / 1000 : null;
  return { origin: 'top-left', screenshot: shot, device, density, scale, orientation };
}

/** Convert a screenshot-space point to device (tap) pixels using the scale. */
export function toDevicePoint(cs: CoordinateSpace, x: number, y: number): { x: number; y: number } {
  const s = cs.scale && cs.scale !== 0 ? cs.scale : 1;
  return { x: Math.round(x / s), y: Math.round(y / s) };
}
