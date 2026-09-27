// qa_generate (P0 §1 tool-surface consolidation) — the single entry point for "generate test
// assets from this session's recorded actions". Dispatches by `target` to the existing core
// handlers (services/flowGenerate.ts, suite.ts, automationGen/run.ts) so behavior, consent gates, and
// error envelopes are unchanged; only the tool surface is unified.
//
// Not to be confused with qa_suite_generate, which grows the DURABLE repo-level test suite
// (.swipium/test-suite.json) across runs — qa_generate emits per-run assets from this run.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError, qaAnnotate as annotate } from '../lib/result.js';
import { runFlowGenerate } from '../services/flowGenerate.js';
import { runPomGenerate, runSuiteGenerate, runTestcaseGenerate } from './suite.js';
import { runAutomationPlan, runAutomationGenerate } from '../automationGen/run.js';
import type { SessionStore } from '../session/store.js';

type Target = 'flow' | 'pom' | 'suite' | 'testcases' | 'appium';

/** Params shared by every target. */
const COMMON_PARAMS = ['target', 'mode', 'sessionId', 'name', 'save'] as const;

/** Target-specific params; anything passed outside common + this list is ignored with a note. */
const TARGET_PARAMS: Record<Target, readonly string[]> = {
  flow: ['budgetProfile'],
  pom: [],
  suite: ['compile', 'replay', 'stateProfile', 'consentId', 'approve'],
  testcases: ['format'],
  appium: [
    'projectRoot',
    'bootstrap',
    'feature',
    'device',
    'language',
    'platform',
    'backend',
    'integrateIntoProject',
    'includeCi',
    'candidateOnly',
    'brittleThreshold',
    'consentId',
    'approve',
  ],
};

/** Leave a durable trace on the session when generation really succeeded, so
 *  qa_status (nextBestAction) can recommend wrapping up (qa_report) instead of
 *  regenerating the same assets. Mirrors the qa_test_this pipeline's "generated a POM suite"
 *  workaround entry; nextBestAction (src/tools/agent.ts) keys its terminal state on it. */
function noteGenerated(sessions: SessionStore, sessionId: string | undefined, target: Target, res: CallToolResult): void {
  if (res.isError) return;
  const s = sessionId ? sessions.get(sessionId) : undefined;
  if (!s) return;
  sessions.addWorkaround(s, `generated ${target} test asset(s) from recorded actions (qa_generate)`);
}

/** Label a mode:"plan" result of a generate-capable target as a read-only preview. */
function labelPreview(result: CallToolResult): CallToolResult {
  const label = 'PREVIEW (mode:"plan" — read-only, nothing was written). Re-run with mode:"generate" to write files.';
  const content = [...(result.content ?? [])];
  const first = content[0];
  if (first && first.type === 'text') content[0] = { ...first, text: `${label}\n${String(first.text)}` };
  else content.unshift({ type: 'text', text: label });
  return { ...result, content, structuredContent: { ...((result.structuredContent ?? {}) as Record<string, unknown>), preview: true } };
}

export function registerGenerate(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_generate',
    {
      title: 'Generate test assets from recorded actions',
      description:
        'Turn the actions recorded in this session (qa_act / qa_smoke / qa_explore) into reusable assets. target: flow (Flow V2 YAML ' +
        'for qa_flow_run), pom (page objects + locator audit), suite (full per-run POM suite under .swipium/, compiled to runnable ' +
        'flows unless compile:false, with a replay gate), testcases (TC-xxx catalog as YAML/Markdown), appium (runnable WebdriverIO ' +
        'TS/JS or Python suite; can bootstrap from projectRoot; UNEMITTABLE_STEP if a step cannot be expressed). mode:"plan" is a ' +
        'read-only preview. Parameters for other targets are ignored with a note. For the durable repo-level suite use qa_suite_generate.',
      inputSchema: {
        target: z.enum(['flow', 'pom', 'suite', 'testcases', 'appium']),
        mode: z.enum(['plan', 'generate']).optional().describe('generate (default) or plan (read-only preview; appium: plan + blockers).'),
        sessionId: z.string().optional().describe('Session with recorded actions (required except for target:"appium").'),
        name: z.string().optional().describe('Asset name (default from the app id).'),
        save: z.boolean().optional().describe('Write files (default: suite/appium true, others false).'),
        budgetProfile: z.enum(['guardrail', 'login_smoke', 'full_smoke', 'install_smoke']).optional().describe('flow'),
        compile: z.boolean().optional().describe('suite: compile to runnable Flow V2 (default true).'),
        replay: z
          .enum(['none', 'dry_run', 'same_session', 'fresh_state'])
          .optional()
          .describe('suite: replay gate (default dry_run; fresh_state needs stateProfile, proves CI readiness).'),
        stateProfile: z.string().optional().describe('suite: for replay:"fresh_state".'),
        format: z.enum(['yaml', 'markdown', 'both']).optional().describe('testcases (default both)'),
        projectRoot: z.string().optional().describe('appium: plan/bootstrap without a session.'),
        bootstrap: z
          .union([z.boolean(), z.literal('auto')])
          .optional()
          .describe('appium: smoke+explore to record actions when none exist.'),
        feature: z.string().optional().describe('appium: focus for plan/bootstrap.'),
        device: z.string().optional().describe('appium: device to bootstrap on.'),
        language: z.enum(['auto', 'javascript', 'typescript', 'python']).optional().describe('appium (default auto-detected)'),
        platform: z.enum(['auto', 'android', 'ios', 'both']).optional().describe('appium'),
        backend: z.enum(['auto', 'appium', 'swipium_flow']).optional().describe('appium plan: preferred backend.'),
        integrateIntoProject: z.boolean().optional().describe('appium: write into the project test dir (consent-gated, never overwrites).'),
        includeCi: z.boolean().optional().describe('appium: also emit ci.example.yml.'),
        candidateOnly: z.boolean().optional().describe('appium: brittle locators do not fail validation.'),
        brittleThreshold: z.number().optional().describe('appium: max brittle-locator % (default 40).'),
        consentId: z.string().optional().describe('suite fresh_state replay / appium project write.'),
        approve: z.boolean().optional(),
      },
    },
    async (args) => {
      const target = args.target as Target;
      const mode = args.mode ?? 'generate';
      const planMode = mode === 'plan';
      const notes: string[] = [];

      // Validate target-specific params: anything set that does not apply is ignored with a note.
      const allowed = new Set<string>([...COMMON_PARAMS, ...TARGET_PARAMS[target]]);
      const ignored = Object.entries(args)
        .filter(([k, v]) => v !== undefined && !allowed.has(k))
        .map(([k]) => k)
        .sort();
      if (ignored.length) notes.push(`ignored parameter(s) not applicable to target:"${target}": ${ignored.join(', ')}`);

      // ---- target:"appium" — plan is exactly the automation plan; generate supports bootstrap. ----
      if (target === 'appium') {
        if (planMode) {
          const res = await runAutomationPlan(sessions, {
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            feature: args.feature,
            language: args.language,
            platform: args.platform,
            backend: args.backend,
            includeCi: args.includeCi,
          });
          return annotate(res, notes);
        }
        if (args.backend && args.backend !== 'auto' && args.backend !== 'appium') {
          notes.push(
            `backend:"${args.backend}" applies to mode:"plan" only — Appium code is generated as an additional layer; existing ${args.backend} flows are kept`,
          );
        }
        const res = await runAutomationGenerate(server, sessions, {
          sessionId: args.sessionId,
          projectRoot: args.projectRoot,
          bootstrap: args.bootstrap,
          feature: args.feature,
          device: args.device,
          name: args.name,
          language: args.language,
          platform: args.platform,
          save: args.save,
          integrateIntoProject: args.integrateIntoProject,
          includeCi: args.includeCi,
          candidateOnly: args.candidateOnly,
          brittleThreshold: args.brittleThreshold,
          consentId: args.consentId,
          approve: args.approve,
        });
        noteGenerated(sessions, args.sessionId, target, res);
        return annotate(res, notes);
      }

      // ---- flow / pom / suite / testcases require a session with recorded actions. ----
      const sessionId = args.sessionId;
      if (!sessionId) {
        return qaError({
          what: `qa_generate target:"${target}" needs a sessionId with recorded actions`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session, drive the app with qa_act/qa_smoke/qa_explore, then re-run qa_generate.'],
        });
      }

      if (planMode && args.save) notes.push('mode:"plan" is read-only — save was forced off; re-run with mode:"generate" to write files');
      const save = planMode ? false : args.save;

      let res: CallToolResult;
      switch (target) {
        case 'flow':
          res = await runFlowGenerate(sessions, { sessionId, name: args.name, budgetProfile: args.budgetProfile, save });
          break;
        case 'pom':
          res = await runPomGenerate(sessions, { sessionId, name: args.name, save });
          break;
        case 'suite': {
          let replay = args.replay;
          if (planMode && replay && replay !== 'none' && replay !== 'dry_run') {
            notes.push(`mode:"plan" forces replay:"dry_run" (no device execution); requested replay:"${replay}" needs mode:"generate"`);
            replay = 'dry_run';
          }
          res = await runSuiteGenerate(sessions, {
            sessionId,
            name: args.name,
            save,
            compile: planMode ? false : args.compile,
            replay,
            stateProfile: args.stateProfile,
            consentId: args.consentId,
            approve: args.approve,
          });
          break;
        }
        case 'testcases':
          res = await runTestcaseGenerate(sessions, { sessionId, name: args.name, format: args.format, save });
          break;
      }
      if (planMode) res = labelPreview(res);
      else noteGenerated(sessions, sessionId, target, res);
      return annotate(res, notes);
    },
  );
}
