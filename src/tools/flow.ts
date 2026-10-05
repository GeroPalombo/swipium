// qa_flow_check + qa_flow_run: turn exploration into repeatable QA.
// Flows live as .swipium/flows/*.yaml. check = parse + static validation (no device).
// run (mode:"run", default) = the orchestrator (src/flows/run.ts), reporting the exact failing
// step + evidence. run (mode:"plan", 1.5.0 consolidation) = read-only execution preview:
// compile the flow against backend capabilities without touching a device.

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, qaStop, qaAnnotate, unknownSessionError } from '../lib/result.js';
import {
  FLOW_ENV_PREFIX,
  isMutatingFlowStep,
  lookupFlowVar,
  parseFlow,
  SECRET_VAR_NAME,
  type Flow,
  type FlowStep,
} from '../flows/schema.js';
import { seedExactCommand } from '../flows/seedExec.js';
import { withinRootOrNull } from '../flows/paths.js';
import { makeRedactor } from '../lib/redact.js';
import type { FixtureSeed } from '../session/store.js';
import { lintFlowObjectWithOptions } from '../flows/lint.js';
import { runFlow } from '../flows/run.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import { loadPolicy } from '../report/policy.js';
import { classifyFlakeResults } from '../report/flake.js';
import { validateCiMutationPolicy, validateCiVariables } from '../ci/preflight.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import { displayArgv } from '../lib/commandTemplate.js';
import { GitScopeForbiddenError } from '../lib/spawn.js';
import { configuredOcrCommand } from '../visual/ocr.js';
import { resolveMaskProvider, resolveVisualProvider } from '../visual/provider.js';
import { backendCapabilities, backendForDriverKind, type AppiumSessionHints } from '../automation/capabilities.js';
import { compileAutomationPlan } from '../automation/plan.js';
import { buildReadiness } from '../automation/report.js';
import type { AutomationBackend } from '../automation/types.js';
import type { SessionStore } from '../session/store.js';
import { resolveProjectRoot } from '../context/projectRoot.js';

const ALL_BACKENDS: AutomationBackend[] = ['android-direct', 'ios-raw-simulator', 'ios-wda', 'appium-uiautomator2', 'appium-xcuitest'];

const STATUS_ICON: Record<string, string> = { ready: '✅', candidate: '🟡', blocked: '⛔' };

export type FlowSourceErrorCode = 'FLOW_NOT_FOUND' | 'INVALID_ARGUMENT' | 'INVALID_FLOW';

/** Resolve a flow's YAML from explicit text, an absolute/relative path, or a name under .swipium/flows. */
export function loadFlowSource(
  root: string | undefined,
  flow?: string,
  flowYaml?: string,
): { yamlText?: string; source?: string; error?: string; errorCode?: FlowSourceErrorCode } {
  if (flowYaml && flowYaml.trim()) return { yamlText: flowYaml, source: 'inline' };
  if (!flow) return { error: 'Provide a flow name, a path, or flowYaml.', errorCode: 'INVALID_ARGUMENT' };
  const candidates: string[] = [];
  if (isAbsolute(flow)) candidates.push(flow);
  else if (root) {
    if (/[\\/]/.test(flow) || /\.ya?ml$/i.test(flow)) candidates.push(join(root, flow));
    candidates.push(
      join(root, '.swipium', 'flows', `${flow}.yaml`),
      join(root, '.swipium', 'flows', `${flow}.yml`),
      join(root, '.swipium', 'flows', flow),
    );
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { yamlText: readFileSync(p, 'utf8'), source: p };
      } catch (e) {
        return { error: `Could not read ${p}: ${String(e)}`, errorCode: 'INVALID_FLOW' };
      }
    }
  }
  return {
    error: `Flow not found. Looked for: ${candidates.join(', ') || '(no project root; pass projectRoot or set SWIPIUM_PROJECT_ROOT)'}`,
    errorCode: 'FLOW_NOT_FOUND',
  };
}

/**
 * The project root a flow tool reads from: explicit projectRoot arg > the session's root >
 * resolveProjectRoot (MCP roots > SWIPIUM_PROJECT_ROOT/CLAUDE_PROJECT_DIR > cwd marker), like
 * every other root-aware tool. Undefined only when nothing resolves (inline flowYaml still works).
 */
async function flowRoot(server: McpServer, sessionRoot: string | undefined, projectRoot?: string): Promise<string | undefined> {
  if (!projectRoot && sessionRoot) return sessionRoot;
  const resolved = await resolveProjectRoot(server, projectRoot);
  return resolved.root ?? sessionRoot;
}

function flowSourceError(src: { error?: string; errorCode?: FlowSourceErrorCode }) {
  return qaError({
    what: src.error ?? 'Flow could not be loaded',
    changedState: false,
    retrySafe: true,
    failureCode: src.errorCode ?? 'FLOW_NOT_FOUND',
    nextSteps: [
      src.errorCode === 'INVALID_ARGUMENT'
        ? 'Pass flow="<name>" (under .swipium/flows), a .yaml path, or inline flowYaml.'
        : 'Pass an existing flow name/path or inline flowYaml; pass projectRoot (or set SWIPIUM_PROJECT_ROOT) if the flow lives in another project.',
    ],
  });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}

function fullHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function hash(value: unknown): string {
  return fullHash(value).slice(0, 16);
}

function allFlowSteps(flow: Flow): FlowStep[] {
  return [...flow.setup, ...flow.steps, ...flow.teardown];
}

/** Where a seed's command came from, stated in consent: fixtures are loaded from the repo's
 *  .swipium/fixtures.json (or qa_start_session fixtures). Swipium never reviewed them. */
const SEED_ORIGIN = 'declared fixture (.swipium/fixtures.json or qa_start_session fixtures), repo-supplied, UNREVIEWED';

/** `${VAR}` URL preview for consent: the URL as it will be opened, with credential-like variable
 *  values and registered session secrets masked, plus where each variable is read from. */
function openUrlPreview(url: string, vars: Record<string, string>, secrets: Iterable<string>) {
  const variables: Array<{ name: string; source: 'variables' | 'env' | 'missing' }> = [];
  const resolved = url.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = lookupFlowVar(name, vars);
    variables.push({ name, source: v == null ? 'missing' : vars[name] != null ? 'variables' : 'env' });
    if (v == null) return `\${${name}}`;
    return SECRET_VAR_NAME.test(name) ? `«${name}»` : v;
  });
  return { url, resolvedUrl: makeRedactor(secrets)(resolved) ?? resolved, variables };
}

function flowMutationAffects(
  flow: Flow,
  session: { appId?: string; fixtures: Array<{ name: string; seed?: FixtureSeed }>; secrets?: Iterable<string> },
  source: string | undefined,
  repeat: number,
  externalProviders: Array<Record<string, unknown>> = [],
  vars: Record<string, string> = {},
) {
  const mutations = allFlowSteps(flow)
    .map((step, index) => {
      if (!isMutatingFlowStep(step)) return null;
      if (step.kind === 'seed') {
        const seed = session.fixtures.find((f) => f.name === step.fixture)?.seed;
        return {
          step: index + 1,
          kind: step.kind,
          fixture: step.fixture,
          seedType: seed?.type ?? 'unknown',
          // The EXACT argv / URL the seed will run. Consent must show what executes.
          command: seed ? seedExactCommand(seed) : null,
          origin: SEED_ORIGIN,
        };
      }
      if (step.kind === 'openUrl') return { step: index + 1, kind: step.kind, ...openUrlPreview(step.url, vars, session.secrets ?? []) };
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

/** One line per mutating step for the consent's exactCommand (seeds show their argv/URL). */
function mutationCommandLines(affects: ReturnType<typeof flowMutationAffects>): string[] {
  return affects.mutations.map((m) => {
    if (m.kind === 'seed' && 'fixture' in m)
      return `${m.step}:seed ${m.fixture} [${m.seedType}] > ${m.command ?? '(no seed spec, step will fail)'}  (repo-supplied, unreviewed)`;
    if (m.kind === 'openUrl' && 'resolvedUrl' in m)
      return `${m.step}:openUrl ${m.resolvedUrl}  (variables: ${m.variables.map((v) => `${v.name}←${v.source}`).join(', ')})`;
    return `${m.step}:${m.kind}`;
  });
}

function flowMutationRisk(affects: ReturnType<typeof flowMutationAffects>): 'low' | 'medium' | 'high' {
  if (affects.mutations.some((m) => m.kind === 'seed' && m.seedType === 'script')) return 'high';
  if (
    affects.externalProviders.length ||
    affects.mutations.some((m) => m.kind === 'networkOffline' || m.kind === 'networkOnline' || m.kind === 'seed' || m.kind === 'openUrl')
  )
    return 'medium';
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

const LOCATOR_FAILURES = new Set(['ELEMENT_NOT_FOUND', 'AMBIGUOUS_SELECTOR', 'STALE_REF', 'INVALID_SELECTOR', 'ASSERTION_FAILED']);

/** nextSteps for a failed qa_flow_run: point at qa_flow_repair for the failing step. */
export function failedFlowNextSteps(name: string, flowArg: string | undefined, failedAtStep?: number, failureCode?: string): string[] {
  const out: string[] = [];
  // A missing variable is not locator drift: qa_flow_repair cannot fix it (and a cancelled run is
  // not a failure to repair).
  if (failedAtStep != null && failureCode !== 'MISSING_FIXTURE' && failureCode !== 'CANCELLED') {
    const target = flowArg ? `flow:"${flowArg}"` : 'flowYaml:<same YAML>';
    out.push(
      `${failureCode && !LOCATOR_FAILURES.has(failureCode) ? 'If this is locator drift (renamed/moved control), ' : ''}call qa_flow_repair { ${target}, failedStep:${failedAtStep} } for a reviewable locator fix (review before apply).`,
    );
  }
  if (failureCode === 'MISSING_FIXTURE')
    out.push(`Pass missing values via qa_flow_run { variables } (flows read process.env only for ${FLOW_ENV_PREFIX}* names).`);
  out.push(`If the app itself is wrong, record it with qa_note { workflow:"${name}", outcome:"fail" } with the step evidence.`);
  return out;
}

export function registerFlow(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_flow_check',
    {
      title: 'Check a flow',
      description:
        'Validate a flow (flow name/path or flowYaml) without running it: schema errors with the offending step, plus ' +
        'warnings. Per-backend preview: qa_flow_run mode:"plan".',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional().describe('Absolute app root.'),
        flow: z.string().optional().describe('Flow name under .swipium/flows, or a path to a .yaml file.'),
        flowYaml: z.string().optional().describe('Inline flow YAML (instead of a file).'),
        platform: z.enum(['android', 'ios', 'cross-platform']).optional().describe('Authoring target for platform-aware warnings.'),
        ci: z.boolean().optional().describe('Add CI preflight warnings (missing variables, forbidden mutating steps).'),
      },
    },
    async ({ sessionId, projectRoot, flow, flowYaml, platform, ci }) => {
      const root = await flowRoot(server, sessionId ? sessions.get(sessionId)?.root : undefined, projectRoot);
      const src = loadFlowSource(root, flow, flowYaml);
      if (src.error) return flowSourceError(src);

      const { flow: parsed, errors } = parseFlow(src.yamlText!);
      if (errors.length || !parsed) {
        return qaError(
          {
            what: `Flow is invalid (${errors.length} error${errors.length === 1 ? '' : 's'})`,
            changedState: false,
            retrySafe: true,
            failureCode: 'INVALID_FLOW',
            nextSteps: ['Fix the listed errors and re-check.'],
          },
          { source: src.source, errors },
        );
      }
      const allSteps = [...parsed.setup, ...parsed.steps, ...parsed.teardown];
      const STRUCTURED_KINDS = new Set(['tap', 'assertVisible', 'assertNotVisible', 'scrollTo', 'waitForVisible', 'inputText']);
      const warnings: string[] = [];
      if (!parsed.appId) warnings.push("No appId, so a prepareTarget step will rely on the session's prepared appId.");
      if (allSteps.some((s) => s.kind === 'tap' && s.selector.startsWith('@')))
        warnings.push('Uses @ref selectors. Refs are run-time only; prefer text/id selectors for durable flows.');
      if (src.yamlText!.includes('${'))
        warnings.push(
          `Uses \${VARIABLES}. Provide them via qa_flow_run { variables }, stored session inputs, or ${FLOW_ENV_PREFIX}* environment variables (other env names are never read).`,
        );
      const flowOcrSteps = ocrSteps(parsed);
      if (flowOcrSteps.length) {
        warnings.push(
          `Uses OCR visual-provider steps (${flowOcrSteps.map((s) => `${s.step}:${s.kind}`).join(', ')}); qa_flow_run will require provider consent and a configured ocrCommand.`,
        );
        if (root && !configuredOcrCommand(root)) warnings.push('OCR command is not configured in .swipium/config.json or SWIPIUM_OCR_CMD.');
      }

      // Backend/mode combination check (caught before runtime where the session's backend is known).
      const driverKind = sessionId ? sessions.get(sessionId)?.driver?.kind : undefined;
      const inferredPlatform =
        platform ?? (driverKind === 'simulator' || driverKind === 'wda' ? 'ios' : driverKind === 'direct' ? 'android' : undefined);
      const usesStructured = allSteps.some((s) => STRUCTURED_KINDS.has(s.kind));
      if (driverKind === 'simulator' && parsed.mode === 'structured') {
        warnings.push(
          'mode:structured on the iOS simulator backend. tap/assertVisible/inputText need a UI tree (unavailable). Use mode: visual with image/visual steps.',
        );
      }
      if (parsed.mode === 'visual' && usesStructured) {
        warnings.push(
          'mode:visual but the flow uses structured steps (tap/assertVisible/…). Those need a UI tree and will fail on a visual-only screen.',
        );
      }
      for (const s of allSteps) {
        const text =
          s.kind === 'tap'
            ? s.selector
            : s.kind === 'inputText'
              ? (s.into ?? s.value)
              : 'query' in s && typeof s.query === 'string'
                ? s.query
                : '';
        if (!text) continue;
        if (inferredPlatform === 'ios' && /resource-id=|uiautomator|android\./i.test(text))
          warnings.push(`Android-specific locator in iOS flow: "${text}". Prefer accessibilityIdentifier/name/label on iOS.`);
        if (inferredPlatform === 'android' && /class chain|predicate string|XCUIElementType|accessibility id=/i.test(text))
          warnings.push(`iOS-specific locator in Android flow: "${text}". Prefer resource-id/content-desc/text on Android.`);
        if (
          inferredPlatform === 'cross-platform' &&
          /(resource-id=|uiautomator|android\.|accessibility id=|class chain|predicate string|XCUIElementType|xpath=|^\/\/)/i.test(text)
        ) {
          warnings.push(
            `Platform-specific or brittle locator in cross-platform flow: "${text}". Prefer shared text/testID/accessibility labels.`,
          );
        }
      }
      if (ci) {
        const policy = root ? loadPolicy(root) : null;
        const mutationViolations = validateCiMutationPolicy([parsed], policy).violations;
        for (const v of mutationViolations)
          warnings.push(
            `CI policy: ${v.flow} step ${v.step} ${v.kind} is mutating and is not allowed by .swipium/policy.json ciAllowMutations.`,
          );
        const missingVars = validateCiVariables([parsed]).missing;
        for (const v of missingVars)
          warnings.push(`CI variable: ${v.variable} is required by ${v.flow} step ${v.step} but is not set in the environment.`);
      }
      const lintFindings = lintFlowObjectWithOptions(src.source ?? 'inline', parsed, {
        platform,
        policy: ci ? (root ? loadPolicy(root) : null) : undefined,
      });
      for (const f of lintFindings) {
        const prefix = f.severity === 'error' ? 'Lint error' : 'Lint warning';
        warnings.push(`${prefix} ${f.code}${f.step ? ` step ${f.step}` : ''}: ${f.message}`);
      }
      // Image-template steps: verify the referenced files exist (best-effort, when a root is known).
      if (root) {
        for (const s of allSteps) {
          if (s.kind === 'tapImage' || s.kind === 'assertImage') {
            const p = withinRootOrNull(root, s.template);
            if (!p) warnings.push(`image template outside the project root: ${s.template}; qa_flow_run will refuse it.`);
            else if (!existsSync(p)) warnings.push(`image template not found: ${s.template} (resolve relative to the project root).`);
          }
        }
      }

      return qaOk(
        {
          valid: true,
          source: src.source,
          name: parsed.name,
          appId: parsed.appId ?? null,
          mode: parsed.mode,
          budgetProfile: parsed.budgetProfile ?? null,
          stepCount: parsed.steps.length,
          setupCount: parsed.setup.length,
          teardownCount: parsed.teardown.length,
          fixtures: parsed.fixtures,
          warnings,
          lintFindings,
        },
        `✅ flow "${parsed.name}" is valid: ${parsed.steps.length} steps (mode=${parsed.mode}${parsed.setup.length ? `, ${parsed.setup.length} setup` : ''}${parsed.teardown.length ? `, ${parsed.teardown.length} teardown` : ''})${warnings.length ? `\nwarnings:\n - ${warnings.join('\n - ')}` : ''}`,
      );
    },
  );

  server.registerTool(
    'qa_flow_run',
    {
      title: 'Run a flow (or preview its execution plan)',
      description:
        'Run a flow on the prepared app (mode:"run", default) or preview per-backend support without a device (mode:"plan"). ' +
        'run is server-side and fail-fast with setup/teardown; mutating and OCR steps are consent-gated; a failure returns ' +
        'the step, screenshot, failureCode, and health. Pass flow (name/path) or flowYaml, plus variables. Steps: ' +
        'docs/tools.md#flow-steps.',
      inputSchema: {
        mode: z.enum(['plan', 'run']).optional(),
        sessionId: z.string().optional().describe('Required for run.'),
        projectRoot: z.string().optional().describe('plan: absolute app root for flow names.'),
        flow: z.string().optional().describe('Flow name under .swipium/flows, or a .yaml path.'),
        flowYaml: z.string().optional().describe('Inline flow YAML.'),
        variables: z
          .record(z.string(), z.string())
          .optional()
          .describe('run: ${VAR} values (over session inputs and SWIPIUM_* env); secret-like names are redacted.'),
        repeat: z.number().int().min(1).max(10).optional().describe('run: repeat N times to classify flakes.'),
        consentId: z.string().optional().describe('run: consent for mutating / OCR steps.'),
        approve: z.boolean().optional(),
        backend: z
          .enum(['android-direct', 'ios-raw-simulator', 'ios-wda', 'appium-uiautomator2', 'appium-xcuitest'])
          .optional()
          .describe('plan: only this backend (default all five).'),
        appium: z
          .object({
            automationName: z.string().optional(),
            platformName: z.string().optional(),
            webviewContextsAvailable: z.boolean().optional(),
          })
          .optional()
          .describe('plan: Appium session hints.'),
      },
    },
    async ({ mode, sessionId, projectRoot, flow, flowYaml, variables, repeat, consentId, approve, backend, appium }) => {
      const effectiveMode = mode ?? 'run';
      const notes: string[] = [];

      // ---- mode:"plan": read-only execution preview (merged twin, 1.5.0). ----
      if (effectiveMode === 'plan') {
        const ignored = [
          variables !== undefined && 'variables',
          repeat !== undefined && 'repeat',
          consentId !== undefined && 'consentId',
          approve !== undefined && 'approve',
        ].filter((x): x is string => !!x);
        if (ignored.length)
          notes.push(`ignored parameter(s) not applicable to mode:"plan": ${ignored.join(', ')}; re-run with mode:"run" to execute`);

        const session = sessionId ? sessions.get(sessionId) : undefined;
        const root = await flowRoot(server, session?.root, projectRoot);
        const src = loadFlowSource(root, flow, flowYaml);
        if (src.error) return qaAnnotate(flowSourceError(src), notes);

        const { flow: parsed, errors } = parseFlow(src.yamlText!);
        if (errors.length || !parsed) {
          return qaAnnotate(
            qaError(
              {
                what: `Flow is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}), run qa_flow_check`,
                changedState: false,
                retrySafe: true,
                failureCode: 'INVALID_FLOW',
                nextSteps: ['Fix the listed errors and re-plan.'],
              },
              { source: src.source, errors },
            ),
            notes,
          );
        }

        const appiumHints: AppiumSessionHints | undefined = appium ? { ...appium } : undefined;
        const attachedBackend = session?.driver?.kind ? backendForDriverKind(session.driver.kind, appiumHints) : undefined;

        // Which backends to plan for: an explicit one, else all concrete backends (so the answer covers
        // Android + iOS even with no device attached: the pre-run "can this run?" product question).
        const targets: AutomationBackend[] = backend ? [backend] : [...ALL_BACKENDS];
        if (attachedBackend && attachedBackend !== 'unknown' && !targets.includes(attachedBackend)) targets.unshift(attachedBackend);

        const plans = targets.map((b) => {
          const caps = backendCapabilities(b, appiumHints);
          const plan = compileAutomationPlan(parsed, caps);
          const readiness = buildReadiness(plan);
          return {
            backend: b,
            attached: b === attachedBackend,
            status: readiness.status,
            headline: readiness.headline,
            executable: plan.executable,
            supportedSteps: readiness.supportedSteps,
            unsupportedSteps: readiness.unsupportedSteps,
            fallbackUsed: readiness.fallbackUsed,
            agentMessage: readiness.agentMessage,
            developerMessage: readiness.developerMessage,
            blockers: readiness.blockers,
            warnings: readiness.warnings,
            steps: plan.steps.map((s) => ({
              index: s.index,
              kind: s.action.kind,
              target: s.action.note,
              support: s.support,
              reason: s.reason,
              requiredCapability: s.requiredCapability,
            })),
          };
        });

        const summaryLines = plans.map((p) => {
          const head = `${STATUS_ICON[p.status] ?? '•'} ${p.backend}${p.attached ? ' (attached)' : ''}: ${p.status}, ${p.supportedSteps} supported, ${p.unsupportedSteps} unsupported`;
          return `${head}\n   ${p.agentMessage}`;
        });
        const summary = `flow "${parsed.name}": automation plan across ${plans.length} backend(s) (mode:"plan", read-only, nothing executed):\n${summaryLines.join('\n')}`;

        return qaAnnotate(
          qaOk({ flow: parsed.name, appId: parsed.appId ?? null, mode: parsed.mode, source: src.source, plans }, summary),
          notes,
        );
      }

      // ---- mode:"run": execute on the prepared device. ----
      const runIgnored = [
        backend !== undefined && 'backend',
        appium !== undefined && 'appium',
        projectRoot !== undefined && 'projectRoot',
      ].filter((x): x is string => !!x);
      if (runIgnored.length)
        notes.push(`ignored parameter(s) not applicable to mode:"run": ${runIgnored.join(', ')}; they refine the mode:"plan" preview`);

      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return qaAnnotate(unknownSessionError(sessionId), notes);
      const { driver, blocked } = session ? await getDriver(session) : { driver: undefined, blocked: undefined };
      if (!session || !driver) {
        const refused = blockedDeviceResult(blocked);
        if (refused) return qaAnnotate(refused, notes);
        return qaAnnotate(
          qaError({
            what: sessionId
              ? 'No device attached to this session'
              : 'qa_flow_run mode:"run" needs a sessionId with a prepared device (mode:"plan" works without one)',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target / qa_ios boot first, then qa_flow_run.'],
          }),
          notes,
        );
      }

      const src = loadFlowSource(session.root, flow, flowYaml);
      if (src.error) return qaAnnotate(flowSourceError(src), notes);
      const { flow: parsed, errors } = parseFlow(src.yamlText!);
      if (errors.length || !parsed) {
        return qaAnnotate(
          qaError(
            {
              what: `Flow is invalid. Run qa_flow_check first`,
              changedState: false,
              retrySafe: true,
              failureCode: 'INVALID_FLOW',
              nextSteps: ['Fix the flow and re-run.'],
            },
            { errors },
          ),
          notes,
        );
      }

      // Backend/mode gate (catch unsupported combos before running). A structured-mode
      // flow needs a UI tree, which the iOS simulator and a visual-fallback session don't have.
      if (parsed.mode === 'structured' && (driver.kind === 'simulator' || session.mode === 'visual-fallback')) {
        return qaAnnotate(
          qaError({
            what: `This flow is mode:structured but ${driver.kind === 'simulator' ? 'the iOS simulator backend has no UI tree' : 'the session is in visual-fallback'}`,
            changedState: false,
            retrySafe: false,
            failureCode: 'BACKEND_UNSUPPORTED',
            nextSteps: [
              'Author the flow with `mode: visual` (or auto) and use image/visual steps (tapImage/assertImage/assertDiff/assertVisual).',
            ],
          }),
          notes,
        );
      }

      const budget = sessions.budgetStop(session);
      if (budget) return qaAnnotate(qaStop(budget, { counters: session.counters }), notes);

      const runs = repeat ?? 1;
      const externalProviderSteps = ocrSteps(parsed);
      const externalProviders: Array<Record<string, unknown>> = [];
      if (externalProviderSteps.length) {
        if (session.sensitive) {
          return qaAnnotate(
            qaError({
              what: 'Sensitive mode refuses OCR flow steps because they would pass screenshots to an external provider',
              changedState: false,
              retrySafe: false,
              failureCode: 'UNSAFE_ACTION_REFUSED',
              nextSteps: ['Disable sensitive mode only for a safe, masked QA screen, or remove tapOcrText/assertOcrText from the flow.'],
            }),
            notes,
          );
        }
        const command = configuredOcrCommand(session.root);
        if (!command) {
          return qaAnnotate(
            qaError({
              what: 'Flow uses OCR text steps, but OCR is not configured',
              changedState: false,
              retrySafe: true,
              failureCode: 'VISUAL_ONLY_SCREEN',
              nextSteps: ['Configure ocrCommand in .swipium/config.json or remove tapOcrText/assertOcrText from the flow.'],
            }),
            notes,
          );
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
          return qaAnnotate(
            qaError({
              what: e instanceof GitScopeForbiddenError ? e.message : `Invalid OCR command template: ${String(e)}`,
              changedState: false,
              retrySafe: !(e instanceof GitScopeForbiddenError),
              failureCode: e instanceof GitScopeForbiddenError ? 'GIT_SCOPE_FORBIDDEN' : 'INVALID_FLOW',
              nextSteps:
                e instanceof GitScopeForbiddenError
                  ? ['Run Git yourself outside Swipium; configure ocrCommand to use a non-Git executable.']
                  : ['Use an argv array in .swipium/config.json, e.g. ["node","ocr.js","{image}"].'],
            }),
            notes,
          );
        }
      }
      // Stored session inputs (qa_agent needs_input / first-run credentials) fill ${VAR}s so a
      // generated flow replays without the agent re-sending raw secrets; explicit args win.
      const sessionInputs = sessions.inputVariables(session);
      const runVariables: Record<string, string> = { ...sessionInputs, ...(variables ?? {}) };
      const usedSessionInputs = Object.keys(sessionInputs).filter((k) => variables?.[k] == null);
      if (usedSessionInputs.length) notes.push(`using stored session input(s): ${usedSessionInputs.join(', ')} (values not shown)`);
      const affects = flowMutationAffects(parsed, session, src.source, runs, externalProviders, runVariables);
      const mutationRisk = flowMutationRisk(affects);
      let mutationConsent: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string } = {
        required: false,
        approved: true,
        payloadHash: affects.flowHash,
      };
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
          return qaAnnotate(
            requireConsent({
              action: 'flow_mutation_run',
              risk: mutationRisk,
              exactCommand: `qa_flow_run ${parsed.name} (${[...affects.mutations.map((m) => `${m.step}:${m.kind}`), ...externalProviderSteps.map((s) => `${s.step}:${s.kind}`)].join(', ')})${externalCommand}${mutationCommandLines(affects).length ? `\n${mutationCommandLines(affects).join('\n')}` : ''}`,
              affects,
              explain:
                (affects.externalProviders.length
                  ? `Run flow "${parsed.name}" with external visual provider steps? OCR steps pass ${runs * externalProviderSteps.length} screenshot(s) to the configured provider and any mutating steps can change app/device/test state.`
                  : `Run mutating flow "${parsed.name}"? Mutating steps can change app/device/test state and will be recorded in the mutation ledger.`) +
                (affects.mutations.some((m) => m.kind === 'seed')
                  ? " Seed steps run the exact command/URL shown, taken from the repo's fixture declarations. These are repo-supplied and UNREVIEWED by Swipium; approve only if you trust them."
                  : '') +
                (affects.mutations.some((m) => m.kind === 'openUrl')
                  ? ' openUrl steps interpolate variables into a URL that leaves the test harness, so check the destination.'
                  : ''),
            }),
            notes,
          );
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
          results.push(await runFlow(sessions, session, driver, parsed, { variables: runVariables, mutationConsent }));
        }
        const flake = classifyFlakeResults(results, runs);
        return qaAnnotate(
          qaOk(
            {
              flow: parsed.name,
              runs: results.length,
              passes: flake.passed,
              fails: flake.failed,
              passRate: flake.passRate,
              classification: flake.classification,
              triage: flake.triage,
              results: results.map((r) => ({
                passed: r.passed,
                failedAtStep: r.failedAtStep,
                reason: r.reason,
                failureCode: r.failureCode,
              })),
            },
            `flow "${parsed.name}" × ${results.length}: ${flake.passed} passed, ${flake.failed} failed > ${flake.classification === 'flaky' ? '⚠ FLAKY' : flake.classification === 'deterministic-pass' ? '✅ deterministic-pass' : '❌ deterministic-fail'} (${flake.passRate}% pass-rate); triage=${flake.triage.likelyCause}`,
          ),
          notes,
        );
      }

      const result = await runFlow(sessions, session, driver, parsed, { variables: runVariables, mutationConsent });

      const head =
        `flow "${result.name}" ${result.passed ? '✅ PASSED' : `❌ FAILED at step ${result.failedAtStep} (${result.reason})`} ` +
        `: ${result.steps.filter((s) => s.ok).length}/${result.steps.length} steps in ${Math.round(result.durationMs / 100) / 10}s` +
        (result.appHealth ? `\nhealth: native=${result.nativeHealth} app=${result.appHealth}` : '');
      const stepLines = result.steps
        .map(
          (s) =>
            `${s.ok ? '✓' : '✗'} ${s.index}. ${s.summary}${s.detail ? `: ${s.detail}` : ''}${s.screenshotUri ? `\n   evidence: ${s.screenshotUri}` : ''}`,
        )
        .join('\n');

      // A failed flow is a structured result, not a protocol error. The agent should record it.
      const nextSteps = result.passed ? undefined : failedFlowNextSteps(parsed.name, flow, result.failedAtStep, result.failureCode);
      return qaAnnotate(
        qaOk(
          { ...result, ...(nextSteps ? { nextSteps } : {}) },
          `${head}\n${stepLines}${nextSteps ? `\nnext:\n - ${nextSteps.join('\n - ')}` : ''}`,
        ),
        notes,
      );
    },
  );
}
