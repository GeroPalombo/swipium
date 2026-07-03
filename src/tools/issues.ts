// SWIPIUM Issue Log MCP tools (SWIPIUM-REQ-07). Expose the durable project issue ledger:
//   qa_issue_log          — list current issues + counts + recurrence candidates
//
// Thin wrappers over src/issues/*; heavy logic lives there. Large lists are returned inline but
// compact (issue ids + summaries), with a resource URI for the full index.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import type { SessionStore } from '../session/store.js';
import { queryIssues, type IssueQuery } from '../issues/index.js';
import { issuesResourceUri } from '../issues/store.js';
import { ALL_ISSUE_CATEGORIES, ALL_ISSUE_SEVERITIES, ALL_ISSUE_STATES, type IssueCategory, type IssueSeverity } from '../issues/schema.js';

function nowIso(): string {
  return new Date().toISOString();
}

async function rootFor(
  server: McpServer,
  sessions: SessionStore,
  args: { projectRoot?: string; sessionId?: string },
): Promise<{ root?: string; hint?: string }> {
  if (args.sessionId) {
    const s = sessions.get(args.sessionId);
    if (!s) return { hint: `Unknown sessionId ${args.sessionId}` };
    return { root: s.root };
  }
  const resolved = await resolveProjectRoot(server, args.projectRoot);
  if (!resolved.root) return { hint: resolved.hint };
  return { root: resolved.root };
}

export function registerIssues(server: McpServer, sessions: SessionStore): void {
  // --- qa_issue_log ------------------------------------------------------------------------
  server.registerTool(
    'qa_issue_log',
    {
      title: 'List project issues',
      description:
        'List the durable project issue ledger (`.swipium/issues-log.jsonl`). Returns current issue records, counts by state/category/severity, and recurrence candidates (previously-fixed issues seen again). Filter by state, category, severity, platform, or since (ISO date). Suppressed issues are hidden unless includeSuppressed=true (they stay visible under known-noise in reports either way).',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        state: z.enum(ALL_ISSUE_STATES as [string, ...string[]]).optional(),
        category: z.enum(ALL_ISSUE_CATEGORIES as [string, ...string[]]).optional(),
        severity: z.enum(ALL_ISSUE_SEVERITIES as [string, ...string[]]).optional(),
        platform: z.enum(['ios', 'android', 'web', 'unknown']).optional(),
        since: z.string().optional().describe('ISO timestamp; only issues last seen on/after this.'),
        includeSuppressed: z.boolean().optional(),
      },
    },
    async ({ projectRoot, sessionId, state, category, severity, platform, since, includeSuppressed }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root)
        return qaError({
          what: 'Could not resolve a project root',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Pass projectRoot or sessionId.'],
          clientHint: hint,
        });
      const query: IssueQuery = {
        state: state as IssueQuery['state'],
        category: category as IssueCategory | undefined,
        severity: severity as IssueSeverity | undefined,
        platform: platform as IssueQuery['platform'],
        since,
        includeSuppressed,
      };
      const res = queryIssues(root, nowIso(), query);
      const compact = res.records.map((r) => ({
        issueId: r.issueId,
        state: r.state,
        category: r.category,
        severity: r.severity,
        summary: r.summary,
        lastSeenAt: r.lastSeenAt,
        observationCount: r.observationCount,
        recurrence: r.lastRecurrenceMessage,
        // REQ-08: linked app-map screens/features, test cases, and fix-verification status.
        linkedScreens: r.appMapRefs?.map((a) => a.screenId).filter(Boolean) ?? [],
        linkedFeatures: r.appMapRefs?.map((a) => a.featureId).filter(Boolean) ?? [],
        linkedTestCases: r.testRefs?.map((t) => t.testCaseId) ?? [],
        verifiedFixedAt: r.lastVerifiedFixedAt,
        verificationStatus: r.state === 'fixed' ? (r.lastVerifiedFixedAt ? 'verified_this_history' : 'unverified') : undefined,
      }));
      return qaOk(
        {
          issues: compact,
          counts: res.counts,
          recurrenceCandidates: res.recurrenceCandidates.map((r) => r.issueId),
          resourceUri: issuesResourceUri(root),
        },
        `${res.counts.total} issue(s) — ${Object.entries(res.counts.byState)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}${res.recurrenceCandidates.length ? ` | ${res.recurrenceCandidates.length} recurrence candidate(s)` : ''}`,
      );
    },
  );
}
