// qa_suite_*: the MCP surface for the persistent, project-level QA test-case suite.
// These query, update, generate, export, and lint the canonical suite under
// `.swipium/test-suite.json` independently of per-run asset generation (qa_generate). All
// persistence + merge logic lives in src/testSuite/* (pure); these tools resolve a root/session,
// call that layer, and surface the result. Time is read once per call here (the pure layer never
// reads the clock). qa_suite_lint also folds in the generated-page-object lint (src/suite/lint.ts)
// when .swipium/pages exists, so one call audits both the durable suite and generated pages.

import { z } from 'zod';
import { join, resolve, sep } from 'node:path';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import { loadProjectConfig } from '../cli/scan.js';
import { pomForSession } from '../services/suiteGenerate.js';
import { casePlatformsFor, generateCanonicalCases, normalizeCase } from '../testSuite/generator.js';
import { applyMerge, loadSuiteChecked, runIdFromNow, suiteJsonPath, suiteRoot, writeFileNoFollow } from '../testSuite/store.js';
import { exportSuite, type ExportFormat } from '../testSuite/exporter.js';
import { lintSuite } from '../testSuite/lint.js';
import { lintSuitePages } from '../suite/lint.js';
import { CASE_ID_RE, isSafeCaseId, type CanonicalTestCase, type CreativityLevel, type ProvenanceSource } from '../testSuite/schema.js';
import { secretSafeNotes } from '../suite/secretGuard.js';
import type { Session, SessionStore } from '../session/store.js';

interface Resolved {
  root: string;
  appId?: string;
  session?: Session;
}

/** The session's root, else the shared resolution every root-aware tool uses (projectRoot >
 *  MCP roots > SWIPIUM_PROJECT_ROOT > CLAUDE_PROJECT_DIR > cwd marker). */
async function resolveRoot(
  server: McpServer,
  sessions: SessionStore,
  sessionId?: string,
  projectRoot?: string,
): Promise<Resolved | { error: CallToolResult }> {
  const session = sessionId ? sessions.get(sessionId) : undefined;
  // A typo'd / expired sessionId is an error, never silently another root (the cwd's suite).
  if (sessionId && !session)
    return { error: unknownSessionError(sessionId, ['Omit sessionId to use projectRoot, or pass a valid session.']) };
  let root = session?.root;
  if (!root) {
    const resolved = await resolveProjectRoot(server, projectRoot);
    if (!resolved.root) return { error: unresolvedProjectRootError(resolved) };
    root = resolved.root;
  }
  const appId = session?.appId ?? (loadProjectConfig(root)?.appId as string | undefined);
  return { root, appId, session };
}

const CREATIVITY_ENUM = ['conservative', 'standard', 'creative', 'adversarial'] as const;

const CASE_STRING_FIELDS = [
  'id',
  'featureId',
  'functionality',
  'title',
  'description',
  'objective',
  'owner',
  'priority',
  'type',
  'status',
  'creativityLevel',
];
const CASE_STRING_ARRAY_FIELDS = [
  'expectedResult',
  'preconditions',
  'fixtures',
  'testData',
  'risk',
  'cleanup',
  'ticketRefs',
  'requirementRefs',
  'tags',
];
const STEP_STRING_FIELDS = ['action', 'target', 'data', 'expected', 'mapScreenId', 'automationSelector'];

/** Validate (and lightly normalize) qa_suite_update `cases`: plain-string steps become
 *  { action }; anything else of the wrong type is reported as an issue with its path. */
export function shapeIncomingCases(cases: Array<Record<string, unknown>>): {
  cases: Array<Record<string, unknown>>;
  issues: Array<{ path: string; message: string }>;
} {
  const issues: Array<{ path: string; message: string }> = [];
  const out = cases.map((raw, i) => {
    const at = `cases[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ path: at, message: 'must be an object' });
      return {};
    }
    const c: Record<string, unknown> = { ...raw };
    for (const k of CASE_STRING_FIELDS)
      if (c[k] !== undefined && typeof c[k] !== 'string')
        issues.push({ path: `${at}.${k}`, message: `expected string, got ${typeof c[k]}` });
    // The id names the case's YAML mirror file, so it must be one safe path component.
    if (typeof c.id === 'string' && c.id !== '' && !isSafeCaseId(c.id))
      issues.push({ path: `${at}.id`, message: `must match ${CASE_ID_RE.source} (omit it to get an allocated id)` });
    for (const k of CASE_STRING_ARRAY_FIELDS) {
      if (c[k] === undefined) continue;
      if (!Array.isArray(c[k]) || !(c[k] as unknown[]).every((v) => typeof v === 'string'))
        issues.push({ path: `${at}.${k}`, message: 'expected an array of strings' });
    }
    if (c.platforms !== undefined) {
      if (!Array.isArray(c.platforms) || !(c.platforms as unknown[]).every((p) => p === 'android' || p === 'ios'))
        issues.push({ path: `${at}.platforms`, message: 'expected an array of "android" | "ios"' });
    }
    for (const k of ['actualResult', 'automation'])
      if (c[k] !== undefined && (!c[k] || typeof c[k] !== 'object' || Array.isArray(c[k])))
        issues.push({ path: `${at}.${k}`, message: 'expected an object' });
    if (c.actualResult && typeof c.actualResult === 'object' && typeof (c.actualResult as Record<string, unknown>).status !== 'string')
      issues.push({ path: `${at}.actualResult.status`, message: 'expected string' });
    const named = ['title', 'functionality', 'objective'].some((k) => typeof c[k] === 'string' && (c[k] as string).trim());
    if (!named) issues.push({ path: `${at}.title`, message: 'a non-empty title (or functionality/objective) is required' });
    if (c.steps !== undefined) {
      if (!Array.isArray(c.steps)) issues.push({ path: `${at}.steps`, message: `expected an array, got ${typeof c.steps}` });
      else
        c.steps = (c.steps as unknown[]).map((s, j) => {
          const sp = `${at}.steps[${j}]`;
          if (typeof s === 'string') {
            if (!s.trim()) issues.push({ path: sp, message: 'empty step' });
            return { action: s };
          }
          if (!s || typeof s !== 'object' || Array.isArray(s)) {
            issues.push({ path: sp, message: 'expected { action, target?, data?, expected? } or a string' });
            return s;
          }
          const step = s as Record<string, unknown>;
          if (typeof step.action !== 'string' || !step.action.trim())
            issues.push({ path: `${sp}.action`, message: 'a non-empty string action is required' });
          for (const k of STEP_STRING_FIELDS)
            if (k !== 'action' && step[k] !== undefined && typeof step[k] !== 'string')
              issues.push({ path: `${sp}.${k}`, message: `expected string, got ${typeof step[k]}` });
          if (step.index !== undefined && typeof step.index !== 'number') issues.push({ path: `${sp}.index`, message: 'expected number' });
          return step;
        });
    }
    return c;
  });
  return { cases: out, issues };
}

/** Register the suite JSON as a session artifact so its resource URI resolves; returns the URI. */
/** A suite save that failed on disk keeps the error envelope instead of a raw fs error. */
function suiteWriteError(e: unknown) {
  // Only a real fs error (it has an errno code) is a disk problem; anything else is bad suite data.
  if (!(e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'))
    return qaError({
      what: `Could not merge into .swipium/test-suite.json: ${e instanceof Error ? e.message : String(e)}. test-suite.json was not changed.`,
      failureCode: 'INVALID_ARGUMENT',
      changedState: false,
      retrySafe: false,
      nextSteps: ['A stored case in .swipium/test-suite.json is malformed: run qa_suite_lint, fix or remove that case, then retry.'],
    });
  return qaError({
    what: `Could not write the test suite under .swipium/: ${e instanceof Error ? e.message : String(e)}`,
    failureCode: 'ARTIFACT_PATH_UNWRITABLE',
    changedState: false,
    retrySafe: true,
    nextSteps: ['Check that .swipium/ is writable, then retry. test-suite.json is written last, so it still holds the previous suite.'],
  });
}

/** Summary line for stored cases loadSuite had to repair (unsafe or duplicate ids renamed). */
function repairsNote(repairs: string[]): string {
  return repairs.length
    ? `\n⚠ test-suite.json had ${repairs.length} unsafe or duplicate case id(s), renamed: ${repairs.slice(0, 3).join('; ')}${repairs.length > 3 ? '; ...' : ''}`
    : '';
}

function publishSuiteArtifact(sessions: SessionStore, session: Session | undefined, json: string): string | undefined {
  if (!session) return undefined;
  return sessions.saveArtifact(session, 'test-suite', 'test-suite.json', json, 'application/json', 'Persistent QA test suite');
}

export function registerTestSuite(server: McpServer, sessions: SessionStore): void {
  // ---- qa_suite_read ----
  server.registerTool(
    'qa_suite_read',
    {
      title: 'Read the persistent QA test suite',
      description:
        'Read the repo suite (.swipium/test-suite.json), filtered by functionality/status, as a summary, json, or markdown, ' +
        'plus a resource URI for the full suite.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        functionality: z.string().optional().describe('Only return cases under this functionality/feature.'),
        status: z.enum(['active', 'draft', 'deprecated', 'blocked', 'manual_only']).optional(),
        format: z.enum(['summary', 'json', 'markdown']).optional(),
      },
    },
    async ({ sessionId, projectRoot, functionality, status, format }) => {
      const r = await resolveRoot(server, sessions, sessionId, projectRoot);
      if ('error' in r) return r.error;
      const { suite, repairs } = loadSuiteChecked(r.root, r.appId);
      let cases = suite.cases;
      if (functionality) cases = cases.filter((c) => c.functionality === functionality || c.featureId === functionality);
      if (status) cases = cases.filter((c) => c.status === status);
      const filtered = { ...suite, cases };
      const uri = publishSuiteArtifact(sessions, r.session, JSON.stringify(suite, null, 2));

      const byFunctionality: Record<string, number> = {};
      for (const c of suite.cases) byFunctionality[c.functionality] = (byFunctionality[c.functionality] ?? 0) + 1;
      const byStatus: Record<string, number> = {};
      for (const c of suite.cases) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

      const fmt = format ?? 'summary';
      const summaryText =
        `QA test suite: ${suite.cases.length} case(s) across ${Object.keys(byFunctionality).length} functionality area(s); ${cases.length} match filter.\n` +
        Object.entries(byFunctionality)
          .map(([k, n]) => `  ${k}: ${n}`)
          .join('\n') +
        `\nfull suite: ${uri ?? suiteJsonPath(r.root)}`;

      const payload: Record<string, unknown> = {
        totalCases: suite.cases.length,
        matched: cases.length,
        byFunctionality,
        byStatus,
        ids: cases.map((c) => c.id),
        ...(uri ? { suiteUri: uri } : {}),
        // Always say where the full suite is; a swipium:// URI needs a session to hang it on.
        suitePath: suiteJsonPath(r.root),
        ...(uri
          ? {}
          : { suiteUriNote: 'No session: pass sessionId to also get a swipium:// resource URI (readable with qa_get_artifact).' }),
      };
      if (fmt === 'json') payload.cases = cases;
      if (fmt === 'markdown') payload.markdown = exportSuite(filtered, 'markdown').content;
      if (repairs.length) payload.loadRepairs = repairs;
      return qaOk(payload, summaryText + repairsNote(repairs));
    },
  );

  // ---- qa_suite_update ----
  server.registerTool(
    'qa_suite_update',
    {
      title: 'Update the persistent QA test suite',
      description:
        'Add or update cases in the repo test suite: a case matching feature + objective + steps is updated, new ones get stable TC ' +
        'ids. mergeMode decides whether generated fields overwrite curated ones.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        source: z.enum(['report', 'exploration', 'feature', 'ticket', 'manual', 'generate', 'suite']),
        sourceUri: z.string().optional(),
        cases: z.array(z.record(z.string(), z.any())).optional().describe('Canonical or partial cases (normalized).'),
        mergeMode: z.enum(['append', 'update', 'replace_generated']).optional(),
      },
    },
    async ({ sessionId, projectRoot, source, sourceUri, cases, mergeMode }) => {
      const r = await resolveRoot(server, sessions, sessionId, projectRoot);
      if ('error' in r) return r.error;
      if (!cases || !cases.length) {
        return qaError({
          what: 'No cases provided to merge',
          failureCode: 'INVALID_ARGUMENT',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Pass cases:[...], or use qa_suite_generate to build them from the app.'],
        });
      }
      // Validate the loose `cases` records before they reach the merge layer (which assumes
      // the canonical shape and would otherwise crash with a raw TypeError, or silently update a case).
      const shaped = shapeIncomingCases(cases);
      if (shaped.issues.length) {
        return qaError(
          {
            what: `qa_suite_update: invalid cases: ${shaped.issues
              .slice(0, 8)
              .map((i) => `${i.path}: ${i.message}`)
              .join('; ')}${shaped.issues.length > 8 ? `; (+${shaped.issues.length - 8} more)` : ''}. Nothing was written.`,
            changedState: false,
            retrySafe: true,
            failureCode: 'INVALID_ARGUMENT',
            nextSteps: [
              'Each case needs a non-empty string title (or functionality/objective); steps is an array of { action, target?, data?, expected? } (or plain action strings); expectedResult/preconditions/tags are string arrays; platforms is ["android"|"ios"].',
            ],
          },
          { invalidArguments: shaped.issues.slice(0, 20) },
        );
      }
      const now = new Date().toISOString();
      const incoming: CanonicalTestCase[] = shaped.cases.map((c) => {
        const normalized = normalizeCase(c as Partial<CanonicalTestCase>, now);
        // A manual edit/author marks the case curated so future generation won't clobber it.
        if (source === 'manual') normalized.manuallyEdited = true;
        return normalized;
      });
      let applied: ReturnType<typeof applyMerge>;
      try {
        applied = applyMerge(
          r.root,
          incoming,
          { source: source as ProvenanceSource, mode: mergeMode ?? 'update', now, runId: runIdFromNow(now), sourceUri },
          r.appId,
        );
      } catch (e) {
        return suiteWriteError(e);
      }
      const uri = publishSuiteArtifact(sessions, r.session, JSON.stringify(applied.result.suite, null, 2));
      const { created, updated, deprecated, conflicts, idsIgnored } = applied.result;
      const summary =
        `Suite merge (${source}): +${created.length} created, ~${updated.length} updated, -${deprecated.length} deprecated, ${conflicts.length} conflict(s).` +
        (conflicts.length ? `\nConflicts (curated fields kept): ${conflicts.map((c) => `${c.id}.${c.field}`).join(', ')}` : '') +
        (idsIgnored.length ? `\nGiven id(s) not used: ${idsIgnored.map((i) => `${i.given} > ${i.id} (${i.reason})`).join(', ')}` : '') +
        repairsNote(applied.loadRepairs);
      return qaOk(
        {
          created,
          updated,
          deprecated,
          conflicts,
          ...(idsIgnored.length ? { idsIgnored } : {}),
          ...(applied.loadRepairs.length ? { loadRepairs: applied.loadRepairs } : {}),
          totalCases: applied.result.suite.cases.length,
          validationErrors: applied.validationErrors,
          runLedgerPath: applied.runPath,
          ...(uri ? { suiteUri: uri } : {}),
        },
        summary,
      );
    },
  );

  // ---- qa_suite_generate ----
  server.registerTool(
    'qa_suite_generate',
    {
      title: 'Generate persistent suite cases from the app',
      description:
        'Generate cases from this session (recorded actions, outcomes, exploration coverage) and merge them into the durable ' +
        'repo suite .swipium/test-suite.json (re-runs update, no duplicates). Returns cases, skipped features, and coverage ' +
        'gaps. Per-run assets: qa_generate.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        feature: z.string().optional().describe('Functionality label (default: the recorded flow name).'),
        creativity: z.enum(CREATIVITY_ENUM).optional().describe('How far beyond the happy path (default standard).'),
        creativityLevel: z.enum(CREATIVITY_ENUM).optional().describe('Deprecated alias of creativity.'),
        includeManualOnly: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, feature, creativity, creativityLevel: creativityAlias, includeManualOnly }) => {
      const creativityLevel = creativity ?? creativityAlias;
      const r = await resolveRoot(server, sessions, sessionId, projectRoot);
      if ('error' in r) return r.error;
      if (!r.session) {
        return qaError({
          what: 'qa_suite_generate needs a session to read recorded actions',
          failureCode: 'INVALID_ARGUMENT',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Pass sessionId of a session that drove the app (qa_act/qa_smoke/qa_explore).'],
        });
      }
      const session = r.session;
      const hasActions = session.recordedActions.length > 0;
      const hasExploration = !!session.exploration;
      if (!hasActions && !hasExploration) {
        return qaOk(
          {
            generated: [],
            skipped: ['no recorded actions or exploration'],
            coverageGaps: ['Drive the app first (qa_act/qa_smoke/qa_explore) so cases can be generated.'],
            created: [],
            updated: [],
          },
          'No recorded actions or exploration in this session, nothing to generate yet.',
        );
      }

      const now = new Date().toISOString();
      const { pom } = hasActions ? pomForSession(session, feature) : { pom: undefined };
      const incoming = generateCanonicalCases({
        pom,
        appId: r.appId,
        functionality: feature,
        creativityLevel: (creativityLevel as CreativityLevel) ?? 'standard',
        fixtures: session.fixtures,
        notes: secretSafeNotes(session.notes, session.secrets), // never a registered secret in test-suite.json
        exploration: session.exploration,
        platforms: casePlatformsFor(session), // the observed platform, not a default "android"
        source: 'generate',
        now,
      });
      const filtered = includeManualOnly === false ? incoming.filter((c) => c.automation.status !== 'manual') : incoming;
      let applied: ReturnType<typeof applyMerge>;
      try {
        applied = applyMerge(r.root, filtered, { source: 'generate', mode: 'update', now, runId: runIdFromNow(now) }, r.appId);
      } catch (e) {
        return suiteWriteError(e);
      }
      const uri = publishSuiteArtifact(sessions, session, JSON.stringify(applied.result.suite, null, 2));
      const coverageGaps = pom
        ? pom.audit.entries
            .filter((e) => e.durability === 'brittle')
            .map((e) => `${e.page}.${e.element}: ${e.remediation ?? 'brittle locator'}`)
        : [];
      const summary = `Generated ${filtered.length} case(s) > +${applied.result.created.length} new, ~${applied.result.updated.length} updated. Suite now ${applied.result.suite.cases.length} case(s).`;
      return qaOk(
        {
          generated: filtered.map((c) => ({
            functionality: c.functionality,
            title: c.title,
            type: c.type,
            creativityLevel: c.creativityLevel,
            automation: c.automation.status,
          })),
          created: applied.result.created,
          updated: applied.result.updated,
          deprecated: applied.result.deprecated,
          coverageGaps,
          totalCases: applied.result.suite.cases.length,
          ...(uri ? { suiteUri: uri } : {}),
        },
        summary,
      );
    },
  );

  // ---- qa_suite_export ----
  server.registerTool(
    'qa_suite_export',
    {
      title: 'Export the persistent QA test suite',
      description: 'Export the repo test suite as markdown, yaml, json, or junit; save:true writes it under .swipium/test-suite-export/.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        format: z.enum(['markdown', 'yaml', 'json', 'junit']),
        save: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, format, save }) => {
      const r = await resolveRoot(server, sessions, sessionId, projectRoot);
      if ('error' in r) return r.error;
      const { suite, repairs } = loadSuiteChecked(r.root, r.appId);
      const result = exportSuite(suite, format as ExportFormat);
      const written: string[] = [];
      if (save) {
        const base = join(suiteRoot(r.root), 'test-suite-export');
        const yamlBase = resolve(base, 'yaml');
        try {
          if (result.files) {
            for (const f of result.files) {
              const abs = resolve(yamlBase, f.path);
              // A path built from stored data never leaves the export folder.
              if (!abs.startsWith(yamlBase + sep)) continue;
              writeFileNoFollow(r.root, abs, f.content);
              written.push(abs);
            }
          } else if (result.content) {
            const ext = format === 'junit' ? 'xml' : format === 'markdown' ? 'md' : format;
            const abs = join(base, `test-suite.${ext}`);
            writeFileNoFollow(r.root, abs, result.content);
            written.push(abs);
          }
        } catch (e) {
          return suiteWriteError(e);
        }
      }
      return qaOk(
        {
          format,
          ...(result.content ? { content: result.content } : {}),
          ...(result.files ? { fileCount: result.files.length } : {}),
          written,
          totalCases: suite.cases.length,
          ...(repairs.length ? { loadRepairs: repairs } : {}),
        },
        `${result.summary}${written.length ? ` Wrote ${written.length} file(s).` : ''}${repairsNote(repairs)}`,
      );
    },
  );

  // ---- qa_suite_lint ----
  server.registerTool(
    'qa_suite_lint',
    {
      title: 'Lint the persistent QA test suite',
      description:
        'Lint the repo test suite (missing results, stale links, duplicate ids, brittle automation, unsafe adversarial cases) and ' +
        'generated page objects (fragile locators). Returns errors and warnings.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        brittleThreshold: z.enum(['C', 'D']).optional(),
        liveFeatureIds: z.array(z.string()).optional().describe('Live map feature ids (enables the stale-link rule).'),
      },
    },
    async ({ sessionId, projectRoot, brittleThreshold, liveFeatureIds }) => {
      const r = await resolveRoot(server, sessions, sessionId, projectRoot);
      if ('error' in r) return r.error;
      const { suite, repairs } = loadSuiteChecked(r.root, r.appId);
      const result = lintSuite(suite, { brittleThreshold, liveFeatureIds });
      // A stored unsafe/duplicate id was renamed on load: report it as an error until saved.
      for (const msg of repairs) result.findings.unshift({ rule: 'unsafe_id', severity: 'error', message: msg });
      result.errorCount += repairs.length;
      if (repairs.length) result.ok = false;
      // Fold in the generated-page-object lint (per-run assets from qa_generate) when pages exist,
      // so one lint call audits both the durable suite and the generated POM pages.
      const pages = lintSuitePages(r.root);
      const pageErrors = pages.exists ? pages.items.filter((i) => i.severity === 'error').length : 0;
      const summary =
        `Linted ${suite.cases.length} case(s): ${result.errorCount} error(s), ${result.warnCount} warning(s).\n` +
        (result.findings.length
          ? result.findings
              .slice(0, 25)
              .map((f) => `  ${f.severity === 'error' ? '✗' : '⚠'} ${f.id ? `${f.id} ` : ''}[${f.rule}] ${f.message}`)
              .join('\n')
          : '  ✓ no issues.') +
        (pages.exists
          ? `\nGenerated pages (.swipium/pages): ${pages.pageCount} page object(s), ${pages.items.length} issue(s) (${pageErrors} brittle).` +
            (pages.items.length
              ? '\n' +
                pages.items
                  .slice(0, 20)
                  .map((i) => `  ${i.severity === 'error' ? '✗' : '⚠'} ${i.page}.${i.element}: ${i.message}`)
                  .join('\n')
              : '\n  ✓ all locators are durable.')
          : '');
      return qaOk(
        {
          ok: result.ok && pageErrors === 0,
          errorCount: result.errorCount,
          warnCount: result.warnCount,
          findings: result.findings,
          pagesLint: pages.exists ? { pageCount: pages.pageCount, items: pages.items, errorCount: pageErrors } : null,
        },
        summary,
      );
    },
  );
}
