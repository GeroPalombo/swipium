// Ground-truth gathering for feature scope (SWIPIUM-REQ-03 "Feature Scope Model" sources). Reads the
// durable, on-disk Swipium artifacts so the pure scope ranker has runtime screens + existing tests to
// search: the latest exploration screen graph (runtime nodes) and authored flows / generated test
// cases. Best-effort and defensive — a malformed file is skipped, never fatal.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SerializedGraph } from '../explore/graph.js';
import type { RuntimeScreenInput, TestCaseRef } from './featureScope.js';

/** Map a serialized exploration graph's nodes into the runtime-screen inputs the ranker searches. */
export function runtimeScreensFromGraph(graph: SerializedGraph | undefined): RuntimeScreenInput[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    route: n.urlOrRoute,
    text: n.elements.map((e) => `${e.label ?? ''} ${e.locator?.value ?? ''}`).join(' ').trim() || undefined,
  }));
}

/** Read + parse the latest exploration graph JSON from a known artifact file path. */
export function loadGraphFromFile(path: string | undefined): SerializedGraph | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SerializedGraph;
  } catch {
    return undefined;
  }
}

/** Gather existing tests Swipium already knows about: generated test cases + authored flows. */
export function gatherExistingTests(root: string): TestCaseRef[] {
  const out: TestCaseRef[] = [];
  const seen = new Set<string>();
  const add = (ref: TestCaseRef) => {
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    out.push(ref);
  };

  // .swipium/testcases/*.{yaml,yml,json} → { cases: [{ id, title }] }
  const tcDir = join(root, '.swipium', 'testcases');
  if (existsSync(tcDir)) {
    for (const name of safeReaddir(tcDir)) {
      const ext = extname(name).toLowerCase();
      if (!['.yaml', '.yml', '.json'].includes(ext)) continue;
      const path = join(tcDir, name);
      try {
        const text = readFileSync(path, 'utf8');
        const doc = ext === '.json' ? JSON.parse(text) : parseYaml(text);
        const cases = (doc?.cases ?? doc) as Array<{ id?: string; title?: string }> | undefined;
        if (Array.isArray(cases)) {
          for (const c of cases) {
            if (!c?.id && !c?.title) continue;
            add({ id: c.id ?? c.title!, title: c.title ?? c.id!, source: 'testcase', path });
          }
        }
      } catch {
        /* skip malformed */
      }
    }
  }

  // .swipium/flows/*.{yaml,yml} → flow name (file + `name:` field)
  const flowsDir = join(root, '.swipium', 'flows');
  if (existsSync(flowsDir)) {
    for (const name of safeReaddir(flowsDir)) {
      const ext = extname(name).toLowerCase();
      if (!['.yaml', '.yml'].includes(ext)) continue;
      const path = join(flowsDir, name);
      const base = basename(name, ext);
      let title = base;
      try {
        const doc = parseYaml(readFileSync(path, 'utf8')) as { name?: string } | undefined;
        if (doc?.name) title = doc.name;
      } catch {
        /* use filename */
      }
      add({ id: `flow:${base}`, title, source: 'flow', path });
    }
  }

  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
