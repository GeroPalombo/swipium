// Fixture loading + persistence shape. Fixture VALUES (field values, legacy `value`) and seed
// specs (argv / URLs / headers / bodies — often tokens) are live configuration that must never be
// written to state.json: a redacted copy reloaded as config would type «redacted» into a password
// field or run a seed with a broken token. state.json keeps only non-secret metadata (for reports);
// a rehydrated session re-reads the real fixtures from <root>/.swipium/fixtures.json.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fixture } from '../session/store.js';

/** Load declared fixtures from <root>/.swipium/fixtures.json (best-effort, array or {fixtures:[]}). */
export function loadProjectFixtures(root: string): Fixture[] {
  const p = join(root, '.swipium', 'fixtures.json');
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.fixtures) ? raw.fixtures : [];
    return arr.filter((f: unknown) => f && typeof (f as Fixture).name === 'string') as Fixture[];
  } catch {
    return [];
  }
}

/** state.json form of a fixture: names/labels/field specs kept, every value and the seed dropped. */
export function fixtureMetadata(fixtures: Fixture[]): Fixture[] {
  return fixtures.map((f) => {
    const { value: _value, seed: _seed, fields, ...rest } = f;
    const out: Fixture = { ...rest };
    if (fields && typeof fields === 'object') {
      out.fields = Object.fromEntries(
        Object.entries(fields).map(([k, spec]) => {
          const { value: _v, ...meta } = spec ?? {};
          return [k, meta];
        }),
      );
    }
    return out;
  });
}

/** Fixtures for a session reloaded from state.json: the project's fixtures.json is the source of
 *  truth for live values; persisted metadata only fills in fixtures no longer in the file (e.g.
 *  ones passed to qa_start_session) — value-less, so they never supply redacted text as input. */
export function rehydrateFixtures(root: string | undefined, persisted: unknown): Fixture[] {
  const fromFile = typeof root === 'string' ? loadProjectFixtures(root) : [];
  const byName = new Map<string, Fixture>();
  for (const f of fromFile) byName.set(f.name, f);
  const meta = Array.isArray(persisted) ? fixtureMetadata(persisted.filter((f) => f && typeof f.name === 'string') as Fixture[]) : [];
  for (const f of meta) if (!byName.has(f.name)) byName.set(f.name, f);
  return [...byName.values()];
}
