// Keep Swipium's generated artifacts out of the user's VCS. Called when Swipium writes the app
// map (src/appMap/store.ts) or the issue ledger (src/issues/store.ts), so the first such write
// appends `.swipium/` to the project's .gitignore. `swipium scan` itself does not call this.
// Idempotent; only touches a real git repo's .gitignore (it never runs Git).

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function ensureGitignored(root: string): 'added' | 'present' | 'not-a-repo' {
  try {
    if (!existsSync(join(root, '.git'))) return 'not-a-repo';
    const gi = join(root, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    if (/^\s*\.swipium\/?\s*$/m.test(cur)) return 'present';
    const prefix = cur.length && !cur.endsWith('\n') ? '\n' : '';
    appendFileSync(gi, `${prefix}\n# Swipium QA artifacts (generated)\n.swipium/\n`);
    return 'added';
  } catch {
    return 'not-a-repo'; // best-effort; never block a scan/session on a gitignore write
  }
}
