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
        'Autopilot for "test this app": finds or builds an artifact, picks a device/simulator, then plans ' +
        '(mode:"plan", default, no side effects) or executes prepare → smoke → (explore) → report → (suite). execute returns ' +
        'state:"running" + jobId; the terminal state (completed/blocked/unsafe/needs_input) and reportUri are in the ' +
        'qa_job_status result. One combined consent covers boot/install/build. A report in every terminal state. iOS without WDA ' +
        'falls back to a visual-only smoke.',
      inputSchema: {
        sessionId: z.string().optional().describe('Reuse a session; otherwise one is created.'),
        projectRoot: z.string().optional(),
        mode: z
          .enum(['plan', 'execute', 'interactive'])
          .optional()
          .describe('plan (default) | execute (background job) | interactive (run until the first question).'),
        goal: z
          .enum(['smoke', 'explore', 'create_automation_suite', 'release_gate', 'test_login', 'reproduce_bug'])
          .optional()
          .describe('Intent (default smoke); sets explore/generateSuite/stopOnNeedsInput defaults. Explicit flags win.'),
        goalText: z.string().optional().describe('reproduce_bug: the bug/flow to focus on.'),
        fastSmoke: z.boolean().optional().describe('Just launch + smoke; skip suite generation (ignored with goal/generateSuite).'),
        platform: z.enum(['android', 'ios']).optional().describe('Force a platform (default inferred).'),
        device: z.string().optional(),
        preferRealDevice: z.boolean().optional().describe('Out of scope: returns PHYSICAL_DEVICE_UNSUPPORTED.'),
        allowOutsideRoot: z.boolean().optional(),
        buildIfNeeded: z.boolean().optional().describe('Build from source when no artifact exists (default true).'),
        generateSuite: z.boolean().optional().describe('execute: also generate a POM suite from the run.'),
        explore: z.boolean().optional().describe('execute: run guided exploration after the smoke.'),
        stopOnNeedsInput: z.boolean().optional().describe('execute: ask for login/test data instead of testing pre-login only.'),
        waitForCompletion: z.boolean().optional().describe('execute: block until done (or timeoutMs) and return the terminal result.'),
        timeoutMs: z.number().optional().describe('waitForCompletion cap (default 120000).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
        responseMode: z
          .enum(['compact', 'normal', 'verbose'])
          .optional()
          .describe('Text channel for this session: compact = summary + URIs (structuredContent stays full).'),
      },
    },
    async (input) => handleTestThis(server, sessions, input),
  );
}
