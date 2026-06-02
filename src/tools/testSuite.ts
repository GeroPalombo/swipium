// qa_test_suite_* — the MCP surface for the persistent, project-level QA test-case suite
// (SWIPIUM-REQ-06). These query, update, generate, export, and lint the canonical suite under
// `.swipium/test-suite.json` independently of per-run suite generation. All persistence + merge
// logic lives in src/testSuite/* (pure); these tools resolve a root/session, call that layer, and
// surface the result. Time is read once per call here (the pure layer never reads the clock).

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { loadProjectConfig } from '../cli/scan.js';
import { pomForSession } from '../services/suiteGenerate.js';
import { generateCanonicalCases, normalizeCase } from '../testSuite/generator.js';
import { applyMerge, loadSuite, saveSuite, suiteResourceUri, runIdFromNow, suiteRoot } from '../testSuite/store.js';
import { exportSuite, type ExportFormat } from '../testSuite/exporter.js';
import { lintSuite } from '../testSuite/lint.js';
import type { CanonicalTestCase, CaseStatus, CreativityLevel, ProvenanceSource } from '../testSuite/schema.js';
import type { Session, SessionStore } from '../session/store.js';

interface Resolved {
  root: string;
  appId?: string;
  session?: Session;
}

function resolveRoot(sessions: SessionStore, sessionId?: string, projectRoot?: string): Resolved | null {
  const session = sessionId ? sessions.get(sessionId) : undefined;
  const root = session?.root ?? projectRoot;
  if (!root) return null;
  const appId = session?.appId ?? (loadProjectConfig(root)?.appId as string | undefined);
  return { root, appId, session };
}

const noRoot = () => qaError({ what: 'No project root', changedState: false, retrySafe: true, nextSteps: ['Pass sessionId or projectRoot.'] });

/** Register the suite JSON as a session artifact so its resource URI resolves; returns the URI. */
function publishSuiteArtifact(sessions: SessionStore, session: Session | undefined, json: string): string | undefined {
  if (!session) return undefined;
  return sessions.saveArtifact(session, 'test-suite', 'test-suite.json', json, 'application/json', 'Persistent QA test suite');
}

export function registerTestSuite(server: McpServer, sessions: SessionStore): void {
  // ---- qa_test_suite_read ----
  server.registerTool(
    'qa_test_suite_read',
    {
      title: 'Read the persistent QA test suite',
      description:
        'Read the canonical, project-level QA test-case suite (.swipium/test-suite.json) — the long-lived suite divided by functionality that grows across runs (distinct from a per-run catalog). Filter by functionality and/or status. format: summary (counts + ids), json (full cases), or markdown (review-ready). Returns a resource URI for the full suite.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        functionality: z.string().optional().describe('Only return cases under this functionality/feature.'),
        status: z.enum(['active', 'draft', 'deprecated', 'blocked', 'manual_only']).optional(),
        format: z.enum(['summary', 'json', 'markdown']).optional(),
      },
    },
    async ({ sessionId, projectRoot, functionality, status, format }) => {
      const r = resolveRoot(sessions, sessionId, projectRoot);
      if (!r) return noRoot();
      const suite = loadSuite(r.root, r.appId);
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
        Object.entries(byFunctionality).map(([k, n]) => `  ${k}: ${n}`).join('\n');

      const payload: Record<string, unknown> = {
        totalCases: suite.cases.length,
        matched: cases.length,
        byFunctionality,
        byStatus,
        ids: cases.map((c) => c.id),
        ...(uri ? { suiteUri: uri } : {}),
      };
      if (fmt === 'json') payload.cases = cases;
      if (fmt === 'markdown') payload.markdown = exportSuite(filtered, 'markdown').content;
      return qaOk(payload, summaryText);
    },
  );

  // ---- qa_test_suite_update ----
  server.registerTool(
    'qa_test_suite_update',
    {
      title: 'Update the persistent QA test suite',
      description:
        'Merge cases into the persistent QA suite and persist them. Cases matching an existing case by feature + objective + normalized steps are UPDATED (not duplicated); new coverage creates new stable ids (TC-<FEATURE>-NNN). source records provenance; mergeMode controls whether generated fields overwrite curated ones. Returns created/updated/deprecated ids + conflicts. Every run that observes QA knowledge should call this.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        source: z.enum(['report', 'exploration', 'feature', 'ticket', 'manual', 'generate', 'suite']),
        sourceUri: z.string().optional(),
        cases: z.array(z.record(z.any())).optional().describe('Canonical (or partial) test cases to merge. Partial cases are normalized with sane defaults.'),
        mergeMode: z.enum(['append', 'update', 'replace_generated']).optional(),
      },
    },
    async ({ sessionId, projectRoot, source, sourceUri, cases, mergeMode }) => {
      const r = resolveRoot(sessions, sessionId, projectRoot);
      if (!r) return noRoot();
      if (!cases || !cases.length) {
        return qaError({ what: 'No cases provided to merge', changedState: false, retrySafe: true, nextSteps: ['Pass cases:[...], or use qa_test_suite_generate to build them from the app.'] });
      }
      const now = new Date().toISOString();
      const incoming: CanonicalTestCase[] = cases.map((c) => {
        const normalized = normalizeCase(c as Partial<CanonicalTestCase>, now);
        // A manual edit/author marks the case curated so future generation won't clobber it.
        if (source === 'manual') normalized.manuallyEdited = true;
        return normalized;
      });
      const applied = applyMerge(r.root, incoming, { source: source as ProvenanceSource, mode: mergeMode ?? 'update', now, runId: runIdFromNow(now), sourceUri }, r.appId);
      const uri = publishSuiteArtifact(sessions, r.session, JSON.stringify(applied.result.suite, null, 2));
      const { created, updated, deprecated, conflicts } = applied.result;
      const summary =
        `Suite merge (${source}): +${created.length} created, ~${updated.length} updated, -${deprecated.length} deprecated, ${conflicts.length} conflict(s).` +
        (conflicts.length ? `\nConflicts (curated fields kept): ${conflicts.map((c) => `${c.id}.${c.field}`).join(', ')}` : '');
      return qaOk(
        {
          created,
          updated,
          deprecated,
          conflicts,
          totalCases: applied.result.suite.cases.length,
          validationErrors: applied.validationErrors,
          runLedgerPath: applied.runPath,
          ...(uri ? { suiteUri: uri } : {}),
        },
        summary,
      );
    },
  );

  // ---- qa_test_suite_generate ----
  server.registerTool(
    'qa_test_suite_generate',
    {
      title: 'Generate persistent suite cases from the app',
      description:
        "Generate or refresh canonical test cases from this session's recorded actions (POM flow) + observed outcomes + guided-exploration coverage, then merge them into the persistent suite. Cases are grouped by functionality, carry a creativityLevel, expected vs. actual results, automation readiness, and traceability. Re-running updates existing cases instead of duplicating them. Returns generated cases + skipped/blocked features + map-coverage gaps.",
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        feature: z.string().optional().describe('Functionality label for the generated flow case (defaults from the recorded flow name).'),
        creativityLevel: z.enum(['conservative', 'standard', 'creative', 'adversarial']).optional(),
        includeManualOnly: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, feature, creativityLevel, includeManualOnly }) => {
      const r = resolveRoot(sessions, sessionId, projectRoot);
      if (!r) return noRoot();
      if (!r.session) {
        return qaError({ what: 'qa_test_suite_generate needs a session to read recorded actions', changedState: false, retrySafe: true, nextSteps: ['Pass sessionId of a session that drove the app (qa_act/qa_smoke/qa_explore).'] });
      }
      const session = r.session;
      const hasActions = session.recordedActions.length > 0;
      const hasExploration = !!session.exploration;
      if (!hasActions && !hasExploration) {
        return qaOk(
          { generated: [], skipped: ['no recorded actions or exploration'], coverageGaps: ['Drive the app first (qa_act/qa_smoke/qa_explore) so cases can be generated.'], created: [], updated: [] },
          'No recorded actions or exploration in this session — nothing to generate yet.',
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
        notes: session.notes,
        exploration: session.exploration,
        source: 'generate',
        now,
      });
      const filtered = includeManualOnly === false ? incoming.filter((c) => c.automation.status !== 'manual') : incoming;
      const applied = applyMerge(r.root, filtered, { source: 'generate', mode: 'update', now, runId: runIdFromNow(now) }, r.appId);
      const uri = publishSuiteArtifact(sessions, session, JSON.stringify(applied.result.suite, null, 2));
      const coverageGaps = pom ? pom.audit.entries.filter((e) => e.durability === 'brittle').map((e) => `${e.page}.${e.element}: ${e.remediation ?? 'brittle locator'}`) : [];
      const summary = `Generated ${filtered.length} case(s) → +${applied.result.created.length} new, ~${applied.result.updated.length} updated. Suite now ${applied.result.suite.cases.length} case(s).`;
      return qaOk(
        {
          generated: filtered.map((c) => ({ functionality: c.functionality, title: c.title, type: c.type, creativityLevel: c.creativityLevel, automation: c.automation.status })),
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

  // ---- qa_test_suite_export ----
  server.registerTool(
    'qa_test_suite_export',
    {
      title: 'Export the persistent QA test suite',
      description:
        'Export the persistent suite to markdown (review-ready), yaml (a per-functionality directory), json, or junit (CI-style results). Pass save:true to write the export under .swipium/test-suite-export/.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        format: z.enum(['markdown', 'yaml', 'json', 'junit']),
        save: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, format, save }) => {
      const r = resolveRoot(sessions, sessionId, projectRoot);
      if (!r) return noRoot();
      const suite = loadSuite(r.root, r.appId);
      const result = exportSuite(suite, format as ExportFormat);
      const written: string[] = [];
      if (save) {
        const base = join(suiteRoot(r.root), 'test-suite-export');
        if (result.files) {
          for (const f of result.files) {
            const abs = join(base, 'yaml', f.path);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, f.content);
            written.push(abs);
          }
        } else if (result.content) {
          const ext = format === 'junit' ? 'xml' : format === 'markdown' ? 'md' : format;
          const abs = join(base, `test-suite.${ext}`);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, result.content);
          written.push(abs);
        }
      }
      return qaOk(
        { format, ...(result.content ? { content: result.content } : {}), ...(result.files ? { fileCount: result.files.length } : {}), written, totalCases: suite.cases.length },
        `${result.summary}${written.length ? ` Wrote ${written.length} file(s).` : ''}`,
      );
    },
  );

  // ---- qa_test_suite_lint ----
  server.registerTool(
    'qa_test_suite_lint',
    {
      title: 'Lint the persistent QA test suite',
      description:
        'Validate the persistent suite: missing expected results, missing actual results after a run, unlinked feature/screen, stale map links, duplicate ids, brittle automation above threshold, and adversarial cases lacking disposable-state/consent safety metadata. Returns errors (block) and warnings.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        brittleThreshold: z.enum(['C', 'D']).optional(),
        liveFeatureIds: z.array(z.string()).optional().describe('Feature ids still present in the app map (enables the stale-map-link rule).'),
      },
    },
    async ({ sessionId, projectRoot, brittleThreshold, liveFeatureIds }) => {
      const r = resolveRoot(sessions, sessionId, projectRoot);
      if (!r) return noRoot();
      const suite = loadSuite(r.root, r.appId);
      const result = lintSuite(suite, { brittleThreshold, liveFeatureIds });
      const summary =
        `Linted ${suite.cases.length} case(s): ${result.errorCount} error(s), ${result.warnCount} warning(s).\n` +
        (result.findings.length
          ? result.findings.slice(0, 25).map((f) => `  ${f.severity === 'error' ? '✗' : '⚠'} ${f.id ? `${f.id} ` : ''}[${f.rule}] ${f.message}`).join('\n')
          : '  ✓ no issues.');
      return qaOk({ ok: result.ok, errorCount: result.errorCount, warnCount: result.warnCount, findings: result.findings }, summary);
    },
  );
}
