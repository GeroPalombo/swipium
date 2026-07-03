// qa_generate (P0 §1 tool-surface consolidation) — the single entry point for "generate test
// assets from this session's recorded actions". Dispatches by `target` to the existing core
// handlers (flowGenerate.ts, suite.ts, automationGenerate.ts) so behavior, consent gates, and
// error envelopes are unchanged; only the tool surface is unified.
//
// Not to be confused with qa_suite_generate, which grows the DURABLE repo-level test suite
// (.swipium/test-suite.json) across runs — qa_generate emits per-run assets from this run.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { qaError, qaAnnotate as annotate } from '../lib/result.js';
import { runFlowGenerate } from './flowGenerate.js';
import { runPomGenerate, runSuiteGenerate, runTestcaseGenerate } from './suite.js';
import { runAutomationPlan, runAutomationGenerate } from './automationGenerate.js';
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
        'One entry point for "turn this run into reusable test assets": generate a flow, page objects, a per-run POM suite, test-case docs, or Appium automation code from the actions recorded in this session (qa_act/qa_smoke/qa_explore record every action). Pick what to emit with target; mode:"plan" gives a read-only preview (for target:"appium", the full automation plan with blockers). Prefer qa_generate for per-run generated assets from recorded actions / not for the durable repo-level test suite that grows across runs — use qa_suite_generate for that.',
      inputSchema: {
        target: z
          .union([
            z
              .literal('flow')
              .describe(
                'Emit a repeatable Flow V2 YAML (durability grade + brittle steps, credentials as ${VARS}); save writes .swipium/flows/<name>.yaml for qa_flow_run. Prefer when one replayable flow is wanted.',
              ),
            z
              .literal('pom')
              .describe(
                'Emit Screen/Page Object Model files (one page object per screen, selectors hoisted) + a locator audit; save writes .swipium/pages + .swipium/locators. Prefer when only page objects / a locator audit are wanted.',
              ),
            z
              .literal('suite')
              .describe(
                'Emit the full per-run suite under .swipium/ (pages + tests + suites + testcases + locator audit) AND — unless compile:false — runnable Flow V2, with replay/CI-readiness gates. Prefer when this run should become a committed, runnable POM suite.',
              ),
            z
              .literal('testcases')
              .describe(
                'Emit an industry-style test case catalog (TC-xxx: purpose, priority, steps, expected, automation status, evidence) as YAML + Markdown; save writes .swipium/testcases. Prefer for human-readable test documentation.',
              ),
            z
              .literal('appium')
              .describe(
                'Emit a runnable Appium POM suite (WebdriverIO TS/JS or Python) adapted to the project language; can bootstrap a device/session/actions from projectRoot when no sessionId is given. Prefer when the user asks for Appium/exportable automation code.',
              ),
          ])
          .describe('What to generate from the recorded actions.'),
        mode: z
          .enum(['plan', 'generate'])
          .optional()
          .describe(
            'generate (default) writes/returns the asset. plan is read-only: for target:"appium" it returns the project profile + generation plan + blockers; for other targets it returns a preview with save forced off.',
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            'Session with recorded actions. Required for target flow/pom/suite/testcases; optional for target:"appium" (which can bootstrap from projectRoot).',
          ),
        name: z.string().optional().describe('Asset name (default derived from the app id).'),
        save: z
          .boolean()
          .optional()
          .describe(
            'Write files to disk. Defaults: flow/pom/testcases false (returned + artifact only), suite/appium true. Forced off by mode:"plan".',
          ),
        // target:"flow"
        budgetProfile: z
          .enum(['guardrail', 'login_smoke', 'full_smoke', 'install_smoke'])
          .optional()
          .describe('target:"flow" only — budget profile recorded in the generated flow.'),
        // target:"suite"
        compile: z.boolean().optional().describe('target:"suite" only — also compile to runnable Flow V2 (default true).'),
        replay: z
          .enum(['none', 'dry_run', 'same_session', 'fresh_state'])
          .optional()
          .describe(
            'target:"suite" only — replay gate: dry_run (default) validates compiled flows; same_session executes them now; fresh_state requires stateProfile and proves CI readiness.',
          ),
        stateProfile: z.string().optional().describe('target:"suite" only — required for replay:"fresh_state".'),
        // target:"testcases"
        format: z.enum(['yaml', 'markdown', 'both']).optional().describe('target:"testcases" only — output format (default both).'),
        // target:"appium"
        projectRoot: z
          .string()
          .optional()
          .describe('target:"appium" only — project root, used to plan or bootstrap when no sessionId is given.'),
        bootstrap: z
          .union([z.boolean(), z.literal('auto')])
          .optional()
          .describe(
            'target:"appium" only — bootstrap the missing map/session/actions safely (smoke+explore) when none exist. Default "auto" when no sessionId is provided.',
          ),
        feature: z.string().optional().describe('target:"appium" only — optional focus for the plan / bootstrap exploration.'),
        device: z.string().optional().describe('target:"appium" only — specific device/simulator to prepare when bootstrapping.'),
        language: z
          .enum(['auto', 'javascript', 'typescript', 'python'])
          .optional()
          .describe('target:"appium" only — automation language (default auto-detected).'),
        platform: z.enum(['auto', 'android', 'ios', 'both']).optional().describe('target:"appium" only — platform(s) to generate for.'),
        backend: z
          .enum(['auto', 'appium', 'swipium_flow'])
          .optional()
          .describe('target:"appium" mode:"plan" only — preferred execution backend recorded in the plan.'),
        integrateIntoProject: z
          .boolean()
          .optional()
          .describe('target:"appium" only — write into the project test dir instead of .swipium (consent-gated, never overwrites).'),
        includeCi: z.boolean().optional().describe('target:"appium" only — also emit ci.example.yml.'),
        candidateOnly: z
          .boolean()
          .optional()
          .describe('target:"appium" only — label the suite candidate-only so brittle locators do not fail validation.'),
        brittleThreshold: z
          .number()
          .optional()
          .describe('target:"appium" only — max brittle-locator percent before validation fails (default 40).'),
        // consent (target:"suite" fresh_state replay; target:"appium" integrateIntoProject)
        consentId: z
          .string()
          .optional()
          .describe('targets "suite"/"appium" — consent id for the gated step (fresh-state replay / project write).'),
        approve: z.boolean().optional().describe('targets "suite"/"appium" — approve the exact consent request.'),
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
      return annotate(res, notes);
    },
  );
}
