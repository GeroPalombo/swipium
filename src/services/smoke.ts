// Smoke service (hardening P0.1): the server-side smoke loop, extracted from the qa_smoke tool so
// BOTH the tool and qa_test_this execute mode run the exact same path (no MCP-over-transport). It
// launches the app, runs the deterministic baseline (snapshot quality + health + evidence shot),
// then runs every saved flow, recording a structured qa_note per workflow.

import { readFileSync } from 'node:fs';
import { parseSnapshot, signature } from '../snapshot/parse.js';
import { settle } from '../snapshot/settle.js';
import { checkHealth } from '../oracle/health.js';
import { recordHealthFindings } from '../oracle/record.js';
import { listFlowFiles } from '../flows/discover.js';
import { isMutatingFlowStep, parseFlow } from '../flows/schema.js';
import { runFlow, type FlowRunResult } from '../flows/run.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore, TestNote, TestOutcome } from '../session/store.js';
import type { Flow } from '../flows/schema.js';
import { isAbortError, throwIfCancelled } from '../lib/abortScope.js';

export interface SmokeResult {
  baseline: Record<string, unknown>;
  flows: Array<{ name: string; passed: boolean; failedAtStep?: number; reason?: string }>;
  flowsPassed: number;
  flowsTotal: number;
  /** The call/job was cancelled: the remaining work was skipped (not recorded as failures). */
  cancelled?: boolean;
}

const CANCELLED_REASON = 'cancelled: the call/job was aborted; not evidence about the app';

export interface SmokeOptions {
  launch?: boolean;
  runFlows?: boolean;
  variables?: Record<string, string>;
}

/** Mutating steps qa_smoke refuses to run implicitly (repo flows are untrusted): the CI set plus
 *  any `openUrl` that interpolates a `${VAR}` (would carry a resolved value off-device). */
function mutatingSteps(flow: Flow): Array<{ step: number; kind: string }> {
  const out: Array<{ step: number; kind: string }> = [];
  [...flow.setup, ...flow.steps, ...flow.teardown].forEach((step, index) => {
    if (isMutatingFlowStep(step)) out.push({ step: index + 1, kind: step.kind });
  });
  return out;
}

function externalProviderSteps(flow: Flow): Array<{ step: number; kind: string }> {
  const out: Array<{ step: number; kind: string }> = [];
  [...flow.setup, ...flow.steps, ...flow.teardown].forEach((step, index) => {
    if (step.kind === 'tapOcrText' || step.kind === 'assertOcrText') out.push({ step: index + 1, kind: step.kind });
  });
  return out;
}

export async function runSmoke(sessions: SessionStore, session: Session, d: Driver, opts: SmokeOptions = {}): Promise<SmokeResult> {
  const note = (n: Omit<TestNote, 'at'>) => sessions.addNote(session, { at: Date.now(), ...n });
  const doLaunch = opts.launch ?? !!session.appId;
  const baseline: Record<string, unknown> = {};
  let cancelled = false;

  // ---- baseline: launch > snapshot quality > health > evidence screenshot ----
  try {
    if (doLaunch && session.appId) {
      await d.launchApp(session.appId);
      await settle(d, { timeoutMs: 8000 });
    }
    let quality: string | undefined;
    if (session.mode !== 'visual-fallback') {
      try {
        const parsed = parseSnapshot(await d.dumpXml());
        session.lastSnapshot = {
          fullByRef: parsed.fullByRef,
          signatures: new Set(parsed.elements.map(signature)),
          allNodes: parsed.allNodes,
        };
        quality = parsed.quality.verdict;
      } catch {
        /* visual-only screen, health + screenshot still run */
      }
    }
    const health = await checkHealth(d, session.appId);
    // A health probe interrupted by cancellation reads as unhealthy: never record it as a finding.
    throwIfCancelled();
    await recordHealthFindings(sessions, session, health.findings, d, health.foreground);
    let shotUri: string | undefined;
    // Sensitive mode never persists screenshots. The baseline note says so instead.
    const screenshotSkipped = session.sensitive ? 'screenshot skipped: sensitive mode' : undefined;
    if (!screenshotSkipped) {
      try {
        const png = await d.screenshot();
        shotUri = sessions.saveArtifact(
          session,
          'screenshot',
          `smoke-baseline-${Date.now()}.png`,
          png,
          'image/png',
          'qa_smoke baseline evidence',
        );
        sessions.bump(session, 'screenshots');
      } catch {
        /* best-effort */
      }
    }
    const outcome: TestOutcome = !health.nativeHealthy || health.appStatus === 'error' ? 'fail' : 'pass';
    note({
      workflow: 'launch_smoke',
      outcome,
      category: outcome === 'fail' ? 'app_bug' : undefined,
      reason:
        `native=${health.nativeHealthy ? 'ok' : health.nativeStatus} app=${health.appStatus}` +
        (quality ? ` quality=${quality}` : '') +
        (screenshotSkipped ? ` (${screenshotSkipped})` : ''),
      artifactUris: shotUri ? [shotUri] : undefined,
    });
    baseline.launch = {
      outcome,
      nativeHealth: health.nativeHealthy ? 'ok' : health.nativeStatus,
      appHealth: health.appStatus,
      quality,
      screenshotUri: shotUri,
      ...(screenshotSkipped ? { screenshotSkipped } : {}),
    };
  } catch (e) {
    if (isAbortError(e)) {
      cancelled = true;
      note({ workflow: 'launch_smoke', outcome: 'skipped', category: 'intentionally_skipped', reason: CANCELLED_REASON });
      baseline.launch = { outcome: 'skipped', cancelled: true };
    } else {
      note({ workflow: 'launch_smoke', outcome: 'fail', category: 'mcp_limitation', reason: `baseline failed: ${String(e)}` });
      baseline.launch = { outcome: 'fail', error: String(e) };
    }
  }

  // ---- run saved flows ----
  const flowResults: SmokeResult['flows'] = [];
  if (!cancelled && (opts.runFlows ?? true)) {
    for (const f of listFlowFiles(session.root)) {
      if (isAbortError(undefined)) {
        cancelled = true;
        break;
      }
      const stop = sessions.budgetStop(session);
      if (stop) {
        note({ workflow: f.name, outcome: 'skipped', category: 'intentionally_skipped', reason: `budget: ${stop}` });
        flowResults.push({ name: f.name, passed: false, reason: `skipped (budget)` });
        continue;
      }
      const { flow, errors } = parseFlow(readFileSync(f.path, 'utf8'));
      if (errors.length || !flow) {
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'other',
          reason: `flow invalid: ${errors[0] ?? 'parse error'}`,
          requiredState: 'a valid flow file',
        });
        flowResults.push({ name: f.name, passed: false, reason: 'invalid flow' });
        continue;
      }
      const mutating = mutatingSteps(flow);
      if (mutating.length) {
        const reason = `mutating flow requires explicit qa_flow_run consent or CI policy: ${mutating.map((m) => `${m.step}:${m.kind}`).join(', ')}`;
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'destructive_refused',
          reason,
          recommendedSetup:
            'Run this flow with qa_flow_run and approve the flow_mutation_run consent, or run it through a CI policy that allowlists the mutation.',
        });
        flowResults.push({ name: f.name, passed: false, reason });
        continue;
      }
      const providerSteps = externalProviderSteps(flow);
      if (providerSteps.length) {
        const reason = `external visual-provider flow requires explicit qa_flow_run consent: ${providerSteps.map((m) => `${m.step}:${m.kind}`).join(', ')}`;
        note({
          workflow: f.name,
          outcome: 'blocked',
          category: 'destructive_refused',
          reason,
          recommendedSetup: 'Run this flow with qa_flow_run and approve the provider consent, or run it through reviewed CI configuration.',
        });
        flowResults.push({ name: f.name, passed: false, reason });
        continue;
      }
      let r: FlowRunResult;
      try {
        r = await runFlow(sessions, session, d, flow, { variables: opts.variables });
      } catch (e) {
        if (isAbortError(e)) {
          cancelled = true;
          note({ workflow: f.name, outcome: 'skipped', category: 'intentionally_skipped', reason: CANCELLED_REASON });
          flowResults.push({ name: f.name, passed: false, reason: 'cancelled' });
          break;
        }
        note({ workflow: f.name, outcome: 'fail', category: 'mcp_limitation', reason: `flow run error: ${String(e)}` });
        flowResults.push({ name: f.name, passed: false, reason: String(e) });
        continue;
      }
      if (!r.passed && (r.failureCode === 'CANCELLED' || isAbortError(undefined))) {
        cancelled = true;
        note({ workflow: f.name, outcome: 'skipped', category: 'intentionally_skipped', reason: CANCELLED_REASON });
        flowResults.push({ name: f.name, passed: false, failedAtStep: r.failedAtStep, reason: 'cancelled' });
        break;
      }
      const failShot = r.steps.find((s) => s.screenshotUri)?.screenshotUri;
      note({
        workflow: f.name,
        outcome: r.passed ? 'pass' : 'fail',
        category: r.passed ? undefined : 'app_bug',
        reason: r.passed
          ? `${r.steps.length} steps in ${Math.round(r.durationMs / 100) / 10}s`
          : `failed at step ${r.failedAtStep}: ${r.reason}`,
        artifactUris: failShot ? [failShot] : undefined,
      });
      flowResults.push({ name: f.name, passed: r.passed, failedAtStep: r.failedAtStep, reason: r.reason });
    }
  }

  return {
    baseline,
    flows: flowResults,
    flowsPassed: flowResults.filter((f) => f.passed).length,
    flowsTotal: flowResults.length,
    ...(cancelled ? { cancelled: true } : {}),
  };
}
