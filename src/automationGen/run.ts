// "Automate my app". Generates a runnable JS/TS or Python Appium POM suite from a
// session's recorded actions, adapting to the project's language/platform/test stack.
//
//   runAutomationPlan:     read-only core for qa_generate target:"appium" mode:"plan":
//                            project profile + generation plan + blockers.
//   runAutomationGenerate: core for qa_generate target:"appium": emit + write the JS/Python
//                            suite (+ README, optional CI), validate.
//
// The canonical Swipium YAML/POM remains the intermediate model (non-goal: don't replace it). JS/Python
// are emitted on top so they can't drift. Project-file mutation (integrateIntoProject) is consent-gated.
// Both cores are registered through qa_generate (src/tools/generate.ts). This module registers no tool.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { unresolvedProjectRootError } from '../context/projectRoot.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import type { GeneratedFile } from '../suite/pom.js';
import { assembleAutomationSuite, buildAutomationProfile, writeAutomationFiles, mapPresent } from '../services/automationGenerate.js';
import { buildSuitePlan } from './suitePlan.js';
import { buildProjectProfile } from './projectProfile.js';
import { validateGeneratedSuite } from './validation.js';
import { structuralLiterals } from '../suite/secretGuard.js';
import { UnemittableStepError } from './identifiers.js';
import { getDriver } from '../session/attach.js';
import { runExplore } from '../explore/runner.js';
import { ensurePrelaunchAppMap } from '../appMap/prelaunch.js';
import { loadAppMap } from '../appMap/store.js';
import { detectFramework } from '../context/detect.js';
import { deriveAutomationLinks, linkAutomationSuite } from '../appMap/automationLink.js';
import { mergeFromAutomation } from '../services/testSuiteKnowledge.js';
import { bootstrapFeatureExecution } from '../featureTesting/executionBootstrap.js';
import { log } from '../lib/logger.js';
import type { ProjectIdentity } from '../appMap/schema.js';
import type { Session, SessionStore } from '../session/store.js';

type AutomationLanguage = 'auto' | 'javascript' | 'typescript' | 'python';
type AutomationPlatform = 'auto' | 'android' | 'ios' | 'both';

/** Merge a prebuilt appMapUri into a tool result's structured content (Fix 6: a bootstrap blocker
 *  still built the static map, so the URI must survive on the returned blocker/consent result). */
function withAppMapUri(result: CallToolResult, appMapUri?: string): CallToolResult {
  if (!appMapUri) return result;
  const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (sc.appMapUri) return result;
  return { ...result, structuredContent: { ...sc, appMapUri } };
}

function resolveRoot(sessions: SessionStore, sessionId?: string, projectRoot?: string): { session?: Session; root?: string } {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) return { session, root: session.root };
  }
  return { root: projectRoot };
}

/** profileInputs from tool args. */
function profileInputs(language?: AutomationLanguage, platform?: AutomationPlatform, integrateIntoProject?: boolean) {
  return {
    language: (language ?? 'auto') as 'auto' | 'javascript' | 'typescript' | 'python',
    platform: (platform ?? 'auto') as 'auto' | 'android' | 'ios' | 'both',
    integrateIntoProject: integrateIntoProject ?? false,
  };
}

export interface AutomationPlanArgs {
  sessionId?: string;
  projectRoot?: string;
  feature?: string;
  language?: AutomationLanguage;
  platform?: AutomationPlatform;
  backend?: 'auto' | 'appium' | 'swipium_flow';
  includeCi?: boolean;
}

/**
 * Core handler for qa_generate target:"appium" mode:"plan". Read-only: inspect the project
 * (language, platform support, existing test stack) and build a plan for an "Automate my app"
 * Appium POM suite: selected automation language, backends, coverage, files planned, blockers.
 */
/** A recorded step the generators cannot express as real code. Fail generation with the reason
 *  instead of writing a suite that silently skips the step (§4). */
function unemittable(e: UnemittableStepError, extra: Record<string, unknown> = {}): CallToolResult {
  return qaError(
    {
      what: `Automation suite not generated: ${e.message}`,
      changedState: false,
      retrySafe: false,
      failureCode: e.code,
      nextSteps: [
        'Re-record the step with qa_act (supported: tap, type, swipe/scroll up|down|left|right, press back|home|enter, open_url), then regenerate.',
      ],
    },
    extra,
  );
}

export async function runAutomationPlan(
  sessions: SessionStore,
  { sessionId, projectRoot, feature, language, platform, backend, includeCi }: AutomationPlanArgs,
): Promise<CallToolResult> {
  const { session, root } = resolveRoot(sessions, sessionId, projectRoot);
  if (!root) return unresolvedProjectRootError({ source: 'none' }, { nextSteps: ['Pass sessionId or an absolute projectRoot.'] });

  const inputs = profileInputs(language, platform);
  const profile = session ? buildAutomationProfile(session, inputs) : buildAutomationProfileFromRoot(root, inputs);

  let plan;
  if (session && session.recordedActions.length) {
    let assembled;
    try {
      assembled = assembleAutomationSuite(session, { ...inputs, includeCi });
    } catch (e) {
      if (e instanceof UnemittableStepError) return unemittable(e);
      throw e;
    }
    plan = assembled.plan;
  } else {
    plan = buildSuitePlan(profile, { actionCount: session?.recordedActions.length ?? 0, mapPresent: mapPresent(root), includeCi });
  }

  const backendNote =
    backend && backend !== 'auto' && backend !== 'appium'
      ? `\nNote: backend=${backend} requested; Appium code is generated as an ADDITIONAL layer; existing ${backend} flows are kept.`
      : '';
  const featureNote = feature ? ` (feature focus: ${feature})` : '';
  const summary =
    `Automation plan${featureNote}: ${profile.automationLanguage} / ${profile.testFramework}, ` +
    `default backend ${profile.defaultBackend}${profile.secondaryBackend ? ` (+${profile.secondaryBackend})` : ''}.\n` +
    `platforms: android=${profile.platforms.android.level}, ios=${profile.platforms.ios.level}\n` +
    (plan.mapCoverage
      ? `coverage: ${plan.mapCoverage.actionCount} step(s), ${plan.mapCoverage.screenCount} screen(s); locators ${plan.locatorReadiness} (${plan.mapCoverage.brittlePct}% brittle)`
      : 'coverage: no recorded actions yet') +
    (plan.blockers.length ? `\nblockers: ${plan.blockers.map((b) => b.code).join(', ')}` : '') +
    `\nfiles planned: ${plan.filesPlanned.length}\nnext: ${plan.nextAction}` +
    backendNote;
  return qaOk({ profile, plan, feature: feature ?? null, backend: backend ?? 'auto' }, summary);
}

export interface AutomationGenerateArgs {
  sessionId?: string;
  projectRoot?: string;
  bootstrap?: boolean | 'auto';
  feature?: string;
  device?: string;
  name?: string;
  language?: AutomationLanguage;
  platform?: AutomationPlatform;
  save?: boolean;
  integrateIntoProject?: boolean;
  includeCi?: boolean;
  candidateOnly?: boolean;
  brittleThreshold?: number;
  consentId?: string;
  approve?: boolean;
}

/**
 * Core handler for qa_generate target:"appium". Generates a runnable Appium POM suite from the
 * session's recorded actions (WebdriverIO TS/JS or Python), bootstrapping a device/session/actions
 * from projectRoot when none exist. Never inlines secrets; integrateIntoProject is consent-gated.
 */
export async function runAutomationGenerate(
  server: McpServer,
  sessions: SessionStore,
  {
    sessionId,
    projectRoot,
    bootstrap,
    feature,
    device,
    name,
    language,
    platform,
    save,
    integrateIntoProject,
    includeCi,
    candidateOnly,
    brittleThreshold,
    consentId,
    approve,
  }: AutomationGenerateArgs,
): Promise<CallToolResult> {
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session)
    return unknownSessionError(sessionId, ['Call qa_start_session first, or omit sessionId to bootstrap from projectRoot.']);

  // Fix 6: one-call "Automate my app": when no session/actions exist, build the static app map
  // (so it always exists) and bootstrap a device (consent-gated) + record actions via exploration.
  const wantBootstrap = bootstrap !== false && (bootstrap === true || bootstrap === 'auto' || !sessionId);
  let appMapUri: string | undefined;
  const rootForMap = session?.root ?? (projectRoot && projectRoot.trim() ? projectRoot.trim() : undefined);
  if (rootForMap && existsSync(rootForMap)) {
    try {
      appMapUri = ensurePrelaunchAppMap(rootForMap, { at: new Date().toISOString() }).appMapUri;
    } catch (e) {
      log('warn', 'automation prelaunch app map failed', { err: String(e) });
    }
  }

  if ((!session || !session.recordedActions.length) && wantBootstrap) {
    let driver = session ? (await getDriver(session)).driver : undefined;
    if (!session || !driver) {
      if (!projectRoot?.trim() && !session) {
        return qaError(
          {
            what: 'Need a sessionId or projectRoot to bootstrap an automation suite',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass projectRoot="/abs/path" (bootstrap defaults on), or a prepared sessionId.'],
          },
          appMapUri ? { appMapUri } : {},
        );
      }
      const boot = await bootstrapFeatureExecution({
        server,
        sessions,
        projectRoot: projectRoot?.trim() ?? session!.root,
        feature: feature ?? 'create automation suite',
        platform: platform === 'android' || platform === 'ios' ? platform : undefined,
        device,
        consentId,
        approve,
      });
      // Honest target blocker / consent request. But the static app map WAS still built, so the
      // caller can read it even though no device/artifact is available (Fix 6 acceptance).
      if (!boot.ok) return withAppMapUri(boot.result, appMapUri);
      session = boot.session;
      driver = boot.driver;
      if (!appMapUri && existsSync(session.root)) {
        try {
          appMapUri = ensurePrelaunchAppMap(session.root, { at: new Date().toISOString() }).appMapUri;
        } catch {
          /* best-effort */
        }
      }
    }
    // Record durable actions via a bounded, safe exploration so generation has something to emit.
    if (driver && !session.recordedActions.length) {
      try {
        await runExplore(sessions, session, driver, { goal: feature, maxScreens: 6, maxActions: 16, stopOnAuth: true });
      } catch (e) {
        log('warn', 'automation bootstrap exploration failed', { err: String(e) });
      }
    }
  }

  if (!session)
    return qaError(
      {
        what: 'Need a sessionId or projectRoot',
        changedState: false,
        retrySafe: true,
        nextSteps: ['Pass a prepared sessionId, or projectRoot to bootstrap.'],
      },
      appMapUri ? { appMapUri } : {},
    );
  if (!session.recordedActions.length) {
    return qaError(
      {
        what: 'No recorded actions to turn into an automation suite (bootstrap could not record any)',
        changedState: false,
        retrySafe: true,
        failureCode: 'NO_RECORDED_ACTIONS',
        nextSteps: [
          'Run qa_test_this { goal: "create_automation_suite" } (smoke + explore records actions + builds the app map), then re-run qa_generate target:"appium".',
          'Or drive the app with qa_act/qa_smoke/qa_explore first.',
        ],
      },
      appMapUri ? { appMapUri } : {},
    );
  }

  const inputs = profileInputs(language, platform, integrateIntoProject);
  let assembled;
  try {
    assembled = assembleAutomationSuite(session, { ...inputs, name, includeCi });
  } catch (e) {
    if (e instanceof UnemittableStepError) return unemittable(e, appMapUri ? { appMapUri } : {});
    throw e;
  }
  const validation = validateGeneratedSuite(assembled.files, {
    brittlePct: assembled.model.audit.brittlePct,
    brittleThreshold,
    candidateOnly,
    secrets: assembled.model.secrets,
    secretValues: session.secrets,
    structural: structuralLiterals(session.recordedActions),
  });
  // Defense in depth: a registered secret value in ANY generated file fails generation loudly,
  // nothing is written (neither the suite nor the test-suite.json merge).
  const leakFindings = validation.findings.filter((f) => f.code === 'SECRET_IN_GENERATED_OUTPUT');
  if (leakFindings.length) {
    return qaError(
      {
        what: `Automation suite not generated: a registered secret value would be written in plaintext (${leakFindings
          .slice(0, 5)
          .map((f) => f.file)
          .join(', ')})`,
        changedState: false,
        retrySafe: false,
        failureCode: 'SECRET_IN_GENERATED_OUTPUT',
        nextSteps: ['Nothing was written. Re-record the credential step so it is captured as a ${VAR}, then regenerate.'],
      },
      { validation, ...(appMapUri ? { appMapUri } : {}) },
    );
  }

  const doSave = save !== false;
  let written: string[] = [];
  let targetDir = assembled.outputDir;
  let integrated = false;
  let skippedExisting: string[] = [];

  if (doSave && integrateIntoProject) {
    // Consent-gated project mutation; never overwrite existing files.
    const projectDir = projectTestDir(session.root, assembled.profile.automationLanguage);
    const affects = { projectDir, files: assembled.files.map((f) => f.path) };
    const gate = consumeConsent(consentId, approve, { action: 'automation_project_write', affects });
    if (!gate.approved) {
      return requireConsent({
        action: 'automation_project_write',
        risk: 'medium',
        exactCommand: `write ${assembled.files.length} files into ${projectDir} (no overwrite)`,
        affects,
        explain: `Write the generated Appium suite into your project at ${projectDir}? Existing files are never overwritten.`,
      });
    }
    const res = writeProjectFilesNoOverwrite(session.root, projectDir, assembled.files);
    written = res.written;
    skippedExisting = res.skipped;
    targetDir = projectDir;
    integrated = true;
    sessions.recordMutation(session, {
      tool: 'qa_generate',
      action: 'automation_project_write',
      risk: 'medium',
      target: affects,
      consent: { required: true, consentId, approved: true },
      status: 'executed',
    });
  } else if (doSave) {
    written = writeAutomationFiles(session.root, assembled.outputDir, assembled.files);
  }

  // Fix 7: link the generated suite back into the durable app map + persistent suite, so future
  // feature/ticket decisions know which flows are automated. Best-effort (warnings, never fatal).
  let suiteDelta: ReturnType<typeof mergeFromAutomation>['delta'] | undefined;
  let suiteUri: string | undefined;
  const automationWarnings: string[] = [];
  if (doSave) {
    const now = new Date().toISOString();
    const screenNames = assembled.model.screens.map((s) => s.pageName || s.className);
    try {
      const fw = detectFramework(session.root);
      const fallback: ProjectIdentity = {
        root: session.root,
        gitRemote: null,
        packageName: null,
        workspaceTarget: null,
        framework: fw,
        platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'],
      };
      const existingMap = loadAppMap(session.root, fallback, now).map;
      const links = existingMap ? deriveAutomationLinks(existingMap, screenNames) : { screenIds: [], featureIds: [] };
      const suiteRef = {
        name: name ?? `swipium-appium-${assembled.profile.automationLanguage}`,
        path: targetDir,
        framework: assembled.profile.automationLanguage === 'python' ? 'appium-python' : 'wdio',
        linkedFeatureIds: links.featureIds,
        linkedScreenIds: links.screenIds,
      };
      const linkRes = linkAutomationSuite(session.root, suiteRef, now);
      if (linkRes.ok) appMapUri = linkRes.appMapUri ?? appMapUri;
      else automationWarnings.push('app map not found; automation suite not linked into the map');
    } catch (e) {
      automationWarnings.push(`app-map automation link failed: ${String(e)}`);
    }
    try {
      const fw2 = detectFramework(session.root);
      const fb2: ProjectIdentity = {
        root: session.root,
        gitRemote: null,
        packageName: null,
        workspaceTarget: null,
        framework: fw2,
        platforms: fw2 === 'native-android' ? ['android'] : fw2 === 'native-ios' ? ['ios'] : ['android', 'ios'],
      };
      const mapForLinks = loadAppMap(session.root, fb2, now).map;
      const links = mapForLinks
        ? deriveAutomationLinks(
            mapForLinks,
            assembled.model.screens.map((s) => s.pageName || s.className),
          )
        : { screenIds: [], featureIds: [] };
      const merge = mergeFromAutomation(
        session.root,
        session,
        { assembled, validationOk: validation.ok, links },
        { source: 'generate', now, runId: `automation-${Date.now()}`, sourceUri: appMapUri, appId: session.appId, sessionId: session.id },
      );
      suiteDelta = merge.delta;
      suiteUri = merge.suiteUri;
      if (merge.warning) automationWarnings.push(merge.warning);
    } catch (e) {
      automationWarnings.push(`suite automation merge failed: ${String(e)}`);
    }
  }

  const a = assembled.model.audit;
  const recommendation = integrated
    ? undefined
    : assembled.profile.outputMode === 'project_native'
      ? 'Copy the suite into your project test dir, or re-run with integrateIntoProject:true (consent-gated).'
      : `Generated under ${assembled.outputDir}. Install deps (${assembled.dependencyPatch.notes[0]}) and run per the README.`;
  const summary =
    `✅ Generated ${assembled.profile.automationLanguage} Appium POM suite (${assembled.model.screens.length} screen(s), ${assembled.files.length} files).\n` +
    `runner ${assembled.profile.testFramework}; backend ${assembled.profile.defaultBackend}${assembled.profile.secondaryBackend ? ` (+${assembled.profile.secondaryBackend})` : ''}\n` +
    `locators: ${a.durable} durable / ${a.semi} semi / ${a.brittle} brittle (${a.brittlePct}% brittle)\n` +
    `validation: ${validation.ok ? 'passed' : 'FAILED'} (${validation.findings.filter((f) => f.severity === 'error').length} error, ${validation.findings.filter((f) => f.severity === 'warning').length} warn); secrets ${validation.secretsClean ? 'clean' : 'LEAK'}\n` +
    (written.length ? `wrote ${written.length} files under ${join(session.root, targetDir)}` : '(preview, pass save:true)') +
    (skippedExisting.length
      ? `\nskipped ${skippedExisting.length} existing file(s) (no overwrite): ${skippedExisting.slice(0, 5).join(', ')}`
      : '') +
    (recommendation ? `\n${recommendation}` : '');
  return qaOk(
    {
      profile: assembled.profile,
      outputDir: targetDir,
      integrated,
      files: assembled.files.map((f) => f.path),
      written,
      skippedExisting,
      screens: assembled.model.screens.map((s) => s.className),
      variables: assembled.model.variables,
      secrets: assembled.model.secrets,
      audit: a,
      validation,
      dependencyPatch: assembled.dependencyPatch,
      plan: assembled.plan,
      appMapUri: appMapUri ?? null,
      suiteDelta: suiteDelta ?? null,
      suiteUri: suiteUri ?? null,
      automationWarnings,
    },
    summary,
  );
}

// ---- helpers that need root-only (no session) profile ----
function buildAutomationProfileFromRoot(root: string, inputs: ReturnType<typeof profileInputs>) {
  return buildProjectProfile(root, inputs);
}

function projectTestDir(root: string, language: 'typescript' | 'javascript' | 'python'): string {
  const candidates = language === 'python' ? ['tests/e2e', 'e2e', 'tests'] : ['e2e', 'test/e2e', 'tests/e2e'];
  const found = candidates.find((c) => existsSync(join(root, c)));
  return found ?? (language === 'python' ? 'tests/e2e' : 'e2e');
}

function writeProjectFilesNoOverwrite(root: string, dir: string, files: GeneratedFile[]): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const abs = join(root, dir, f.path);
    if (existsSync(abs)) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(abs);
  }
  return { written, skipped };
}
