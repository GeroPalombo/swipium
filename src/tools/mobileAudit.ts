// SWIPIUM Mobile QA Toolkit MCP tool (SWIPIUM-REQ-07). qa_mobile_audit turns a named profile
// (smoke | account_cycle | store_compliance | resilience | release_gate) into an ordered, classified
// checklist plus the account-cycle safety contract the agent executes with the existing driver tools.
// It also surfaces the issue-ledger recurrence state so a release gate sees regressions. Thin wrapper
// over src/mobileAudit/* and src/issues/*.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';
import { accountCycleSafety, checksForProfile, ALL_PROFILES, type AuditProfile } from '../mobileAudit/profiles.js';
import { runMobileAudit } from '../mobileAudit/runner.js';
import { auditRunToMarkdown } from '../mobileAudit/results.js';
import { generateSessionReport } from '../services/report.js';
import { queryIssues } from '../issues/index.js';
import { issuesResourceUri } from '../issues/store.js';
import { resolveSourceRevision } from '../issues/sourceRevision.js';
import { loadPolicy } from '../issues/store.js';

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

export function registerMobileAudit(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_mobile_audit',
    {
      title: 'Mobile QA release audit',
      description:
        'USE WHEN asked for a release-readiness, store-compliance, or account-lifecycle audit: plan or execute a named mobile-QA audit profile. mode:"plan" (default) returns the ordered checklist + safety contract WITHOUT driving the device; mode:"execute" requires a sessionId with a prepared device, drives every check, records issue-ledger entries with evidence for fail/blocked checks, and returns per-check results + a release-impact decision (+ best-effort report URI). Profile meanings and the safety contract are documented on the `profile` and `allowGeneratedData` params. A check never reports pass without observed evidence.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        profile: z
          .enum(ALL_PROFILES as [string, ...string[]])
          .describe(
            'Audit profile: smoke (launch/health/nav) · account_cycle (create → logout → login-again → forgot-password on a DISPOSABLE generated account; needs allowGeneratedData) · store_compliance (privacy/terms/account-deletion/subscription/paywall) · resilience (offline/restore/relaunch/rotation — network is always restored) · release_gate (all profiles + locator readiness + issue-ledger recurrence).',
          ),
        mode: z
          .enum(['plan', 'execute'])
          .optional()
          .describe(
            'plan (default): return the ordered checklist (expected behavior + report classification), the account-cycle safety contract, and an `executor` handoff — no device is touched. execute: drive the audit against the attached device, record issues + evidence, and return per-check MobileAuditCheckResults + release impact.',
          ),
        allowGeneratedData: z
          .boolean()
          .optional()
          .describe(
            'Permit safe generated disposable-account data (test/staging only). Safety contract: logout is permitted only inside the controlled account-cycle workflow on the disposable account; delete/pay/send stay refused; a real account is never deleted; OTP/MFA returns needs_input.',
          ),
        allowTestAccountDeletion: z
          .boolean()
          .optional()
          .describe('Permit destructive cleanup of disposable test accounts only (never a real account).'),
        offlineMode: z.boolean().optional().describe('Hint that resilience checks should drive offline state.'),
        sourceRevision: z
          .object({ commit: z.string().optional(), buildVersion: z.string().optional(), branch: z.string().optional() })
          .optional(),
        targetApp: z.string().optional(),
        waitForCompletion: z
          .boolean()
          .optional()
          .describe('Reserved; execute currently always runs to completion and returns the full result.'),
      },
    },
    async ({
      projectRoot,
      sessionId,
      profile,
      mode,
      allowGeneratedData,
      allowTestAccountDeletion,
      offlineMode,
      sourceRevision,
      targetApp,
    }) => {
      const { root, hint } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root)
        return qaError({
          what: 'Could not resolve a project root',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Pass projectRoot or sessionId.'],
          clientHint: hint,
        });

      const prof = profile as AuditProfile;
      const policyForRev = loadPolicy(root);
      const revisionResolved = resolveSourceRevision({
        explicit: sourceRevision ? { provider: 'explicit', ...sourceRevision } : undefined,
        env: process.env,
        allowGitMetadataRead: policyForRev.allowGitMetadataRead,
        root,
      });

      // ---- EXECUTE: drive the audit against the attached device ----
      if (mode === 'execute') {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session)
          return qaError({
            what: 'execute mode needs a sessionId with a prepared device',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_start_session + qa_prepare_target (or qa_test_this), then qa_mobile_audit { mode:"execute" }.'],
          });
        const { driver } = await getDriver(session);
        if (!driver)
          return qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Prepare a device first (qa_test_this / qa_prepare_target), then re-run.'],
          });
        try {
          const run = await runMobileAudit(sessions, session, driver, {
            profile: prof,
            allowGeneratedData,
            allowTestAccountDeletion,
            offlineMode,
            sourceRevision: revisionResolved,
            now: nowIso(),
          });
          let reportUri: string | undefined;
          try {
            const r = await generateSessionReport(sessions, session, {});
            reportUri = r.reportUri;
            run.reportUri = reportUri;
          } catch {
            /* report is best-effort */
          }
          const passed = run.checks.filter((c) => c.status === 'pass').length;
          return qaOk(
            { ...run, markdown: auditRunToMarkdown(run), resourceUri: issuesResourceUri(root) },
            `🔍 mobile audit ${prof}: ${run.state}, release=${run.releaseImpact} — ${passed}/${run.checks.length} pass, ${run.issueIds.length} issue(s)${run.recurrenceWarnings.length ? `, ${run.recurrenceWarnings.length} recurrence` : ''}`,
          );
        } catch (e) {
          return qaError({
            what: `Mobile audit failed: ${String((e as Error).message ?? e)}`,
            changedState: true,
            retrySafe: true,
            nextSteps: ['Check device health (qa_check_health) and retry.'],
          });
        }
      }

      // ---- PLAN (default) ----
      const checks = checksForProfile(prof);
      const safety = accountCycleSafety(prof, { allowGeneratedData, allowTestAccountDeletion, offlineMode });

      // qa_mobile_audit PLANS the audit; the controlled account-cycle steps (logout permitted only on
      // a disposable account) are EXECUTED by qa_explore with accountCycle:true + allowGeneratedData.
      const executor = safety.allowsLogout
        ? {
            tool: 'qa_explore',
            args: { accountCycle: true, allowGeneratedData: allowGeneratedData === true },
            note: 'Runs the account-cycle workflow where logout is permitted on a disposable account; delete/pay/send stay refused.',
          }
        : undefined;

      // Account-cycle / release-gate without generated-data permission can't safely create accounts.
      const blockedChecks = checks.filter((c) => c.requiresGeneratedData && !allowGeneratedData).map((c) => c.id);

      // Surface issue-ledger recurrence so a release gate sees regressions.
      const issues = queryIssues(root, nowIso(), { includeSuppressed: false });
      const recurrence = issues.recurrenceCandidates.map((r) => ({
        issueId: r.issueId,
        summary: r.summary,
        message: r.lastRecurrenceMessage,
      }));

      const summary = `audit profile=${prof}: ${checks.length} check(s)${blockedChecks.length ? `, ${blockedChecks.length} need allowGeneratedData` : ''}${recurrence.length ? `, ${recurrence.length} recurrence warning(s)` : ''}`;
      return qaOk(
        {
          mode: 'plan',
          profile: prof,
          targetApp,
          checks,
          accountCycleSafety: safety,
          executor,
          blockedChecks,
          recurrenceWarnings: recurrence,
          sourceRevision: revisionResolved,
          resourceUri: issuesResourceUri(root),
        },
        summary,
      );
    },
  );
}
