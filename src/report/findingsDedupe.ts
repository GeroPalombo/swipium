// Report finding de-duplication (real-device smoke finding: one report listed the SAME
// WRONG_FOREGROUND finding 24 times). Identical findings — same failure code/kind, severity, layer,
// screen/foreground and message — collapse into ONE entry carrying `count` + first/last timestamps
// and every distinct evidence screenshot. Order follows first occurrence. Pure.

export interface DedupableFinding {
  at?: number;
  severity: string;
  kind: string;
  detail?: string;
  layer?: string;
  evidence?: string;
  screen?: string;
  screenshotUri?: string;
  failureCode?: string;
}

export type DedupedFinding<T extends DedupableFinding> = T & {
  /** How many identical findings this entry stands for (1 = unique). */
  count: number;
  firstAt?: number;
  lastAt?: number;
  /** Distinct evidence screenshots across the occurrences (the first stays in screenshotUri). */
  screenshotUris?: string[];
};

export function findingKey(f: DedupableFinding): string {
  return JSON.stringify([f.failureCode ?? '', f.kind, f.severity, f.layer ?? '', f.screen ?? '', f.detail ?? '', f.evidence ?? '']);
}

export function dedupeFindings<T extends DedupableFinding>(findings: T[]): Array<DedupedFinding<T>> {
  const byKey = new Map<string, DedupedFinding<T>>();
  for (const f of findings) {
    const key = findingKey(f);
    const hit = byKey.get(key);
    if (!hit) {
      byKey.set(key, {
        ...f,
        count: 1,
        firstAt: f.at,
        lastAt: f.at,
        ...(f.screenshotUri ? { screenshotUris: [f.screenshotUri] } : {}),
      });
      continue;
    }
    hit.count++;
    if (f.at != null) {
      hit.firstAt = hit.firstAt == null ? f.at : Math.min(hit.firstAt, f.at);
      hit.lastAt = hit.lastAt == null ? f.at : Math.max(hit.lastAt, f.at);
    }
    if (f.screenshotUri) {
      hit.screenshotUris ??= [];
      if (!hit.screenshotUris.includes(f.screenshotUri)) hit.screenshotUris.push(f.screenshotUri);
      hit.screenshotUri ??= f.screenshotUri;
    }
  }
  return [...byKey.values()];
}

/** " (×24)" suffix for a repeated finding, "" for a unique one. */
export function repeatSuffix(f: { count?: number }): string {
  return f.count && f.count > 1 ? ` (×${f.count})` : '';
}
