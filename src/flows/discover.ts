// Shared flow discovery: list .swipium/flows/*.yaml|*.yml. Used by qa_plan (names → candidate
// workflows) and qa_smoke (paths → run the pack). One source so the two never disagree.

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface FlowFile {
  name: string;
  path: string;
}

export function listFlowFiles(root: string): FlowFile[] {
  const dir = join(root, '.swipium', 'flows');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .map((f) => ({ name: basename(f).replace(/\.ya?ml$/i, ''), path: join(dir, f) }));
  } catch {
    return [];
  }
}
