// qa_test_this (roadmap §3.1) — the "just test this" entry point. A DETERMINISTIC orchestration
// state machine so a first run does not depend on the agent's skill or token budget. It resolves
// the project, finds (or plans a build for) an artifact, picks a target, and returns an ordered
// plan with the EXACT next tool call to make — or a typed blocker / one concise NeedsInput
// question. It performs the cheap, side-effect-free resolution itself; the heavy device steps
// (build, boot/install, smoke) are dispatched to the existing one-shot tools via `nextAction`,
// so an agent reaches real work in one or two calls instead of ten.
//
// Honesty (§2.2): the result state is exactly one of ready | needs_input | blocked | unsafe, and
// every safe fallback Swipium chose is recorded in `workaroundsAttempted` (§11).
//
// This file is the MCP registration + schema only; the state machine lives in
// src/orchestration/testThis/ (plan resolution, execute gate, pipeline, terminal assembly).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionStore } from '../session/store.js';
import { handleTestThis } from '../orchestration/testThis/plan.js';

export function registerTestThis(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_test_this',
    {
      title: 'Test this app (autopilot)',
      description:
        'USE WHEN asked to "test this app" with little context — the one-shot autopilot: resolves the project, finds (or builds) an installable artifact, picks the best device/simulator, then plans or EXECUTES prepare→smoke→report(→suite). Creates a session if none is given. IMPORTANT: mode:"execute" returns immediately with state:"running" + a jobId — the TERMINAL state (completed/blocked/unsafe) and the reportUri are in the JOB RESULT via qa_job_status (or pass waitForCompletion:true for short paths). Honest by contract: typed blockers, one NeedsInput question at a time, a workaroundsAttempted trail, and a report in every terminal state.',
      inputSchema: {
        sessionId: z.string().optional().describe('Reuse an existing session; otherwise one is created.'),
        projectRoot: z.string().optional(),
        mode: z
          .enum(['plan', 'execute', 'interactive'])
          .optional()
          .describe(
            'plan (default): return an ordered plan + exact nextAction, side-effect free. execute: run build/convert→prepare→smoke→report→(suite) as a background job; one combined consent for any privileged steps (boot, external-APK install, iOS .app install, build) is requested BEFORE starting. interactive: run until the first question (login/consent) and return it.',
          ),
        goal: z
          .enum(['smoke', 'explore', 'create_automation_suite', 'release_gate', 'test_login', 'reproduce_bug'])
          .optional()
          .describe(
            'Autopilot intent (default smoke). Adjusts orchestration flags + required outputs only: smoke=fast launch; explore=guided exploration; create_automation_suite=explore+generate POM suite; release_gate=stricter report+readiness; test_login=drive login (stop for credentials if none); reproduce_bug=focused exploration from goalText. Explicit explore/generateSuite/stopOnNeedsInput flags override the goal default.',
          ),
        goalText: z.string().optional().describe('For goal="reproduce_bug": a short description of the bug/flow to focus on.'),
        fastSmoke: z
          .boolean()
          .optional()
          .describe(
            'Opt out of the default "leave behind automation" behavior: just launch + smoke, skip POM suite generation. Ignored when an explicit goal/generateSuite is given.',
          ),
        platform: z.enum(['android', 'ios']).optional().describe('Force a platform; otherwise inferred from the artifact/devices.'),
        device: z.string().optional(),
        preferRealDevice: z.boolean().optional(),
        allowOutsideRoot: z.boolean().optional(),
        buildIfNeeded: z.boolean().optional().describe('If no artifact exists but the project is buildable, build it (default true).'),
        generateSuite: z.boolean().optional().describe('In execute mode, also generate a POM suite from the run (default false).'),
        explore: z
          .boolean()
          .optional()
          .describe(
            'In execute mode, run guided exploration (qa_explore) after the launch smoke to discover reachable workflows + build a screen graph (default false → fast smoke only).',
          ),
        stopOnNeedsInput: z
          .boolean()
          .optional()
          .describe(
            'In execute mode, stop and ask when login/test-data is needed instead of testing pre-login (default false → effective pre-login coverage).',
          ),
        waitForCompletion: z
          .boolean()
          .optional()
          .describe(
            'In execute mode, block until the job finishes (or timeoutMs) and return the terminal result instead of a running jobId. Use for short paths.',
          ),
        timeoutMs: z.number().optional().describe('With waitForCompletion: max ms to wait (default 120000).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async (input) => handleTestThis(server, sessions, input),
  );
}
