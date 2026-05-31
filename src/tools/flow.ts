// qa_flow_check + qa_flow_run.
// Flows live as .swipium/flows/*.yaml. check = parse + static validation (no device).
// run = the orchestrator (src/flows/run.ts), reporting the exact failing step + evidence.

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, qaStop } from '../lib/result.js';
import { parseFlow, type Flow, type FlowStep } from '../flows/schema.js';
import { lintFlowObjectWithOptions } from '../flows/lint.js';
import { runFlow } from '../flows/run.js';
import { getDriver } from '../session/attach.js';
import { loadPolicy } from '../report/policy.js';
import { classifyFlakeResults } from '../report/flake.js';
import { validateCiMutationPolicy, validateCiVariables } from '../ci/preflight.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { displayArgv } from '../lib/commandTemplate.js';
import { GitScopeForbiddenError } from '../lib/spawn.js';
import { configuredOcrCommand } from '../visual/ocr.js';
import { resolveMaskProvider, resolveVisualProvider } from '../visual/provider.js';
import type { SessionStore } from '../session/store.js';

/** Resolve a flow's YAML from explicit text, an absolute/relative path, or a name under .swipium/flows. */
function loadFlowSource(root: string | undefined, flow?: string, flowYaml?: string): { yamlText?: string; source?: string; error?: string } {
  if (flowYaml && flowYaml.trim()) return { yamlText: flowYaml, source: 'inline' };
  if (!flow) return { error: 'Provide a flow name, a path, or flowYaml.' };
  const candidates: string[] = [];
  if (isAbsolute(flow)) candidates.push(flow);
  else if (root) {
    if (/[\\/]/.test(flow) || /\.ya?ml$/i.test(flow)) candidates.push(join(root, flow));
    candidates.push(join(root, '.swipium', 'flows', `${flow}.yaml`), join(root, '.swipium', 'flows', `${flow}.yml`), join(root, '.swipium', 'flows', flow));
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { yamlText: readFileSync(p, 'utf8'), source: p };
      } catch (e) {
        return { error: `Could not read ${p}: ${String(e)}` };
      }
    }
  }
  return { error: `Flow not found. Looked for: ${candidates.join(', ') || '(no project root)'}` };
}

const MUTATING_FLOW_STEPS = new Set<FlowStep['kind']>(['networkOffline', 'networkOnline', 'seed', 'restartApp']);
const EXTERNAL_PROVIDER_FLOW_STEPS = new Set<FlowStep['kind']>(['tapOcrText', 'assertOcrText']);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}

function fullHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function hash(value: unknown): string {
  return fullHash(value).slice(0, 16);
}

function allFlowSteps(flow: Flow): FlowStep[] {
  return [...flow.setup, ...flow.steps, ...flow.teardown];
}

function flowMutationAffects(
  flow: Flow,
  session: { appId?: string; fixtures: Array<{ name: string; seed?: { type: string } }> },
  source: string | undefined,
  repeat: number,
  externalProviders: Array<Record<string, unknown>> = [],
) {
  const mutations = allFlowSteps(flow)
    .map((step, index) => {
      if (!MUTATING_FLOW_STEPS.has(step.kind)) return null;
      if (step.kind === 'seed') {
        const seedType = session.fixtures.find((f) => f.name === step.fixture)?.seed?.type ?? 'unknown';
        return { step: index + 1, kind: step.kind, fixture: step.fixture, seedType };
      }
      return { step: index + 1, kind: step.kind };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return {
    flow: flow.name,
    source: source ?? 'inline',
    flowHash: hash(flow),
    appId: flow.appId ?? session.appId ?? null,
    repeat,
    mutations,
    externalProviders,
  };
}

function flowMutationRisk(affects: ReturnType<typeof flowMutationAffects>): 'low' | 'medium' | 'high' {
  if (affects.mutations.some((m) => m.kind === 'seed' && m.seedType === 'script')) return 'high';
  if (affects.externalProviders.length || affects.mutations.some((m) => m.kind === 'networkOffline' || m.kind === 'networkOnline' || m.kind === 'seed')) return 'medium';
  return 'low';
}

function ocrSteps(flow: Flow): Array<{ step: number; kind: 'tapOcrText' | 'assertOcrText'; query: string; minConfidence?: number }> {
  const out: Array<{ step: number; kind: 'tapOcrText' | 'assertOcrText'; query: string; minConfidence?: number }> = [];
  allFlowSteps(flow).forEach((step, index) => {
    if (step.kind !== 'tapOcrText' && step.kind !== 'assertOcrText') return;
    out.push({ step: index + 1, kind: step.kind, query: step.query, minConfidence: step.minConfidence });
  });
  return out;
}

export function registerFlow(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_flow_check',
    {
      title: 'Check a flow',
      description:
        'Parse and statically validate a Swipium flow (a .swipium/flows/*.yaml authored as name + steps) WITHOUT running it. Reports syntax/schema errors with the offending step, plus warnings (e.g. selector resolvability is only known at run time). Provide `flow` (a name under .swipium/flows, or a path) or `flowYaml` (inline). A sessionId lets it resolve names against that session\'s project root.',
      inputSchema: {
        sessionId: z.string().optional(),
        flow: z.string().optional().describe('Flow name under .swipium/flows, or a path to a .yaml file.'),
        flowYaml: z.string().optional().describe('Inline flow YAML (instead of a file).'),
        platform: z.enum(['android', 'ios', 'cross-platform']).optional().describe('Optional authoring target for platform-aware warnings.'),
        ci: z.boolean().optional().describe('When true, add CI preflight warnings such as missing variables and mutating steps not allowed by policy.'),
      },
    },
    async ({ sessionId, flow, flowYaml, platform, ci }) => {
      const root = sessionId ? sessions.get(sessionId)?.root : undefined;
      const src = loadFlowSource(root, flow, flowYaml);
      if (src.error) return qaError({ what: src.error, changedState: false, retrySafe: true, nextSteps: ['Pass an existing flow name/path or inline flowYaml.'] });

      const { flow: parsed, errors } = parseFlow(src.yamlText!);
      if (errors.length || !parsed) {
        return qaError(
          { what: `Flow is invalid (${errors.length} error${errors.length === 1 ? '' : 's'})`, changedState: false, retrySafe: true, nextSteps: ['Fix the listed errors and re-check.'] },
          { source: src.source, errors },
        );
      }
      const allSteps = [...parsed.setup, ...parsed.steps, ...parsed.teardown];
      const STRUCTURED_KINDS = new Set(['tap', 'assertVisible', 'assertNotVisible', 'scrollTo', 'waitForVisible', 'inputText']);
      const warnings: string[] = [];
      if (!parsed.appId) warnings.push('No appId — a prepareTarget step will rely on the session\'s prepared appId.');
      if (allSteps.some((s) => s.kind === 'tap' && s.selector.startsWith('@'))) warnings.push('Uses @ref selectors — refs are run-time only; prefer text/id selectors for durable flows.');
      if (src.yamlText!.includes('${')) warnings.push('Uses ${VARIABLES} — provide them via qa_flow_run { variables } or the environment.');
      const flowOcrSteps = ocrSteps(parsed);
      if (flowOcrSteps.length) {
        warnings.push(`Uses OCR visual-provider steps (${flowOcrSteps.map((s) => `${s.step}:${s.kind}`).join(', ')}); qa_flow_run will require provider consent and a configured ocrCommand.`);
        if (root && !configuredOcrCommand(root)) warnings.push('OCR command is not configured in .swipium/config.json or SWIPIUM_OCR_CMD.');
      }

      // Backend/mode combination check (caught before runtime where the session's backend is known).
      const driverKind = sessionId ? sessions.get(sessionId)?.driver?.kind : undefined;
      const inferredPlatform = platform ?? (driverKind === 'simulator' || driverKind === 'wda' ? 'ios' : driverKind === 'direct' ? 'android' : undefined);
      const usesStructured = allSteps.some((s) => STRUCTURED_KINDS.has(s.kind));
      if (driverKind === 'simulator' && parsed.mode === 'structured') {
        warnings.push('mode:structured on the iOS simulator backend — tap/assertVisible/inputText need a UI tree (unavailable). Use mode: visual with image/visual steps.');
      }
      if (parsed.mode === 'visual' && usesStructured) {
        warnings.push('mode:visual but the flow uses structured steps (tap/assertVisible/…) — those need a UI tree and will fail on a visual-only screen.');
      }
      for (const s of allSteps) {
        const text = s.kind === 'tap' ? s.selector : s.kind === 'inputText' ? s.into ?? s.value : 'query' in s && typeof s.query === 'string' ? s.query : '';
        if (!text) continue;
        if (inferredPlatform === 'ios' && /resource-id=|uiautomator|android\./i.test(text)) warnings.push(`Android-specific locator in iOS flow: "${text}". Prefer accessibilityIdentifier/name/label on iOS.`);
        if (inferredPlatform === 'android' && /class chain|predicate string|XCUIElementType|accessibility id=/i.test(text)) warnings.push(`iOS-specific locator in Android flow: "${text}". Prefer resource-id/content-desc/text on Android.`);
        if (inferredPlatform === 'cross-platform' && /(resource-id=|uiautomator|android\.|accessibility id=|class chain|predicate string|XCUIElementType|xpath=|^\/\/)/i.test(text)) {
          warnings.push(`Platform-specific or brittle locator in cross-platform flow: "${text}". Prefer shared text/testID/accessibility labels.`);
        }
      }
      if (ci) {
        const policy = root ? loadPolicy(root) : null;
        const mutationViolations = validateCiMutationPolicy([parsed], policy).violations;
        for (const v of mutationViolations) warnings.push(`CI policy: ${v.flow} step ${v.step} ${v.kind} is mutating and is not allowed by .swipium/policy.json ciAllowMutations.`);
        const missingVars = validateCiVariables([parsed]).missing;
        for (const v of missingVars) warnings.push(`CI variable: ${v.variable} is required by ${v.flow} step ${v.step} but is not set in the environment.`);
      }
      const lintFindings = lintFlowObjectWithOptions(src.source ?? 'inline', parsed, { platform, policy: ci ? (root ? loadPolicy(root) : null) : undefined });
      for (const f of lintFindings) {
        const prefix = f.severity === 'error' ? 'Lint error' : 'Lint warning';
        warnings.push(`${prefix} ${f.code}${f.step ? ` step ${f.step}` : ''}: ${f.message}`);
      }
      // Image-template steps: verify the referenced files exist (best-effort, when a root is known).
      if (root) {
        for (const s of allSteps) {
          if ((s.kind === 'tapImage' || s.kind === 'assertImage')) {
            const p = isAbsolute(s.template) ? s.template : join(root, s.template);
            if (!existsSync(p)) warnings.push(`image template not found: ${s.template} (resolve relative to the project root).`);
          }
        }
      }

      return qaOk(
        { valid: true, source: src.source, name: parsed.name, appId: parsed.appId ?? null, mode: parsed.mode, budgetProfile: parsed.budgetProfile ?? null, stepCount: parsed.steps.length, setupCount: parsed.setup.length, teardownCount: parsed.teardown.length, fixtures: parsed.fixtures, warnings, lintFindings },
        `✅ flow "${parsed.name}" is valid — ${parsed.steps.length} steps (mode=${parsed.mode}${parsed.setup.length ? `, ${parsed.setup.length} setup` : ''}${parsed.teardown.length ? `, ${parsed.teardown.length} teardown` : ''})${warnings.length ? `\nwarnings:\n - ${warnings.join('\n - ')}` : ''}`,
      );
    },
  );

  server.registerTool(
    'qa_flow_run',
    {
      title: 'Run a flow',
      description:
        'Run a Swipium flow against the prepared app and report the result. Drives steps server-side: tap/tapAt/tapImage, inputText (incl. { into, text } to focus a named field), assertVisible/assertNotVisible/assertImage/assertVisual/assertDiff, swipe (device-relative { direction, area, distance }), scrollTo, press, openUrl, wait/waitForIdle/waitForVisible, clearOverlay, networkOffline/Online, restartApp, seed, note, screenshot — with optional setup/teardown (teardown always runs) and mode structured|visual|auto. Fail-fast, NO auto-retry of mutating steps; on failure returns the exact failing step + screenshot + typed failureCode + health. Provide `flow` (name/path) or `flowYaml`, plus `variables` for any ${VAR}.',
      inputSchema: {
        sessionId: z.string(),
        flow: z.string().optional(),
        flowYaml: z.string().optional(),
        variables: z.record(z.string()).optional().describe('Values for ${VAR} placeholders (merged over process.env). Credential-looking names are auto-redacted.'),
        repeat: z.number().int().min(1).max(10).optional().describe('Run the flow N times for flake detection (default 1). Reports pass-rate + a deterministic-pass | deterministic-fail | flaky classification.'),
        consentId: z.string().optional().describe('Consent token returned when the flow contains mutating steps or external visual-provider steps such as OCR.'),
        approve: z.boolean().optional().describe('Set true with consentId to execute after reviewing the exact flow hash, mutation list, and external provider command if present.'),
      },
    },
    async ({ sessionId, flow, flowYaml, variables, repeat, consentId, approve }) => {
      const session = sessions.get(sessionId);
      const { driver } = session ? await getDriver(session) : { driver: undefined };
      if (!session || !driver) {
        return qaError({ what: 'No device attached to this session', changedState: false, retrySafe: true, nextSteps: ['Call qa_prepare_target / qa_ios boot first, then qa_flow_run.'] });
      }

      const src = loadFlowSource(session.root, flow, flowYaml);
      if (src.error) return qaError({ what: src.error, changedState: false, retrySafe: true, nextSteps: ['Pass an existing flow name/path or inline flowYaml.'] });
      const { flow: parsed, errors } = parseFlow(src.yamlText!);
      if (errors.length || !parsed) {
        return qaError({ what: `Flow is invalid — run qa_flow_check first`, changedState: false, retrySafe: true, nextSteps: ['Fix the flow and re-run.'] }, { errors });
      }

      // Backend/mode gate (NEXT-PLAN: catch unsupported combos before running). A structured-mode
      // flow needs a UI tree, which the iOS simulator and a visual-fallback session don't have.
      if (parsed.mode === 'structured' && (driver.kind === 'simulator' || session.mode === 'visual-fallback')) {
        return qaError({
          what: `This flow is mode:structured but ${driver.kind === 'simulator' ? 'the iOS simulator backend has no UI tree' : 'the session is in visual-fallback'}`,
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['Author the flow with `mode: visual` (or auto) and use image/visual steps (tapImage/assertImage/assertDiff/assertVisual).'],
        });
      }

      const budget = sessions.budgetStop(session);
      if (budget) return qaStop(budget, { counters: session.counters });

      const runs = repeat ?? 1;
      const externalProviderSteps = ocrSteps(parsed);
      const externalProviders: Array<Record<string, unknown>> = [];
      if (externalProviderSteps.length) {
        if (session.sensitive) {
          return qaError({
            what: 'Sensitive mode refuses OCR flow steps because they would pass screenshots to an external provider',
            changedState: false,
            retrySafe: false,
            failureCode: 'UNSAFE_ACTION_REFUSED',
            nextSteps: ['Disable sensitive mode only for a safe, masked QA screen, or remove tapOcrText/assertOcrText from the flow.'],
          });
        }
        const command = configuredOcrCommand(session.root);
        if (!command) {
          return qaError({
            what: 'Flow uses OCR text steps, but OCR is not configured',
            changedState: false,
            retrySafe: true,
            failureCode: 'VISUAL_ONLY_SCREEN',
            nextSteps: ['Configure ocrCommand in .swipium/config.json or remove tapOcrText/assertOcrText from the flow.'],
          });
        }
        try {
          const preview = resolveVisualProvider(command, { image: '<screenshot>' }, 30000);
          const maskPreview = resolveMaskProvider(session.root);
          externalProviders.push({
            provider: 'ocr',
            steps: externalProviderSteps,
            argv: preview.argv,
            io: preview.io,
            maskConfigured: !!maskPreview,
            maskArgv: maskPreview?.argv ?? null,
            screenshotsSharedWithProvider: runs * externalProviderSteps.length,
          });
        } catch (e) {
          return qaError({
            what: e instanceof GitScopeForbiddenError ? e.message : `Invalid OCR command template: ${String(e)}`,
            changedState: false,
            retrySafe: !(e instanceof GitScopeForbiddenError),
            failureCode: e instanceof GitScopeForbiddenError ? 'GIT_SCOPE_FORBIDDEN' : 'INVALID_FLOW',
            nextSteps: e instanceof GitScopeForbiddenError ? ['Run Git yourself outside Swipium; configure ocrCommand to use a non-Git executable.'] : ['Use an argv array in .swipium/config.json, e.g. ["node","ocr.js","{image}"].'],
          });
        }
      }
      const affects = flowMutationAffects(parsed, session, src.source, runs, externalProviders);
      const mutationRisk = flowMutationRisk(affects);
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } = { required: false, approved: true, payloadHash: affects.flowHash };
      const privileged = affects.mutations.length > 0 || affects.externalProviders.length > 0;
      if (privileged) {
        const payloadHash = fullHash(affects);
        const gate = consumeConsent(consentId, approve, { action: 'flow_mutation_run', affects });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_flow_run',
            action: 'flow_mutation_run',
            risk: mutationRisk,
            target: affects,
            consent: { required: true, approved: false, payloadHash },
            status: 'requested',
          });
          const externalCommand = affects.externalProviders.length
            ? `; external provider: ${displayArgv((affects.externalProviders[0].argv as string[] | undefined) ?? [])}`
            : '';
          return requireConsent({
            action: 'flow_mutation_run',
            risk: mutationRisk,
            exactCommand: `qa_flow_run ${parsed.name} (${[...affects.mutations.map((m) => `${m.step}:${m.kind}`), ...externalProviderSteps.map((s) => `${s.step}:${s.kind}`)].join(', ')})${externalCommand}`,
            affects,
            explain: affects.externalProviders.length
              ? `Run flow "${parsed.name}" with external visual provider steps? OCR steps pass ${runs * externalProviderSteps.length} screenshot(s) to the configured provider and any mutating steps can change app/device/test state.`
              : `Run mutating flow "${parsed.name}"? Mutating steps can change app/device/test state and will be recorded in the mutation ledger.`,
          });
        }
        mutationConsent = { required: true, consentId, approved: true, payloadHash };
        sessions.recordMutation(session, {
          tool: 'qa_flow_run',
          action: 'flow_mutation_run',
          risk: mutationRisk,
          target: affects,
          consent: mutationConsent,
          status: 'approved',
        });
      }

      // Flake detection: run N times and classify (deterministic-pass | deterministic-fail | flaky).
      if (runs > 1) {
        const results = [];
        for (let i = 0; i < runs; i++) {
          const b = sessions.budgetStop(session);
          if (b) break;
          results.push(await runFlow(sessions, session, driver, parsed, { variables, mutationConsent }));
        }
        const flake = classifyFlakeResults(results, runs);
        return qaOk(
          { flow: parsed.name, runs: results.length, passes: flake.passed, fails: flake.failed, passRate: flake.passRate, classification: flake.classification, triage: flake.triage, results: results.map((r) => ({ passed: r.passed, failedAtStep: r.failedAtStep, reason: r.reason, failureCode: r.failureCode })) },
          `flow "${parsed.name}" × ${results.length}: ${flake.passed} passed, ${flake.failed} failed → ${flake.classification === 'flaky' ? '⚠ FLAKY' : flake.classification === 'deterministic-pass' ? '✅ deterministic-pass' : '❌ deterministic-fail'} (${flake.passRate}% pass-rate); triage=${flake.triage.likelyCause}`,
        );
      }

      const result = await runFlow(sessions, session, driver, parsed, { variables, mutationConsent });

      const head =
        `flow "${result.name}" ${result.passed ? '✅ PASSED' : `❌ FAILED at step ${result.failedAtStep} (${result.reason})`} ` +
        `— ${result.steps.filter((s) => s.ok).length}/${result.steps.length} steps in ${result.durationSec}s` +
        (result.appHealth ? `\nhealth: native=${result.nativeHealth} app=${result.appHealth}` : '');
      const stepLines = result.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.index}. ${s.summary}${s.detail ? ` — ${s.detail}` : ''}${s.screenshotUri ? `\n   evidence: ${s.screenshotUri}` : ''}`).join('\n');

      // A failed flow is a structured result, not a protocol error — the agent should record it.
      return qaOk({ ...result }, `${head}\n${stepLines}`);
    },
  );
}
