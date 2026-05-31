// Keep Swipium's generated artifacts out of the user's VCS. Both `swipium scan` and every
// session (which writes .swipium/<id>/…) call this, so merely using Swipium never dirties a
// developer's git tree. Idempotent; only touches a real git repo's .gitignore.

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
