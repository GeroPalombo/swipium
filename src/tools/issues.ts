// SWIPIUM Issue Log MCP tools (SWIPIUM-REQ-07/08). qa_issue_log is still the only exposed issue
// tool, but it now carries the full ledger lifecycle via `mode`:
//   history (default) — list current issues + counts + recurrence candidates (original behavior)
//   log               — record a new observation (re-observing a fixed fingerprint reopens it)
//   mark_fixed        — transition an issue to fixed (commit/version/how-fixed provenance)
//   verify_fixed      — confirm a fixed issue held, with current-run evidence
//   suppress          — hide expected noise from default history (stays under known-noise);
//                       `suppressedUntil` expires it automatically, `unsuppress:true` lifts it early
//   metrics           — opened/fixed/reopened/verified counts + trends from the event log
//
// Thin wrappers over src/issues/*; heavy logic lives there. Large lists are returned inline but
// compact (issue ids + summaries), with a resource URI for the full index.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import type { SessionStore } from '../session/store.js';
import { makeRedactor } from '../lib/redact.js';
import {
  markFixed,
  markSuppressed,
  markUnsuppressed,
  queryIssues,
  recordObservation,
  verifyFixed,
  type IssueQuery,
} from '../issues/index.js';
import { fingerprintTokens, hasIdentitySignal } from '../issues/fingerprint.js';
import { computeIssueMetrics, type MetricsGroupBy } from '../issues/metrics.js';
import { issuesResourceUri, readEvents } from '../issues/store.js';
import {
  ALL_ISSUE_CATEGORIES,
  ALL_ISSUE_SEVERITIES,
  ALL_ISSUE_STATES,
  type IssueCategory,
  type IssuePlatform,
  type IssueRecord,
  type IssueSeverity,
  type SuppressionScope,
} from '../issues/schema.js';

function nowIso(): string {
  return new Date().toISOString();
}

async function rootFor(
  server: McpServer,
  sessions: SessionStore,
  args: { projectRoot?: string; sessionId?: string },
): Promise<{ root?: string; hint?: string; error?: CallToolResult; appId?: string }> {
  if (args.sessionId) {
    const s = sessions.get(args.sessionId);
    if (!s) return { error: unknownSessionError(args.sessionId) };
    return { root: s.root, appId: s.appId };
  }
  const resolved = await resolveProjectRoot(server, args.projectRoot);
  if (!resolved.root) return { hint: resolved.hint };
  return { root: resolved.root };
}

/** Compact lifecycle view of one record for write-mode responses (undefined fields drop out). */
function lifecycleRecord(r: IssueRecord): Record<string, unknown> {
  return {
    issueId: r.issueId,
    fingerprint: r.fingerprint,
    state: r.state,
    category: r.category,
    severity: r.severity,
    summary: r.summary,
    observationCount: r.observationCount,
    lastSeenAt: r.lastSeenAt,
    fixedAt: r.fixedAt,
    fixedInCommit: r.fixedInCommit,
    fixedInVersion: r.fixedInVersion,
    howFixed: r.howFixed,
    reopenedAt: r.reopenedAt,
    recurrence: r.lastRecurrenceMessage,
    suppressionReason: r.suppressionReason,
    suppressedUntil: r.suppressedUntil,
    stateBeforeSuppression: r.stateBeforeSuppression,
    lastVerifiedFixedAt: r.lastVerifiedFixedAt,
  };
}

/** Free-text qa_issue_log fields persisted to .swipium/issues-log.jsonl. */
const FREE_TEXT_FIELDS = ['title', 'summary', 'howFixed', 'suppressionReason', 'fixedBy'] as const;

function sessionSecrets(sessions: SessionStore, sessionId?: string): Iterable<string> {
  return (sessionId ? sessions.get(sessionId)?.secrets : undefined) ?? [];
}

/** Redact registered session secrets from the agent-supplied free-text fields (exported for tests). */
export function redactIssueArgs<T extends Partial<Record<(typeof FREE_TEXT_FIELDS)[number], string>>>(
  args: T,
  secrets: Iterable<string>,
): T {
  const redact = makeRedactor(secrets);
  const out = { ...args };
  for (const k of FREE_TEXT_FIELDS) {
    const v = out[k];
    if (typeof v === 'string') (out as Record<string, unknown>)[k] = redact(v) ?? v;
  }
  return out;
}

export function registerIssues(server: McpServer, sessions: SessionStore): void {
  // --- qa_issue_log ------------------------------------------------------------------------
  server.registerTool(
    'qa_issue_log',
    {
      title: 'Project issue ledger (list + lifecycle)',
      description:
        'Durable project issue ledger (.swipium/issues-log.jsonl). mode: history (default; list + counts + recurrence, filterable), ' +
        'log (record an observation; identity = normalized title + category + platform; re-observing a fixed issue reopens it), ' +
        'mark_fixed (active issues only), verify_fixed (needs current-run evidence), suppress (suppressedUntil auto-expires; ' +
        'unsuppress:true lifts it), metrics (trends from the event log). Transitions take issueId (or fingerprint).',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        mode: z.enum(['history', 'log', 'mark_fixed', 'verify_fixed', 'suppress', 'metrics']).optional(),
        state: z
          .enum(ALL_ISSUE_STATES as [string, ...string[]])
          .optional()
          .describe('history filter.'),
        category: z
          .enum(ALL_ISSUE_CATEGORIES as [string, ...string[]])
          .optional()
          .describe('history filter; log: category hint.'),
        severity: z
          .enum(ALL_ISSUE_SEVERITIES as [string, ...string[]])
          .optional()
          .describe('history filter; log: severity hint.'),
        platform: z.enum(['ios', 'android', 'web', 'unknown']).optional().describe('history filter; log: platform observed on.'),
        since: z.string().optional().describe('history/metrics: ISO start.'),
        includeSuppressed: z.boolean().optional().describe('history/metrics: include suppressed issues.'),
        issueId: z.string().optional().describe('Transition key (from history).'),
        fingerprint: z.string().optional().describe('Alternative transition key.'),
        title: z.string().optional().describe('log (required): what was observed, descriptive.'),
        summary: z.string().optional().describe('log: one-line summary.'),
        failureCode: z.string().optional().describe('log: typed code (e.g. REDBOX, ANR); sharpens the fingerprint.'),
        evidenceUris: z.array(z.string()).optional().describe('log/verify_fixed: swipium:// evidence URIs.'),
        fixedInCommit: z.string().optional().describe('mark_fixed'),
        fixedInVersion: z.string().optional().describe('mark_fixed'),
        howFixed: z.string().optional().describe('mark_fixed (quoted on recurrence)'),
        fixedBy: z.string().optional().describe('mark_fixed'),
        reportUri: z.string().optional().describe('verify_fixed evidence'),
        testCaseId: z.string().optional().describe('verify_fixed evidence'),
        auditCheckId: z.string().optional().describe('verify_fixed evidence'),
        suppressionReason: z.string().optional().describe('suppress'),
        suppressedUntil: z.string().optional().describe('suppress: ISO expiry (then the issue returns to its prior state).'),
        unsuppress: z.boolean().optional().describe('suppress: lift an existing suppression now.'),
        suppressionScope: z.enum(['fingerprint', 'platform', 'environment', 'appVersion']).optional().describe('suppress'),
        until: z.string().optional().describe('metrics: ISO end; suppress: alias of suppressedUntil.'),
        groupBy: z
          .enum(['day', 'week', 'version', 'commit', 'category', 'owner', 'screen', 'feature'])
          .optional()
          .describe('metrics bucketing (default week).'),
      },
    },
    async (rawArgs) => {
      // The ledger is a committed repo file: scrub every registered session secret (typed
      // passwords, OTPs, secret flow variables) out of agent-supplied free text before it lands.
      const args = redactIssueArgs(rawArgs, sessionSecrets(sessions, rawArgs.sessionId));
      const { root, hint, appId, error } = await rootFor(server, sessions, { projectRoot: args.projectRoot, sessionId: args.sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });
      const mode = args.mode ?? 'history';
      const now = nowIso();

      // --- log: record a new observation (may reopen a previously fixed issue) ---------------
      if (mode === 'log') {
        if (!args.title && !args.summary)
          return qaError({
            what: 'mode "log" needs a title (and ideally a summary) describing what was observed',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass title and summary; optionally category, severity, platform, failureCode, evidenceUris.'],
          });
        const title = (args.title ?? args.summary!).trim();
        // Identity: the normalized title rides the fingerprint's `text:` token (the same token the
        // report bridge uses for visible text), plus category/platform/app scope — so two different
        // defects logged on one platform are two issues, and re-logging the same title matches.
        const observation = {
          title,
          summary: args.summary ?? title,
          failureCode: args.failureCode,
          visibleText: title.replace(/[\s.!?…:;,]+$/u, ''),
        };
        // The `app:` token is NEVER part of a manual entry's identity: the ledger is already
        // project-scoped, and appId is only known when a sessionId was passed — including it made
        // the same title logged via sessionId vs via projectRoot two different issues. appId is
        // still stored on the event as metadata. (Pre-1.6 manual issues keep their old
        // platform-only fingerprint; they are never auto-merged — close them via mark_fixed/suppress.)
        const meta = {
          appId,
          fingerprintWithoutAppId: true,
          fingerprintCategory: args.category as IssueCategory | undefined,
          platform: args.platform as IssuePlatform | undefined,
          links: args.evidenceUris?.length ? { evidenceRefs: args.evidenceUris.map((uri) => ({ kind: 'evidence', uri })) } : undefined,
        };
        if (
          !hasIdentitySignal(
            fingerprintTokens({
              ...meta,
              appId: undefined,
              category: meta.fingerprintCategory,
              failureCode: args.failureCode,
              observation,
            }),
          )
        )
          return qaError({
            failureCode: 'ISSUE_LOG_TOO_VAGUE',
            what: `The title "${title}" has no identifying words once ids/numbers are scrubbed — it would merge with unrelated issues`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Use a descriptive title (what broke, where), or pass failureCode.'],
          });
        const res = recordObservation(
          root,
          observation,
          now,
          { categoryHint: args.category as IssueCategory | undefined, severityHint: args.severity as IssueSeverity | undefined },
          meta,
        );
        return qaOk(
          {
            mode,
            issue: lifecycleRecord(res.record),
            issueId: res.issueId,
            fingerprint: res.fingerprint,
            isNew: res.isNew,
            reopened: res.reopened,
            recurrenceMessage: res.recurrenceMessage,
            resourceUri: issuesResourceUri(root),
          },
          res.reopened
            ? `Reopened ${res.issueId} — ${res.recurrenceMessage}`
            : `${res.isNew ? 'Logged new' : 'Updated'} issue ${res.issueId} (${res.record.state}, ${res.record.category}/${res.record.severity})`,
        );
      }

      // --- metrics: trends computed from the full event log -----------------------------------
      if (mode === 'metrics') {
        const m = computeIssueMetrics(readEvents(root), {
          since: args.since,
          until: args.until,
          groupBy: args.groupBy as MetricsGroupBy | undefined,
          includeSuppressed: args.includeSuppressed,
        });
        return qaOk(
          {
            mode,
            metrics: {
              ...m,
              topRecurringIssues: m.topRecurringIssues.map(lifecycleRecord),
              topAgingIssues: m.topAgingIssues.map(lifecycleRecord),
            },
            resourceUri: issuesResourceUri(root),
          },
          `Issue metrics — opened=${m.opened} fixed=${m.fixed} reopened=${m.reopened} verifiedFixed=${m.verifiedFixed} suppressed=${m.suppressed} reopenRate=${m.reopenRatePct}% fixVerification=${m.fixVerificationRatePct}%`,
        );
      }

      // --- mark_fixed / verify_fixed / suppress: lifecycle transitions on an existing issue ---
      if (mode === 'mark_fixed' || mode === 'verify_fixed' || mode === 'suppress') {
        const key = { issueId: args.issueId, fingerprint: args.fingerprint };
        if (!key.issueId && !key.fingerprint)
          return qaError({
            what: `mode "${mode}" needs the issue key`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass issueId (or fingerprint) from mode "history".'],
          });
        const suppressedUntil = args.suppressedUntil ?? args.until;
        if (mode === 'suppress' && !args.unsuppress && suppressedUntil !== undefined && !Number.isFinite(Date.parse(suppressedUntil)))
          return qaError({
            failureCode: 'INVALID_ARGUMENT',
            what: `suppressedUntil "${suppressedUntil}" is not an ISO timestamp`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass an ISO timestamp such as 2026-12-31T00:00:00Z, or omit it for an open-ended suppression.'],
          });
        const res =
          mode === 'suppress' && args.unsuppress
            ? markUnsuppressed(root, key, now)
            : mode === 'mark_fixed'
              ? markFixed(
                  root,
                  key,
                  {
                    fixedInCommit: args.fixedInCommit,
                    fixedInVersion: args.fixedInVersion,
                    howFixed: args.howFixed,
                    fixedBy: args.fixedBy,
                  },
                  now,
                )
              : mode === 'verify_fixed'
                ? verifyFixed(
                    root,
                    key,
                    {
                      reportUri: args.reportUri,
                      testCaseId: args.testCaseId,
                      auditCheckId: args.auditCheckId,
                      evidenceUris: args.evidenceUris,
                    },
                    now,
                  )
                : markSuppressed(
                    root,
                    key,
                    {
                      suppressionReason: args.suppressionReason,
                      suppressedUntil,
                      suppressionScope: args.suppressionScope as SuppressionScope | undefined,
                    },
                    now,
                  );
        if (!res.ok || !res.record)
          return qaError({
            failureCode: res.code,
            what: res.reason ?? `Could not apply ${mode}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Check the issue key with mode "history" (includeSuppressed=true shows suppressed issues).'],
          });
        const r = res.record;
        const summary =
          mode === 'mark_fixed'
            ? `Marked ${r.issueId} fixed${r.fixedInCommit ? ` in ${r.fixedInCommit}` : ''}`
            : mode === 'verify_fixed'
              ? `Verified fix for ${r.issueId} with current-run evidence`
              : args.unsuppress
                ? `Unsuppressed ${r.issueId} (now ${r.state})`
                : `Suppressed ${r.issueId}${r.suppressionReason ? ` — ${r.suppressionReason}` : ''} (hidden from default history${r.suppressedUntil ? ` until ${r.suppressedUntil}` : ''}; still visible under known-noise)`;
        return qaOk({ mode, issue: lifecycleRecord(r), resourceUri: issuesResourceUri(root) }, summary);
      }

      // --- history (default): the original query/list behavior --------------------------------
      const query: IssueQuery = {
        state: args.state as IssueQuery['state'],
        category: args.category as IssueCategory | undefined,
        severity: args.severity as IssueSeverity | undefined,
        platform: args.platform as IssueQuery['platform'],
        since: args.since,
        includeSuppressed: args.includeSuppressed,
      };
      const res = queryIssues(root, now, query);
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
