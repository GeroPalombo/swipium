import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { getDriver } from '../session/attach.js';
import { settle } from '../snapshot/settle.js';
import type { SessionStore } from '../session/store.js';

export interface IdlingPayload {
  idle: boolean;
  detail: string;
  raw?: unknown;
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function parseIdlingPayload(text: string): IdlingPayload {
  const trimmed = text.trim();
  if (!trimmed) return { idle: false, detail: 'empty idling response' };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'boolean') return { idle: parsed, detail: parsed ? 'idle:true' : 'idle:false', raw: parsed };
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      const value = o.idle ?? o.isIdleNow ?? (typeof o.busy === 'boolean' ? !o.busy : undefined);
      if (typeof value === 'boolean') {
        return { idle: value, detail: String(o.reason ?? o.status ?? (value ? 'app declared idle' : 'app declared busy')), raw: parsed };
      }
      if (typeof o.status === 'string') {
        const idle = /idle|ready|settled/i.test(o.status);
        return { idle, detail: o.status, raw: parsed };
      }
    }
  } catch {
    /* fall through to text parser */
  }
  return { idle: /^(idle|ready|settled|true|ok)$/i.test(trimmed), detail: trimmed };
}

function fetchLoopback(raw: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(raw);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`idling hook timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

export function registerIdling(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_idling_status',
    {
      title: 'Read app idling status',
      description:
        'Report whether the app is idle before automation. With hookUrl, reads an app-declared loopback idling endpoint (Gradle/RN/Flutter test hook). Without hookUrl, uses Swipium heuristic settling and labels it as heuristic evidence.',
      inputSchema: {
        sessionId: z.string(),
        hookUrl: z.string().optional().describe('Optional loopback-only URL returning { idle: boolean } / { isIdleNow: boolean } / text "idle".'),
        timeoutMs: z.number().optional().describe('Default 3000 for hookUrl, 8000 for heuristic settling.'),
      },
    },
    async ({ sessionId, hookUrl, timeoutMs }) => {
      const session = sessions.get(sessionId);
      if (!session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });

      if (hookUrl) {
        if (!isLoopbackUrl(hookUrl)) {
          return qaError({
            what: 'idling hook URLs must be loopback-only',
            changedState: false,
            retrySafe: false,
            failureCode: 'UNSAFE_ACTION_REFUSED',
            nextSteps: ['Expose the app test hook on localhost/127.0.0.1 and retry.'],
          });
        }
        try {
          const body = await fetchLoopback(hookUrl, timeoutMs ?? 3000);
          const parsed = parseIdlingPayload(body);
          sessions.addWorkaround(session, `idling: app-declared hook ${hookUrl}`);
          return qaOk(
            { source: 'app_declared', hookUrl, idle: parsed.idle, detail: parsed.detail, raw: parsed.raw ?? body },
            `idling app_declared: ${parsed.idle ? 'idle' : 'busy'} (${parsed.detail})`,
          );
        } catch (e) {
          return qaError({
            what: `Could not read idling hook: ${String(e)}`,
            changedState: false,
            retrySafe: true,
            failureCode: 'UI_IDLE_TIMEOUT',
            nextSteps: ['Confirm the local idling hook is running and returns JSON/text within the timeout.'],
          });
        }
      }

      const { driver } = await getDriver(session);
      if (!driver) return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Prepare a target first or pass hookUrl for an app-declared hook.'] });
      const result = await settle(driver, { timeoutMs: timeoutMs ?? 8000 });
      sessions.addWorkaround(session, 'idling: heuristic settle used (no app-declared hook)');
      return qaOk(
        { source: 'heuristic', idle: result.settled, timeoutMs: timeoutMs ?? 8000 },
        `idling heuristic: ${result.settled ? 'idle' : 'not idle before timeout'}`,
      );
    },
  );
}
