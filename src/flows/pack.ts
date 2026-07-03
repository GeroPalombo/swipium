// Flow packs (NEXT-PLAN: Flow System V2). A pack (.swipium/packs/*.yaml) names an ordered set of
// flows to run as one release suite. v1 runs them sequentially on the one attached device
// (parallel:true is accepted but ignored with a warning — parallel on a single device is unsafe).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseFlow } from './schema.js';
import { runFlow, type FlowRunResult } from './run.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore } from '../session/store.js';

export interface Pack {
  name: string;
  flows: string[];
  parallel: boolean;
}

export interface ParsePackResult {
  pack?: Pack;
  errors: string[];
}

export function parsePack(yamlText: string): ParsePackResult {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    return { errors: [`YAML parse error: ${String((e as Error).message ?? e)}`] };
  }
  if (!doc || typeof doc !== 'object') return { errors: ['pack must be a YAML map with name + flows.'] };
  const d = doc as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof d.name !== 'string' || !d.name.trim()) errors.push('pack needs a non-empty `name`.');
  if (!Array.isArray(d.flows) || d.flows.length === 0 || !d.flows.every((f) => typeof f === 'string'))
    errors.push('pack needs a non-empty `flows` list of flow names.');
  if (errors.length) return { errors };
  return { pack: { name: d.name as string, flows: d.flows as string[], parallel: d.parallel === true }, errors: [] };
}

export function listPackFiles(root: string): Array<{ name: string; path: string }> {
  const dir = join(root, '.swipium', 'packs');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .map((f) => ({ name: basename(f).replace(/\.ya?ml$/i, ''), path: join(dir, f) }));
  } catch {
    return [];
  }
}

function flowPath(root: string, name: string): string | null {
  for (const p of [join(root, '.swipium', 'flows', `${name}.yaml`), join(root, '.swipium', 'flows', `${name}.yml`)])
    if (existsSync(p)) return p;
  return null;
}

export interface PackRunResult {
  pack: string;
  parallelRequested: boolean;
  results: FlowRunResult[];
  passed: boolean;
  warnings: string[];
}

export async function runPack(
  sessions: SessionStore,
  session: Session,
  driver: Driver,
  root: string,
  pack: Pack,
  opts: { variables?: Record<string, string> } = {},
): Promise<PackRunResult> {
  const warnings: string[] = [];
  if (pack.parallel) warnings.push('parallel:true ignored — flows run sequentially on a single device (parallel needs a device matrix).');
  const results: FlowRunResult[] = [];
  for (const name of pack.flows) {
    const p = flowPath(root, name);
    if (!p) {
      results.push({
        name,
        passed: false,
        reason: `flow not found: ${name}`,
        failureCode: 'NO_ARTIFACT',
        steps: [],
        durationMs: 0,
        counters: session.counters,
      });
      continue;
    }
    const { flow, errors } = parseFlow(readFileSync(p, 'utf8'));
    if (errors.length || !flow) {
      results.push({
        name,
        passed: false,
        reason: `invalid flow: ${errors[0] ?? 'parse error'}`,
        failureCode: 'UNKNOWN',
        steps: [],
        durationMs: 0,
        counters: session.counters,
      });
      continue;
    }
    results.push(await runFlow(sessions, session, driver, flow, opts));
  }
  return { pack: pack.name, parallelRequested: pack.parallel, results, passed: results.every((r) => r.passed), warnings };
}
