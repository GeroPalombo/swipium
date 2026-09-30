import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectConfig } from '../cli/scan.js';
import { captureCoordinateSpace, toDevicePoint, type CoordinateSpace } from '../lib/coordSpace.js';
import {
  makeProviderWorkDir,
  maskScreenshotForProvider,
  runVisualProvider,
  type ProviderIo,
  type ProviderSource,
  type VisualProviderCommand,
} from './provider.js';
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

/**
 * The local OCR provider contract (what `find_text` needs; no provider is bundled):
 *  - Configure `ocrCommand` in .swipium/config.json: an argv array (preferred), a string
 *    (deprecated, shell-split), or { command, io: "argv" | "json", timeoutMs }. Or use the
 *    SWIPIUM_OCR_CMD env var (a string). Project config wins over the env var.
 *  - `{image}` in the argv is replaced with the path of a PNG screenshot (already masked when
 *    visualMaskCommand is configured). With io:"json" the command ALSO receives one JSON line on
 *    stdin: { schema: "swipium.visual.provider.v1", task: "ocr", imagePath, coordinateSpace, masking }.
 *  - stdout must be JSON: either an array of regions or { text?, regions: [...] }, where each
 *    region is { text: string, confidence: 0..1, bbox: { x, y, width, height } } in SCREENSHOT
 *    PIXELS (top-left origin). Line-level regions work best (find_text matches a case-insensitive
 *    substring of one region). Non-JSON stdout is kept as plain text with no regions, so nothing
 *    can be located. Default timeout 30 s; Git executables are refused.
 *  - The command runs with cwd = the project root (relative argv such as ".swipium/ocr_tesseract.py"
 *    resolves there). A non-zero exit or timeout is a typed OCR_PROVIDER_FAILED failure carrying the
 *    exit code and trimmed (redacted) stderr, never a silent "found: false".
 */
export const OCR_PROVIDER_CONTRACT =
  'ocrCommand (.swipium/config.json, argv array with an {image} placeholder; or env SWIPIUM_OCR_CMD) is run on a PNG screenshot and must ' +
  'print JSON to stdout: [{"text":"Log in","confidence":0.97,"bbox":{"x":53,"y":182,"width":104,"height":38}}] (or {"regions":[...]}). ' +
  'Bbox in screenshot pixels, confidence 0..1, one region per text line. Optional {command, io:"json", timeoutMs} form also sends a ' +
  'swipium.visual.provider.v1 JSON line on stdin. Runs with cwd = project root; non-zero exit > OCR_PROVIDER_FAILED. Timeout 30 s.';

/** A verified tesseract-based provider: groups tesseract's word TSV into line regions. Save as
 * e.g. .swipium/ocr_tesseract.py and set ocrCommand to ["python3", ".swipium/ocr_tesseract.py", "{image}"]. */
export const TESSERACT_OCR_EXAMPLE = `import csv, json, subprocess, sys
tsv = subprocess.run(['tesseract', sys.argv[1], 'stdout', 'tsv'], capture_output=True, text=True, check=True).stdout
lines = {}
for w in csv.DictReader(tsv.splitlines(), delimiter='\t', quoting=csv.QUOTE_NONE):
    if w['level'] != '5' or not w['text'].strip() or float(w['conf']) < 0: continue
    k = (w['page_num'], w['block_num'], w['par_num'], w['line_num'])
    x, y, wd, ht = (int(w[c]) for c in ('left', 'top', 'width', 'height'))
    l = lines.setdefault(k, {'words': [], 'conf': [], 'x0': x, 'y0': y, 'x1': x + wd, 'y1': y + ht})
    l['words'].append(w['text']); l['conf'].append(float(w['conf']) / 100)
    l['x0'], l['y0'] = min(l['x0'], x), min(l['y0'], y); l['x1'], l['y1'] = max(l['x1'], x + wd), max(l['y1'], y + ht)
print(json.dumps([{'text': ' '.join(l['words']), 'confidence': min(l['conf']),
    'bbox': {'x': l['x0'], 'y': l['y0'], 'width': l['x1'] - l['x0'], 'height': l['y1'] - l['y0']}} for l in lines.values()]))
`;

export function configuredOcrCommand(root: string): VisualProviderCommand | undefined {
  const cfg = loadProjectConfig(root)?.ocrCommand as VisualProviderCommand | undefined;
  return cfg ?? process.env.SWIPIUM_OCR_CMD;
}

/** Provenance of the OCR command configuredOcrCommand() would use. */
export function ocrCommandSource(root: string): ProviderSource | undefined {
  if (loadProjectConfig(root)?.ocrCommand) return 'repository';
  return process.env.SWIPIUM_OCR_CMD ? 'environment' : undefined;
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
  // Real (symlink-resolved) temp path: tesseract/leptonica cannot open macOS /tmp/... paths.
  // A private mkdtemp (0700) dir per call, never a predictable name in the shared tmpdir.
  const workDir = makeProviderWorkDir('swipium-ocr-');
  const imgPath = join(workDir, 'screen.png');
  const cleanup = [workDir];
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
      // Relative argv (".swipium/ocr_tesseract.py") resolves against the project root; a
      // non-zero exit throws VisualProviderFailedError (OCR_PROVIDER_FAILED), never found:false.
      { cwd: root, provider: 'ocr' },
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
        rmSync(path, { recursive: true, force: true });
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
