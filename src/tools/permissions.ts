// qa_permissions (PHASE3-PLAN §4.2) — list / grant / revoke Android runtime permissions without
// raw adb. grant is low-risk (commonly used to pre-approve and skip a dialog) and only logged;
// revoke can break app state, so it is consent-gated. Every mutation is recorded as an
// environment change for qa_report.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { getDriver } from '../session/attach.js';
import { listRuntimePermissions, grantPermission, revokePermission } from '../lib/device.js';
import type { SessionStore } from '../session/store.js';

export function registerPermissions(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_permissions',
    {
      title: 'App permissions',
      description:
        'Inspect or change a package\'s Android runtime permissions. action: list (granted/denied), grant (pre-approve to skip a dialog — logged), revoke (consent-gated, can break app state — logged). `package` defaults to the session\'s appId; `permission` is a full android.permission.* name (e.g. android.permission.ACCESS_FINE_LOCATION).',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['list', 'grant', 'revoke']),
        package: z.string().optional().describe('Target package (default: the session appId).'),
        permission: z.string().optional().describe('Full permission name, required for grant/revoke.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, action, package: pkgArg, permission, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      const serial = driver?.currentDevice();
      if (!session || !driver || !serial) {
        return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target first.'] });
      }
      const pkg = pkgArg ?? session.appId;
      if (!pkg) {
        return qaError({ what: 'No package given and the session has no appId', changedState: false, retrySafe: true, nextSteps: ['Pass package, or qa_prepare_target to set the appId.'] });
      }

      if (action === 'list') {
        const perms = await listRuntimePermissions(serial, pkg);
        return qaOk({ package: pkg, ...perms }, `${pkg}: ${perms.granted.length} granted, ${perms.denied.length} denied\n  granted: ${perms.granted.join(', ') || '—'}\n  denied: ${perms.denied.join(', ') || '—'}`);
      }

      if (!permission) {
        return qaError({ what: `${action} requires a permission name`, changedState: false, retrySafe: true, nextSteps: ['Pass permission="android.permission.…" (qa_permissions list to see them).'] });
      }

      if (action === 'revoke') {
        // Revoking can crash/break the app — gate behind consent.
        const gate = consumeConsent(consentId, approve, { action: 'permission_revoke', affects: { package: pkg, permission } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_permissions',
            action: 'permission_revoke',
            risk: 'medium',
            target: { package: pkg, permission },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: 'permission_revoke',
            risk: 'medium',
            exactCommand: `adb -s ${serial} shell pm revoke ${pkg} ${permission}`,
            affects: { package: pkg, permission },
            explain: `Revoke ${permission} from ${pkg}? This can change app behavior or crash a poorly-guarded app.`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_permissions',
          action: 'permission_revoke',
          risk: 'medium',
          target: { package: pkg, permission },
          consent: { required: true, consentId, approved: true },
          status: 'approved',
        });
        try {
          await revokePermission(serial, pkg, permission);
        } catch (e) {
          sessions.recordMutation(session, {
            tool: 'qa_permissions',
            action: 'permission_revoke',
            risk: 'medium',
            target: { package: pkg, permission },
            consent: { required: true, consentId, approved: true },
            status: 'blocked',
            detail: String(e),
          });
          return qaError({ what: `revoke failed: ${String(e)}`, changedState: false, retrySafe: true, nextSteps: ['Check the permission name; some are not revocable.'] });
        }
        sessions.addEnvChange(session, `permission revoke ${permission} from ${pkg}`);
        sessions.recordMutation(session, {
          tool: 'qa_permissions',
          action: 'permission_revoke',
          risk: 'medium',
          target: { package: pkg, permission },
          consent: { required: true, consentId, approved: true },
          status: 'executed',
        });
        return qaOk({ package: pkg, permission, action }, `revoked ${permission} from ${pkg}`);
      }

      // grant — low risk, but still a state mutation (it can hide a permission-dialog bug), so
      // it is consent-gated (low) and always reported, never silent.
      const grantGate = consumeConsent(consentId, approve, { action: 'permission_grant', affects: { package: pkg, permission } });
      if (!grantGate.approved) {
        sessions.recordMutation(session, {
          tool: 'qa_permissions',
          action: 'permission_grant',
          risk: 'low',
          target: { package: pkg, permission },
          consent: { required: true, approved: false },
          status: 'requested',
        });
        return requireConsent({
          action: 'permission_grant',
          risk: 'low',
          exactCommand: `adb -s ${serial} shell pm grant ${pkg} ${permission}`,
          affects: { package: pkg, permission },
          explain: `Pre-grant ${permission} to ${pkg}? This skips the runtime permission dialog — convenient, but it can mask a permission-prompt bug.`,
        });
      }
      sessions.recordMutation(session, {
        tool: 'qa_permissions',
        action: 'permission_grant',
        risk: 'low',
        target: { package: pkg, permission },
        consent: { required: true, consentId, approved: true },
        status: 'approved',
      });
      try {
        await grantPermission(serial, pkg, permission);
      } catch (e) {
        sessions.recordMutation(session, {
          tool: 'qa_permissions',
          action: 'permission_grant',
          risk: 'low',
          target: { package: pkg, permission },
          consent: { required: true, consentId, approved: true },
          status: 'blocked',
          detail: String(e),
        });
        return qaError({ what: `grant failed: ${String(e)}`, changedState: false, retrySafe: true, nextSteps: ['Check the permission name; only runtime permissions are grantable.'] });
      }
      sessions.addEnvChange(session, `permission grant ${permission} to ${pkg}`);
      sessions.recordMutation(session, {
        tool: 'qa_permissions',
        action: 'permission_grant',
        risk: 'low',
        target: { package: pkg, permission },
        consent: { required: true, consentId, approved: true },
        status: 'executed',
      });
      return qaOk({ package: pkg, permission, action }, `granted ${permission} to ${pkg}`);
    },
  );
}
