// qa_test_this: the "just test this" entry point. A DETERMINISTIC orchestration
// state machine so a first run does not depend on the agent's skill or token budget. It resolves
// the project, finds (or plans a build for) an artifact, picks a target, and returns an ordered
// plan with the EXACT next tool call to make, or a typed blocker / one concise NeedsInput
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
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionStore } from '../session/store.js';
import { handleTestThis } from '../orchestration/testThis/plan.js';
import { TEST_THIS_WAIT_DEFAULT_MS, TEST_THIS_WAIT_MAX_MS } from '../orchestration/testThis/execute.js';
import { qaAnnotate } from '../lib/result.js';

export function registerTestThis(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_test_this',
    {
      title: 'Test this app (autopilot)',
      description:
        'Start here for "test this app": finds or builds the app, picks an emulator/simulator, then plans (mode:"plan", ' +
        'default, no side effects) or runs prepare > smoke > explore > report > suite as a job (mode:"execute"; poll ' +
        'qa_job_status). One consent covers boot/install/build; every terminal state has a report. iOS without WDA gets a ' +
        'visual-only smoke.',
      inputSchema: {
        sessionId: z.string().optional().describe('Reuse a session.'),
        projectRoot: z.string().optional(),
        mode: z
          .enum(['plan', 'execute', 'interactive'])
          .optional()
          .describe('plan (default) | execute (job) | interactive (until the first question).'),
        goal: z
          .enum(['smoke', 'explore', 'create_automation_suite', 'release_gate', 'test_login', 'reproduce_bug'])
          .optional()
          .describe(
            'Default: smoke, then a suite ("smoke" is fastest). Presets explore/generateSuite/stopOnNeedsInput; explicit flags win.',
          ),
        goalText: z.string().optional().describe('reproduce_bug: the bug/flow to focus on.'),
        fastSmoke: z.boolean().optional().describe('Launch + smoke only, no suite (ignored with goal/generateSuite).'),
        platform: z.enum(['android', 'ios']).optional().describe('Force a platform (default inferred).'),
        device: z.string().optional(),
        preferRealDevice: z.boolean().optional().describe('Out of scope: returns PHYSICAL_DEVICE_UNSUPPORTED.'),
        allowOutsideRoot: z.boolean().optional(),
        buildIfNeeded: z.boolean().optional().describe('Build from source when no artifact exists (default true).'),
        generateSuite: z.boolean().optional().describe('execute: also generate a POM suite from the run.'),
        explore: z.boolean().optional().describe('execute: run guided exploration after the smoke.'),
        stopOnNeedsInput: z.boolean().optional().describe('execute: ask for login/test data instead of testing pre-login only.'),
        waitForCompletion: z.boolean().optional().describe('execute: block until done (or timeoutMs).'),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `waitForCompletion window (default ${TEST_THIS_WAIT_DEFAULT_MS}, max ${TEST_THIS_WAIT_MAX_MS}; larger values are clamped); still running after it > state:"running" + jobId, poll qa_job_status.`,
          ),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
        responseMode: z
          .enum(['compact', 'normal', 'verbose'])
          .optional()
          .describe('compact = summary + URIs only; kept as the session default for later calls.'),
      },
    },
    async (input) => {
      // Clamp (not reject) like qa_job_status waitMs: the window is bounded so the call returns
      // well inside common client request timeouts; a longer job keeps running and is polled.
      if (input.timeoutMs != null && input.timeoutMs > TEST_THIS_WAIT_MAX_MS) {
        const asked = input.timeoutMs;
        const res = await handleTestThis(server, sessions, { ...input, timeoutMs: TEST_THIS_WAIT_MAX_MS });
        return qaAnnotate(res, [`timeoutMs ${asked} clamped to ${TEST_THIS_WAIT_MAX_MS}; poll qa_job_status for longer runs.`]);
      }
      return handleTestThis(server, sessions, input);
    },
  );
}
