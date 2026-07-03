import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExploreSummary } from './runner.js';
import type { SerializedGraph } from './graph.js';

export interface ExploreMemoryEntry {
  appId: string;
  sessionId: string;
  at: string;
  graphUri?: string;
  graphMdUri?: string;
  stoppedReason: string;
  state: 'completed' | 'blocked' | 'needs_input';
  summary: ExploreSummary;
  tasks: SerializedGraph['tasks'];
  hypotheses: string[];
  coverageClaims: SerializedGraph['coverageClaims'];
  blockedPreconditions: string[];
  reflection?: SerializedGraph['reflection'];
}

export interface ExploreMemory {
  schemaVersion: 1;
  appId: string;
  entries: ExploreMemoryEntry[];
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 120) || 'unknown-app'
  );
}

export function exploreHistoryPath(root: string, appId?: string): string {
  return join(root, '.swipium', 'explore-history', `${safeName(appId ?? 'unknown-app')}.json`);
}

export function loadExploreMemory(root: string, appId?: string): ExploreMemory {
  const path = exploreHistoryPath(root, appId);
  if (!existsSync(path)) return { schemaVersion: 1, appId: appId ?? 'unknown-app', entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExploreMemory;
    return {
      schemaVersion: 1,
      appId: parsed.appId ?? appId ?? 'unknown-app',
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { schemaVersion: 1, appId: appId ?? 'unknown-app', entries: [] };
  }
}

export function appendExploreMemory(root: string, appId: string | undefined, entry: ExploreMemoryEntry): string {
  const path = exploreHistoryPath(root, appId);
  const memory = loadExploreMemory(root, appId);
  memory.appId = appId ?? 'unknown-app';
  memory.entries.push(entry);
  memory.entries = memory.entries.slice(-50);
  mkdirSync(join(root, '.swipium', 'explore-history'), { recursive: true });
  writeFileSync(path, JSON.stringify(memory, null, 2));
  return path;
}
