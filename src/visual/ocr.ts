import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig } from '../cli/scan.js';
import { captureCoordinateSpace, toDevicePoint, type CoordinateSpace } from '../lib/coordSpace.js';
import { maskScreenshotForProvider, runVisualProvider, type ProviderIo, type VisualProviderCommand } from './provider.js';
import type { Driver } from '../drivers/Driver.js';

export interface OcrRegion {
  text: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  coordinateSpace: 'screenshot_px';
}

export interface OcrResult {
  text: string;
  regions: OcrRegion[];
  coordinateSpace: CoordinateSpace;
  provider: { io: ProviderIo; argv: string[] };
  masking: { providerConfigured: boolean; masksApplied: string[] };
}

export function configuredOcrCommand(root: string): VisualProviderCommand | undefined {
  const cfg = loadProjectConfig(root)?.ocrCommand as VisualProviderCommand | undefined;
  return cfg ?? process.env.SWIPIUM_OCR_CMD;
}

export function parseOcrOutput(stdout: string): { text: string; regions: OcrRegion[] } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '', regions: [] };
  try {
    const json = JSON.parse(trimmed) as unknown;
    const arr = Array.isArray(json)
      ? json
      : Array.isArray((json as { regions?: unknown })?.regions)
        ? (json as { regions: unknown[] }).regions
        : [];
    const regions = arr
      .map((r) => r as Partial<OcrRegion>)
      .filter(
        (r): r is OcrRegion =>
          typeof r.text === 'string' &&
          typeof r.confidence === 'number' &&
          !!r.bbox &&
          typeof r.bbox.x === 'number' &&
          typeof r.bbox.y === 'number' &&
          typeof r.bbox.width === 'number' &&
          typeof r.bbox.height === 'number',
      )
      .map((r) => ({ ...r, coordinateSpace: 'screenshot_px' as const }));
    const text =
      typeof (json as { text?: unknown })?.text === 'string' ? (json as { text: string }).text : regions.map((r) => r.text).join('\n');
    return { text, regions };
  } catch {
    return { text: trimmed, regions: [] };
  }
}

export async function runOcr(driver: Driver, root: string, command: VisualProviderCommand): Promise<OcrResult> {
  const png = await driver.screenshot();
  const coordinateSpace = await captureCoordinateSpace(driver, png);
  const imgPath = join(tmpdir(), `swipium-ocr-${Date.now()}.png`);
  const cleanup = [imgPath];
  try {
    writeFileSync(imgPath, png);
    const masking = await maskScreenshotForProvider(root, imgPath, { task: 'ocr' });
    cleanup.push(...masking.tempPaths);
    const { resolved, result } = await runVisualProvider(
      command,
      { image: masking.imagePath },
      {
        task: 'ocr',
        imagePath: masking.imagePath,
        coordinateSpace,
        masking: { providerConfigured: masking.providerConfigured, masksApplied: masking.masksApplied },
      },
      30000,
    );
    return {
      ...parseOcrOutput(result.stdout),
      coordinateSpace,
      provider: { io: resolved.io, argv: resolved.argv },
      masking: { providerConfigured: masking.providerConfigured, masksApplied: masking.masksApplied },
    };
  } finally {
    for (const path of cleanup) {
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export function findOcrRegion(
  result: OcrResult,
  query: string,
  minConfidence = 0.8,
): { region: OcrRegion; devicePoint: { x: number; y: number } } | null {
  const q = query.toLowerCase();
  const region = result.regions
    .filter((r) => r.confidence >= minConfidence && r.text.toLowerCase().includes(q))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!region) return null;
  const center = { x: region.bbox.x + region.bbox.width / 2, y: region.bbox.y + region.bbox.height / 2 };
  return { region, devicePoint: toDevicePoint(result.coordinateSpace, center.x, center.y) };
}
