// SWIPIUM Issue Log — source revision resolution (SWIPIUM-REQ-07 "Source revision").
//
// Fix attribution is strongest when issues link to a commit/release. But Swipium intentionally does
// NOT execute Git in spawned providers. So we resolve a SourceRevision in priority order WITHOUT
// running Git: explicit input → CI environment variables → app build metadata → optional read-only
// `.git/HEAD` (only when policy sets allowGitMetadataRead). `unknown` is always an acceptable result.
//
// PURE w.r.t. process state except the optional read-only git read, which only touches `.git/HEAD`
// and a ref file (never executes a binary). The env map is injected so this stays unit-testable.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceRevision } from './schema.js';

export interface AppBuildMeta {
  buildVersion?: string;
  buildNumber?: string;
  artifactHash?: string;
}

export interface ResolveSourceRevisionOptions {
  explicit?: SourceRevision;
  env?: NodeJS.ProcessEnv;
  appBuild?: AppBuildMeta;
  allowGitMetadataRead?: boolean;
  root?: string;
}

/** Resolve from CI environment variables (GitHub Actions / GitLab / Bitbucket). */
export function fromCiEnv(env: NodeJS.ProcessEnv): SourceRevision | null {
  if (env.GITHUB_SHA) {
    return {
      provider: 'github_actions',
      commit: env.GITHUB_SHA,
      branch: env.GITHUB_REF_NAME,
      runUrl:
        env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
          : undefined,
    };
  }
  if (env.CI_COMMIT_SHA) {
    return {
      provider: 'gitlab_ci',
      commit: env.CI_COMMIT_SHA,
      branch: env.CI_COMMIT_REF_NAME,
      runUrl: env.CI_PIPELINE_URL,
    };
  }
  if (env.BITBUCKET_COMMIT) {
    return {
      provider: 'bitbucket_ci',
      commit: env.BITBUCKET_COMMIT,
      branch: env.BITBUCKET_BRANCH,
    };
  }
  return null;
}

/** Read-only `.git/HEAD` resolution. NEVER executes git; only reads ref files. */
export function fromGitReadonly(root: string): SourceRevision | null {
  try {
    const headPath = join(root, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf8').trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (refMatch) {
      const ref = refMatch[1].trim();
      const branch = ref.replace(/^refs\/heads\//, '');
      const refPath = join(root, '.git', ref);
      let commit: string | undefined;
      if (existsSync(refPath)) {
        commit = readFileSync(refPath, 'utf8').trim();
      } else {
        // packed-refs fallback
        const packed = join(root, '.git', 'packed-refs');
        if (existsSync(packed)) {
          const line = readFileSync(packed, 'utf8')
            .split('\n')
            .find((l) => l.endsWith(` ${ref}`));
          if (line) commit = line.split(' ')[0];
        }
      }
      return { provider: 'git_readonly', commit, branch };
    }
    // detached HEAD: the file is the commit sha itself
    if (/^[0-9a-f]{7,40}$/i.test(head)) return { provider: 'git_readonly', commit: head };
    return null;
  } catch {
    return null;
  }
}

export function fromAppBuild(meta: AppBuildMeta): SourceRevision | null {
  if (!meta.buildVersion && !meta.buildNumber && !meta.artifactHash) return null;
  return { provider: 'app_build', buildVersion: meta.buildVersion, buildNumber: meta.buildNumber, artifactHash: meta.artifactHash };
}

/** Resolve a SourceRevision in the documented priority order. Always returns a value. */
export function resolveSourceRevision(opts: ResolveSourceRevisionOptions = {}): SourceRevision {
  // 1. explicit input wins (mark provider explicit unless the caller already set one).
  if (opts.explicit && (opts.explicit.commit || opts.explicit.buildVersion || opts.explicit.tag)) {
    return { ...opts.explicit, provider: opts.explicit.provider ?? 'explicit' };
  }
  // 2. CI environment.
  const ci = fromCiEnv(opts.env ?? {});
  if (ci) return ci;
  // 3. app build metadata.
  if (opts.appBuild) {
    const ab = fromAppBuild(opts.appBuild);
    if (ab) return ab;
  }
  // 4. optional read-only git, only behind policy.
  if (opts.allowGitMetadataRead && opts.root) {
    const git = fromGitReadonly(opts.root);
    if (git) return git;
  }
  return { provider: 'unknown' };
}
