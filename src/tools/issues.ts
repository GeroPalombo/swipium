// SWIPIUM Issue Log MCP tools (SWIPIUM-REQ-07). Expose the durable project issue ledger:
//   qa_issue_log         — list current issues + counts + recurrence candidates
//   qa_issue_history     — the append-only event trail for one issue
//   qa_issue_mark_fixed  — record a fix (date, commit, version, how-fixed) for regression detection
//   qa_issue_triage      — change category / severity / owner / note
//   qa_issue_suppress    — suppress known noise (stays visible under known-noise, never hidden)
//
// Thin wrappers over src/issues/*; heavy logic lives there. Large lists are returned inline but
// compact (issue ids + summaries), with a resource URI for the full index.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import type { SessionStore } from '../session/store.js';
import {
  markFixed,
  queryIssues,
  suppressIssue,
  triageIssue,
  verifyFixed,
  type IssueQuery,
} from '../issues/index.js';
import { computeIssueMetrics, type MetricsGroupBy } from '../issues/metrics.js';
import { issuesResourceUri, readEvents } from '../issues/store.js';
import { resolveSourceRevision } from '../issues/sourceRevision.js';
import { loadPolicy } from '../issues/store.js';
import {
  ALL_ISSUE_CATEGORIES,
  ALL_ISSUE_SEVERITIES,
  ALL_ISSUE_STATES,
  type IssueCategory,
  type IssueOwner,
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

const KEY_SCHEMA = {
  issueId: z.string().optional().describe('Issue id (iss_…). Provide this OR fingerprint.'),
  fingerprint: z.string().optional().describe('Issue fingerprint (sha256:…). Provide this OR issueId.'),
};

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
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
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
        { issues: compact, counts: res.counts, recurrenceCandidates: res.recurrenceCandidates.map((r) => r.issueId), resourceUri: issuesResourceUri(root) },
        `${res.counts.total} issue(s) — ${Object.entries(res.counts.byState).map(([k, v]) => `${k}=${v}`).join(' ')}${res.recurrenceCandidates.length ? ` | ${res.recurrenceCandidates.length} recurrence candidate(s)` : ''}`,
      );
    },
  );

  // --- qa_issue_history --------------------------------------------------------------------
  server.registerTool(
    'qa_issue_history',
    {
      title: 'Issue event history',
      description: 'Return the append-only event trail (observed / classified / triaged / fixed / reopened / suppressed) for one issue, so you can audit why it is currently open, fixed, reopened, or suppressed.',
      inputSchema: { projectRoot: z.string().optional(), sessionId: z.string().optional(), ...KEY_SCHEMA },
    },
    async ({ projectRoot, sessionId, issueId, fingerprint }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      if (!issueId && !fingerprint) return qaError({ what: 'Provide issueId or fingerprint', changedState: false, retrySafe: true, nextSteps: ['Re-call with issueId or fingerprint (from qa_issue_log).'] });
      const events = readEvents(root).filter((e) => (issueId && e.issueId === issueId) || (fingerprint && e.fingerprint === fingerprint));
      if (events.length === 0) return qaError({ what: `No events for ${issueId ?? fingerprint}`, changedState: false, retrySafe: true, nextSteps: ['Check the id via qa_issue_log.'] });
      return qaOk({ issueId: events[0].issueId, fingerprint: events[0].fingerprint, events }, `${events.length} event(s) for ${events[0].issueId}`);
    },
  );

  // --- qa_issue_mark_fixed -----------------------------------------------------------------
  server.registerTool(
    'qa_issue_mark_fixed',
    {
      title: 'Mark an issue fixed',
      description: 'Record that a developer fixed an issue: appends a `fixed` event with date, commit, version, how-fixed note, and fixedBy, then updates the derived index to state=fixed. Previous observations are NEVER deleted. If the same fingerprint is observed again later, the issue is reopened with a recurrence message that cites this fix metadata.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        ...KEY_SCHEMA,
        fixedInCommit: z.string().optional().describe('Commit sha the fix landed in. Defaults from sourceRevision/CI env when omitted.'),
        fixedInVersion: z.string().optional(),
        howFixed: z.string().optional().describe('Plain-language note: what changed.'),
        fixedBy: z.string().optional(),
      },
    },
    async ({ projectRoot, sessionId, issueId, fingerprint, fixedInCommit, fixedInVersion, howFixed, fixedBy }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      if (!issueId && !fingerprint) return qaError({ what: 'Provide issueId or fingerprint', changedState: false, retrySafe: true, nextSteps: ['Re-call with issueId or fingerprint.'] });
      const policy = loadPolicy(root);
      const sourceRevision = resolveSourceRevision({ env: process.env, allowGitMetadataRead: policy.allowGitMetadataRead, root, explicit: fixedInCommit ? { provider: 'explicit', commit: fixedInCommit } : undefined });
      const res = markFixed(root, { issueId, fingerprint }, { fixedInCommit, fixedInVersion, howFixed, fixedBy, sourceRevision }, nowIso());
      if (!res.ok) return qaError({ what: res.reason ?? 'mark-fixed failed', changedState: false, retrySafe: true, nextSteps: ['Confirm the issueId/fingerprint via qa_issue_log.'] });
      return qaOk({ record: res.record, resourceUri: issuesResourceUri(root) }, `marked ${res.record!.issueId} fixed${res.record!.fixedInCommit ? ` in ${res.record!.fixedInCommit}` : ''}`);
    },
  );

  // --- qa_issue_triage ---------------------------------------------------------------------
  server.registerTool(
    'qa_issue_triage',
    {
      title: 'Triage an issue',
      description: 'Change an issue\'s category, severity, owner, or add a note. Appends a `triaged` event (append-only audit trail).',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        ...KEY_SCHEMA,
        category: z.enum(ALL_ISSUE_CATEGORIES as [string, ...string[]]).optional(),
        severity: z.enum(ALL_ISSUE_SEVERITIES as [string, ...string[]]).optional(),
        owner: z.enum(['app', 'backend', 'test_env', 'mcp', 'unknown']).optional(),
        note: z.string().optional(),
      },
    },
    async ({ projectRoot, sessionId, issueId, fingerprint, category, severity, owner, note }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      if (!issueId && !fingerprint) return qaError({ what: 'Provide issueId or fingerprint', changedState: false, retrySafe: true, nextSteps: ['Re-call with issueId or fingerprint.'] });
      const res = triageIssue(root, { issueId, fingerprint }, { category: category as IssueCategory | undefined, severity: severity as IssueSeverity | undefined, owner: owner as IssueOwner | undefined, note }, nowIso());
      if (!res.ok) return qaError({ what: res.reason ?? 'triage failed', changedState: false, retrySafe: true, nextSteps: ['Confirm the issueId/fingerprint via qa_issue_log.'] });
      return qaOk({ record: res.record }, `triaged ${res.record!.issueId} → ${res.record!.category}/${res.record!.severity}`);
    },
  );

  // --- qa_issue_suppress -------------------------------------------------------------------
  server.registerTool(
    'qa_issue_suppress',
    {
      title: 'Suppress known noise',
      description: 'Suppress a known-noise issue with a reason and optional expiration. Suppressed issues are moved OUT of blockers but REMAIN VISIBLE in reports under known-noise — they are never silently hidden.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        ...KEY_SCHEMA,
        reason: z.string().describe('Why this is known noise.'),
        until: z.string().optional().describe('ISO timestamp the suppression expires.'),
        scope: z.enum(['fingerprint', 'platform', 'environment', 'appVersion']).optional(),
      },
    },
    async ({ projectRoot, sessionId, issueId, fingerprint, reason, until, scope }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      if (!issueId && !fingerprint) return qaError({ what: 'Provide issueId or fingerprint', changedState: false, retrySafe: true, nextSteps: ['Re-call with issueId or fingerprint.'] });
      const res = suppressIssue(root, { issueId, fingerprint }, { reason, until, scope: scope as SuppressionScope | undefined }, nowIso());
      if (!res.ok) return qaError({ what: res.reason ?? 'suppress failed', changedState: false, retrySafe: true, nextSteps: ['Confirm the issueId/fingerprint via qa_issue_log.'] });
      return qaOk({ record: res.record }, `suppressed ${res.record!.issueId} (${reason}) — still visible under known-noise`);
    },
  );

  // --- qa_issue_verify_fixed ---------------------------------------------------------------
  server.registerTool(
    'qa_issue_verify_fixed',
    {
      title: 'Verify a fixed issue with evidence',
      description:
        'Link a passing test/audit result to a FIXED issue and record `verified_fixed` evidence. Requires the issue to be in state "fixed" AND current-run evidence (a reportUri, testCaseId, auditCheckId, or evidenceUris) — a fix cannot be claimed verified without proof. After this, reports may list the issue under "fixed issues verified this run". A reappearance still reopens it with recurrence text.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        ...KEY_SCHEMA,
        testCaseId: z.string().optional(),
        auditCheckId: z.string().optional(),
        reportUri: z.string().optional(),
        evidenceUris: z.array(z.string()).optional(),
        note: z.string().optional(),
      },
    },
    async ({ projectRoot, sessionId, issueId, fingerprint, testCaseId, auditCheckId, reportUri, evidenceUris, note }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      if (!issueId && !fingerprint) return qaError({ what: 'Provide issueId or fingerprint', changedState: false, retrySafe: true, nextSteps: ['Re-call with issueId or fingerprint.'] });
      const res = verifyFixed(root, { issueId, fingerprint }, { testCaseId, auditCheckId, reportUri, evidenceUris, note }, nowIso());
      if (!res.ok) return qaError({ what: res.reason ?? 'verify-fixed failed', changedState: false, retrySafe: true, nextSteps: ['Mark the issue fixed first (qa_issue_mark_fixed), and provide current-run evidence.'] });
      return qaOk({ record: res.record }, `verified ${res.record!.issueId} fixed with current-run evidence`);
    },
  );

  // --- qa_issue_metrics --------------------------------------------------------------------
  server.registerTool(
    'qa_issue_metrics',
    {
      title: 'Issue quality metrics',
      description:
        'Project-level issue quality metrics derived from the append-only event log: opened/fixed/reopened/verified-fixed counts, issue aging (avg + p95), reopen rate (fixed issues that later reopened), fix-verification rate (fixed issues with verified_fixed evidence), open blocker/high counts, top recurring + aging issues, and a time/version/category series. Answers "is the product improving?".',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        since: z.string().optional().describe('ISO start of the window.'),
        until: z.string().optional().describe('ISO end of the window (defaults to the latest event).'),
        groupBy: z.enum(['day', 'week', 'version', 'commit', 'category', 'owner', 'screen', 'feature']).optional().describe('Series bucket (default week).'),
        includeSuppressed: z.boolean().optional(),
      },
    },
    async ({ projectRoot, sessionId, since, until, groupBy, includeSuppressed }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot or sessionId.'], clientHint: hint });
      const metrics = computeIssueMetrics(readEvents(root), { since, until, groupBy: groupBy as MetricsGroupBy | undefined, includeSuppressed });
      return qaOk(
        { metrics, resourceUri: issuesResourceUri(root) },
        `issue metrics: opened=${metrics.opened} fixed=${metrics.fixed} reopened=${metrics.reopened} verifiedFixed=${metrics.verifiedFixed} | reopenRate=${metrics.reopenRatePct}% fixVerify=${metrics.fixVerificationRatePct}% | openBlocker=${metrics.blockerOpenCount} openHigh=${metrics.highOpenCount}`,
      );
    },
  );
}
