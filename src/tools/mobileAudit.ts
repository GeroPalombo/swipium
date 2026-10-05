// SWIPIUM Mobile QA Toolkit MCP tool. qa_mobile_audit turns a named profile
// (smoke | account_cycle | store_compliance | resilience | release_gate) into an ordered, classified
// checklist plus the account-cycle safety contract the agent executes with the existing driver tools.
// It also surfaces the issue-ledger recurrence state so a release gate sees regressions. Thin wrapper
// over src/mobileAudit/* and src/issues/*.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { cancelledResult, qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { isAbortError } from '../lib/abortScope.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import type { SessionStore } from '../session/store.js';
import { accountCycleSafety, checksForProfile, ALL_PROFILES, type AuditProfile } from '../mobileAudit/profiles.js';
import { auditChangesNetwork, auditNetworkConsentRequest, runMobileAudit } from '../mobileAudit/runner.js';
import { consumeConsent, requireConsent } from '../consent/consent.js';
import { auditRunToMarkdown } from '../mobileAudit/results.js';
import { generateSessionReport } from '../services/report.js';
import { queryIssues } from '../issues/index.js';
import { resolveSourceRevision } from '../issues/sourceRevision.js';
import { loadPolicy } from '../issues/store.js';

function nowIso(): string {
  return new Date().toISOString();
}

async function rootFor(
  server: McpServer,
  sessions: SessionStore,
  args: { projectRoot?: string; sessionId?: string },
): Promise<{ root?: string; hint?: string; error?: CallToolResult }> {
  if (args.sessionId) {
    const s = sessions.get(args.sessionId);
    if (!s) return { error: unknownSessionError(args.sessionId) };
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
        'Plan (default, no device) or execute a release audit. profile: smoke, account_cycle (create/logout/login/reset on a ' +
        'disposable account), store_compliance, resilience (offline/relaunch/rotation; airplane mode is consent-gated), ' +
        'release_gate (all). execute needs a prepared session, logs failed/blocked checks to the issue ledger, and passes ' +
        'nothing without evidence.',
      inputSchema: {
        projectRoot: z.string().optional(),
        sessionId: z.string().optional(),
        profile: z.enum(ALL_PROFILES as [string, ...string[]]),
        mode: z.enum(['plan', 'execute']).optional(),
        allowGeneratedData: z.boolean().optional().describe('Required for account_cycle.'),
        allowTestAccountDeletion: z.boolean().optional().describe('Permit deleting disposable test accounts (never a real account).'),
        offlineMode: z.boolean().optional().describe('resilience: drive offline state.'),
        sourceRevision: z
          .object({ commit: z.string().optional(), buildVersion: z.string().optional(), branch: z.string().optional() })
          .optional(),
        targetApp: z.string().optional(),
        consentId: z.string().optional().describe('execute: consent for the airplane-mode toggle.'),
        approve: z.boolean().optional(),
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
      consentId,
      approve,
    }) => {
      const { root, hint, error } = await rootFor(server, sessions, { projectRoot, sessionId });
      if (!root) return error ?? unresolvedProjectRootError({ source: 'none', hint });

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
        const { driver, blocked } = await getDriver(session);
        if (!driver)
          return (
            blockedDeviceResult(blocked) ??
            qaError({
              what: 'No device attached to this session',
              changedState: false,
              retrySafe: true,
              nextSteps: ['Prepare a device first (qa_test_this / qa_prepare_target), then re-run.'],
            })
          );
        // resilience / release_gate toggle airplane mode: same network_change gate as qa_network.
        let networkChangeApproved = false;
        if (auditChangesNetwork(prof)) {
          const req = auditNetworkConsentRequest(prof);
          const gate = consumeConsent(consentId, approve, { action: req.action, affects: req.affects });
          if (!gate.approved) {
            sessions.recordMutation(session, {
              tool: 'qa_mobile_audit',
              action: req.action,
              risk: req.risk,
              target: req.affects,
              consent: { required: true, approved: false },
              status: 'requested',
            });
            return requireConsent(req);
          }
          networkChangeApproved = true;
        }
        try {
          const run = await runMobileAudit(sessions, session, driver, {
            networkChangeApproved,
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
            { ...run, markdown: auditRunToMarkdown(run) },
            `🔍 mobile audit ${prof}: ${run.state}, release=${run.releaseImpact}, ${passed}/${run.checks.length} pass, ${run.issueIds.length} issue(s)${run.recurrenceWarnings.length ? `, ${run.recurrenceWarnings.length} recurrence` : ''}`,
          );
        } catch (e) {
          if (isAbortError(e))
            return cancelledResult('qa_mobile_audit cancelled: remaining checks were skipped, nothing was recorded as an issue', true);
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
        },
        summary,
      );
    },
  );
}
