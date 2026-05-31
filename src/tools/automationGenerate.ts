// SWIPIUM-REQ-04 — "Automate my app" MCP tools. Generates a runnable JS/TS or Python Appium POM
// suite from a session's recorded actions, adapting to the project's language/platform/test stack.
//
//   qa_automation_plan     — read-only: project profile + generation plan + blockers.
//   qa_automation_generate — emit + write the JS/Python suite (+ README, optional CI), validate.
//   qa_automation_validate — validate generated code without a device (secrets, durability, syntax).
//
// The canonical Swipium YAML/POM remains the intermediate model (non-goal: don't replace it). JS/Python
// are emitted on top so they can't drift. Project-file mutation (integrateIntoProject) is consent-gated.

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { requireConsent, consumeConsent } from '../consent/consent.js';
import type { GeneratedFile } from '../suite/pom.js';
import {
  assembleAutomationSuite,
  buildAutomationProfile,
  writeAutomationFiles,
  mapPresent,
} from '../services/automationGenerate.js';
import { buildSuitePlan } from '../automationGen/suitePlan.js';
import { buildProjectProfile } from '../automationGen/projectProfile.js';
import { validateGeneratedSuite } from '../automationGen/validation.js';
import { getDriver } from '../session/attach.js';
import { runExplore } from '../explore/runner.js';
import { ensurePrelaunchAppMap } from '../appMap/prelaunch.js';
import { loadAppMap, appMapResourceUri } from '../appMap/store.js';
import { detectFramework } from '../context/detect.js';
import { deriveAutomationLinks, linkAutomationSuite } from '../appMap/automationLink.js';
import { mergeFromAutomation } from '../services/testSuiteKnowledge.js';
import { bootstrapFeatureExecution } from '../featureTesting/executionBootstrap.js';
import { log } from '../lib/logger.js';
import type { ProjectIdentity } from '../appMap/schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Session, SessionStore } from '../session/store.js';

const languageEnum = z.enum(['auto', 'javascript', 'typescript', 'python']);
const platformEnum = z.enum(['auto', 'android', 'ios', 'both']);
const backendEnum = z.enum(['auto', 'appium', 'swipium_flow']);

/** Merge a prebuilt appMapUri into a tool result's structured content (Fix 6 — a bootstrap blocker
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
function profileInputs(language?: z.infer<typeof languageEnum>, platform?: z.infer<typeof platformEnum>, integrateIntoProject?: boolean) {
  return {
    language: (language ?? 'auto') as 'auto' | 'javascript' | 'typescript' | 'python',
    platform: (platform ?? 'auto') as 'auto' | 'android' | 'ios' | 'both',
    integrateIntoProject: integrateIntoProject ?? false,
  };
}

/** Read an already-generated suite from disk for validation (projectRoot path, no session). */
function readGeneratedFromDisk(root: string, outputDir: string): GeneratedFile[] {
  const base = join(root, outputDir);
  if (!existsSync(base)) return [];
  const files: GeneratedFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push({ path: relative(base, abs), content: readFileSync(abs, 'utf8') });
    }
  };
  walk(base);
  return files;
}

export function registerAutomationGenerate(server: McpServer, sessions: SessionStore): void {
  // ---- qa_automation_plan ----
  server.registerTool(
    'qa_automation_plan',
    {
      title: 'Plan an Appium automation suite',
      description:
        'Read-only. Inspect the project (language, platform support, existing test stack) and build a plan for an "Automate my app" Appium POM suite: selected automation language (JS/TS/Python), Android-first/iOS backends, app-map/recorded-action coverage, the files that would be generated, locator readiness, and blockers. Pass sessionId to use recorded actions, or projectRoot to plan from scratch.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        feature: z.string().optional().describe('Optional feature label to focus the suite (recorded for the plan).'),
        language: languageEnum.optional(),
        platform: platformEnum.optional(),
        backend: backendEnum.optional(),
        includeCi: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, feature, language, platform, backend, includeCi }) => {
      const { session, root } = resolveRoot(sessions, sessionId, projectRoot);
      if (!root) return qaError({ what: 'No project root', changedState: false, retrySafe: true, nextSteps: ['Pass sessionId or projectRoot.'] });

      const inputs = profileInputs(language, platform);
      const profile = session ? buildAutomationProfile(session, inputs) : buildAutomationProfileFromRoot(root, inputs);

      let plan;
      if (session && session.recordedActions.length) {
        const assembled = assembleAutomationSuite(session, { ...inputs, includeCi });
        plan = assembled.plan;
      } else {
        plan = buildSuitePlan(profile, { actionCount: session?.recordedActions.length ?? 0, mapPresent: mapPresent(root), includeCi });
      }

      const backendNote = backend && backend !== 'auto' && backend !== 'appium'
        ? `\nNote: backend=${backend} requested — Appium code is generated as an ADDITIONAL layer; existing ${backend} flows are kept.`
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
    },
  );

  // ---- qa_automation_generate ----
  server.registerTool(
    'qa_automation_generate',
    {
      title: 'Generate an Appium automation suite',
      description:
        'Generate a runnable Appium POM suite from this session\'s recorded actions, adapting to the project language: WebdriverIO TS/JS or Python (Appium-Python-Client). Writes page/screen objects (centralized selectors), env-driven capabilities, structured waits, a smoke test, and a README under .swipium/automation/<lang>/ by default. Never inlines secrets; marks brittle/coordinate locators non-release-grade; never emits XPath. integrateIntoProject (consent-gated) writes into the project e2e dir without overwriting existing files.',
      inputSchema: {
        sessionId: z.string().optional().describe('Prepared session with recorded actions. Omit to bootstrap from projectRoot.'),
        projectRoot: z.string().optional().describe('Project root — used to bootstrap a device/session when no sessionId is given (Fix 6 one-call workflow).'),
        bootstrap: z.union([z.boolean(), z.literal('auto')]).optional().describe('Bootstrap the missing map/session/actions safely (smoke+explore) when none exist. Default "auto" when no sessionId is provided.'),
        feature: z.string().optional().describe('Optional focus for the bootstrap exploration.'),
        device: z.string().optional().describe('Specific device/simulator to prepare when bootstrapping.'),
        name: z.string().optional(),
        language: languageEnum.optional(),
        platform: platformEnum.optional(),
        save: z.boolean().optional().describe('Write files (default true).'),
        integrateIntoProject: z.boolean().optional().describe('Write into the project test dir instead of .swipium (consent-gated, never overwrites).'),
        includeCi: z.boolean().optional().describe('Also emit ci.example.yml.'),
        candidateOnly: z.boolean().optional().describe('Label the suite candidate-only so brittle locators do not fail validation.'),
        brittleThreshold: z.number().optional().describe('Max brittle-locator percent before validation fails (default 40).'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, bootstrap, feature, device, name, language, platform, save, integrateIntoProject, includeCi, candidateOnly, brittleThreshold, consentId, approve }) => {
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first, or omit sessionId to bootstrap from projectRoot.'] });

      // Fix 6 — one-call "Automate my app": when no session/actions exist, build the static app map
      // (so it always exists) and bootstrap a device (consent-gated) + record actions via exploration.
      const wantBootstrap = bootstrap !== false && (bootstrap === true || bootstrap === 'auto' || !sessionId);
      let appMapUri: string | undefined;
      const rootForMap = session?.root ?? (projectRoot && projectRoot.trim() ? projectRoot.trim() : undefined);
      if (rootForMap && existsSync(rootForMap)) {
        try { appMapUri = ensurePrelaunchAppMap(rootForMap, { at: new Date().toISOString() }).appMapUri; } catch (e) { log('warn', 'automation prelaunch app map failed', { err: String(e) }); }
      }

      if ((!session || !session.recordedActions.length) && wantBootstrap) {
        let driver = session ? (await getDriver(session)).driver : undefined;
        if (!session || !driver) {
          if (!projectRoot?.trim() && !session) {
            return qaError({ what: 'Need a sessionId or projectRoot to bootstrap an automation suite', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot="/abs/path" (bootstrap defaults on), or a prepared sessionId.'] }, appMapUri ? { appMapUri } : {});
          }
          const boot = await bootstrapFeatureExecution({ server, sessions, projectRoot: projectRoot?.trim() ?? session!.root, feature: feature ?? 'create automation suite', platform: platform === 'android' || platform === 'ios' ? platform : undefined, device, consentId, approve });
          // Honest target blocker / consent request — but the static app map WAS still built, so the
          // caller can read it even though no device/artifact is available (Fix 6 acceptance).
          if (!boot.ok) return withAppMapUri(boot.result, appMapUri);
          session = boot.session;
          driver = boot.driver;
          if (!appMapUri && existsSync(session.root)) {
            try { appMapUri = ensurePrelaunchAppMap(session.root, { at: new Date().toISOString() }).appMapUri; } catch { /* best-effort */ }
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

      if (!session) return qaError({ what: 'Need a sessionId or projectRoot', changedState: false, retrySafe: true, nextSteps: ['Pass a prepared sessionId, or projectRoot to bootstrap.'] }, appMapUri ? { appMapUri } : {});
      if (!session.recordedActions.length) {
        return qaError({
          what: 'No recorded actions to turn into an automation suite (bootstrap could not record any)',
          changedState: false,
          retrySafe: true,
          failureCode: 'NO_RECORDED_ACTIONS',
          nextSteps: [
            'Run qa_test_this { goal: "create_automation_suite" } (smoke + explore records actions + builds the app map), then re-run qa_automation_generate.',
            'Or drive the app with qa_act/qa_smoke/qa_explore first.',
          ],
        }, appMapUri ? { appMapUri } : {});
      }

      const inputs = profileInputs(language, platform, integrateIntoProject);
      const assembled = assembleAutomationSuite(session, { ...inputs, name, includeCi });
      const validation = validateGeneratedSuite(assembled.files, {
        brittlePct: assembled.model.audit.brittlePct,
        brittleThreshold,
        candidateOnly,
        secrets: assembled.model.secrets,
      });

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
          tool: 'qa_automation_generate',
          action: 'automation_project_write',
          risk: 'medium',
          target: affects,
          consent: { required: true, consentId, approved: true },
          status: 'executed',
        });
      } else if (doSave) {
        written = writeAutomationFiles(session.root, assembled.outputDir, assembled.files);
      }

      // Fix 7 — link the generated suite back into the durable app map + persistent suite, so future
      // feature/ticket decisions know which flows are automated. Best-effort (warnings, never fatal).
      let suiteDelta: ReturnType<typeof mergeFromAutomation>['delta'] | undefined;
      let suiteUri: string | undefined;
      const automationWarnings: string[] = [];
      if (doSave) {
        const now = new Date().toISOString();
        const screenNames = assembled.model.screens.map((s) => s.pageName || s.className);
        try {
          const fw = detectFramework(session.root);
          const fallback: ProjectIdentity = { root: session.root, gitRemote: null, packageName: null, workspaceTarget: null, framework: fw, platforms: fw === 'native-android' ? ['android'] : fw === 'native-ios' ? ['ios'] : ['android', 'ios'] };
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
          else automationWarnings.push('app map not found — automation suite not linked into the map');
        } catch (e) {
          automationWarnings.push(`app-map automation link failed: ${String(e)}`);
        }
        try {
          const fw2 = detectFramework(session.root);
          const fb2: ProjectIdentity = { root: session.root, gitRemote: null, packageName: null, workspaceTarget: null, framework: fw2, platforms: fw2 === 'native-android' ? ['android'] : fw2 === 'native-ios' ? ['ios'] : ['android', 'ios'] };
          const mapForLinks = loadAppMap(session.root, fb2, now).map;
          const links = mapForLinks ? deriveAutomationLinks(mapForLinks, assembled.model.screens.map((s) => s.pageName || s.className)) : { screenIds: [], featureIds: [] };
          const merge = mergeFromAutomation(session.root, session, { assembled, validationOk: validation.ok, links }, { source: 'generate', now, runId: `automation-${Date.now()}`, sourceUri: appMapUri, appId: session.appId, sessionId: session.id });
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
        (written.length ? `wrote ${written.length} files under ${join(session.root, targetDir)}` : '(preview — pass save:true)') +
        (skippedExisting.length ? `\nskipped ${skippedExisting.length} existing file(s) (no overwrite): ${skippedExisting.slice(0, 5).join(', ')}` : '') +
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
    },
  );

  // ---- qa_automation_validate ----
  server.registerTool(
    'qa_automation_validate',
    {
      title: 'Validate a generated automation suite',
      description:
        'Validate generated Appium code without a device: no inlined secrets, locator durability within threshold (unless candidate-only), capability config present, balanced JS/TS syntax, no empty files. Pass sessionId to validate the suite from recorded actions, or projectRoot to validate already-written files under .swipium/automation/<lang>/.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        language: languageEnum.optional(),
        platform: platformEnum.optional(),
        candidateOnly: z.boolean().optional(),
        brittleThreshold: z.number().optional(),
      },
    },
    async ({ sessionId, projectRoot, language, platform, candidateOnly, brittleThreshold }) => {
      const { session, root } = resolveRoot(sessions, sessionId, projectRoot);
      if (!root) return qaError({ what: 'No project root', changedState: false, retrySafe: true, nextSteps: ['Pass sessionId or projectRoot.'] });
      const inputs = profileInputs(language, platform);

      let files: GeneratedFile[];
      let brittlePct = 0;
      let secrets: string[] = [];
      if (session && session.recordedActions.length) {
        const assembled = assembleAutomationSuite(session, inputs);
        files = assembled.files;
        brittlePct = assembled.model.audit.brittlePct;
        secrets = assembled.model.secrets;
      } else {
        const profile = session ? buildAutomationProfile(session, inputs) : buildAutomationProfileFromRoot(root, inputs);
        const outputDir = `.swipium/automation/${profile.automationLanguage === 'python' ? 'python' : 'js'}`;
        files = readGeneratedFromDisk(root, outputDir);
        if (!files.length) {
          return qaError({
            what: `No generated suite found under ${outputDir}`,
            changedState: false,
            retrySafe: true,
            nextSteps: ['Run qa_automation_generate first, or pass a sessionId with recorded actions.'],
          });
        }
      }

      const validation = validateGeneratedSuite(files, { brittlePct, brittleThreshold, candidateOnly, secrets });
      const errors = validation.findings.filter((f) => f.severity === 'error');
      const summary =
        `Validation ${validation.ok ? 'passed' : 'FAILED'}: ${errors.length} error(s), ${validation.findings.length - errors.length} warning(s) over ${validation.filesChecked} files.\n` +
        `secrets ${validation.secretsClean ? 'clean' : 'LEAK DETECTED'}; brittle ${validation.brittlePct}% (threshold ${validation.brittleThreshold}%${validation.candidateOnly ? ', candidate-only' : ''})` +
        (validation.findings.length ? `\n` + validation.findings.slice(0, 12).map((f) => `  ${f.severity === 'error' ? '✗' : '⚠'} ${f.code}${f.file ? ` (${f.file})` : ''}: ${f.message}`).join('\n') : '');
      const payload = { validation };
      return validation.ok ? qaOk(payload, summary) : qaError({ what: 'Generated suite failed validation', changedState: false, retrySafe: true, failureCode: 'VALIDATION_FAILED', nextSteps: errors.map((e) => e.message) }, payload);
    },
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
    if (existsSync(abs)) { skipped.push(f.path); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(abs);
  }
  return { written, skipped };
}
