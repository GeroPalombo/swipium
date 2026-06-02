import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { importMaestro } from '../interop/maestro.js';
import { importMaestroActions, exportMaestroActions } from '../automation/maestroIr.js';
import { compileActions } from '../automation/plan.js';
import { parseFlow } from '../flows/schema.js';
import type { SessionStore } from '../session/store.js';

function rootFor(sessions: SessionStore, sessionId?: string, projectRoot?: string): string | undefined {
  return sessionId ? sessions.get(sessionId)?.root : projectRoot;
}

export function registerMaestro(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_maestro_import',
    {
      title: 'Import Maestro YAML',
      description: 'Import Maestro commands into the Automation Kernel V2 Action IR (`actionIr`), preserving explicit tapOn retryTapIfNoChange/repeat/settle, longPressOn, full scrollUntilVisible options, waitForAnimationToEnd, assertNotVisible, and eraseText. `unsupported` + `grades` are the authoritative semantic view (a command is unsupported only if it cannot be automated at all — e.g. clearState, repeat loops). Also emits `flowYaml` (the narrower Flow V2 subset for a saved .swipium/flows artifact) and `flowYamlUnsupported` (commands the IR supports but the Flow V2 YAML cannot yet express, e.g. longPressOn/assertNotVisible).',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        maestroYaml: z.string().optional(),
        path: z.string().optional(),
        name: z.string().optional(),
        appId: z.string().optional(),
      },
    },
    async ({ sessionId, projectRoot, maestroYaml, path, name, appId }) => {
      const root = rootFor(sessions, sessionId, projectRoot);
      if (!maestroYaml && !path) return qaError({ what: 'Pass maestroYaml or path', changedState: false, retrySafe: true, nextSteps: ['Provide the Maestro YAML content or file path.'] });
      try {
        const text = maestroYaml ?? readFileSync(path!, 'utf8');
        const legacy = importMaestro(text, { name, appId });
        const ir = importMaestroActions(text);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const uri = session ? sessions.saveArtifact(session, 'flow', `maestro-import-${Date.now()}.yaml`, legacy.flowYaml, 'text/yaml', 'Maestro import as Swipium Flow V2') : undefined;
        return qaOk(
          {
            // V2 Action IR is authoritative: longPressOn/assertNotVisible/etc are supported here and
            // are NOT counted as unsupported (which was the contradiction the legacy importer caused).
            actionIr: ir.actions,
            grades: ir.grades,
            unsupported: ir.unsupported,
            // Flow V2 YAML (for a saved artifact) + the commands it cannot yet express even though the IR can.
            flowYaml: legacy.flowYaml,
            flowYamlUnsupported: legacy.unsupported,
            artifactUri: uri ?? null,
            root: root ?? null,
          },
          `imported Maestro → ${ir.actions.length} Action IR step(s), ${ir.unsupported.length} unsupported${legacy.unsupported.length ? `, ${legacy.unsupported.length} not expressible in Flow V2 YAML` : ''}${uri ? `\nflow: ${uri}` : ''}`,
        );
      } catch (e) {
        return qaError({ what: `Could not import Maestro YAML: ${String((e as Error).message ?? e)}`, changedState: false, retrySafe: true, nextSteps: ['Check the YAML syntax and supported command subset.'] });
      }
    },
  );

  server.registerTool(
    'qa_maestro_export',
    {
      title: 'Export Swipium Flow to Maestro',
      description: 'Export a Swipium Flow V2 YAML to Maestro YAML via the Automation Kernel V2 IR exporter. Native selectors map to Maestro selector blocks (never XPath). Steps with no portable Maestro form — iOS predicate/class-chain selectors, visual/OCR/diff, and other Swipium/Appium/WDA-only steps — are emitted as explicit `manualReview` entries graded manual_review_required, never silently downgraded.',
      inputSchema: {
        sessionId: z.string().optional(),
        flowYaml: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async ({ sessionId, flowYaml, path }) => {
      if (!flowYaml && !path) return qaError({ what: 'Pass flowYaml or path', changedState: false, retrySafe: true, nextSteps: ['Provide Swipium flow YAML content or a path.'] });
      try {
        const text = flowYaml ?? readFileSync(path!, 'utf8');
        const { flow: parsed, errors } = parseFlow(text);
        if (errors.length || !parsed) {
          return qaError({ what: `Flow is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}) — run qa_flow_check`, changedState: false, retrySafe: true, nextSteps: ['Fix the flow YAML and re-export.'] }, { errors });
        }
        const result = exportMaestroActions(compileActions(parsed));
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const uri = session ? sessions.saveArtifact(session, 'maestro', `maestro-export-${Date.now()}.yaml`, result.maestroYaml, 'text/yaml', 'Swipium Flow exported to Maestro') : undefined;
        const portable = result.grades.filter((g) => g.grade === 'portable' || g.grade === 'maestro_supported').length;
        return qaOk(
          { maestroYaml: result.maestroYaml, grades: result.grades, unsupported: result.unsupported, artifactUri: uri ?? null },
          `exported Maestro YAML: ${portable}/${result.grades.length} portable, ${result.unsupported.length} need manual review${uri ? `\nartifact: ${uri}` : ''}`,
        );
      } catch (e) {
        return qaError({ what: `Could not export Maestro YAML: ${String((e as Error).message ?? e)}`, changedState: false, retrySafe: true, nextSteps: ['Check the Swipium Flow YAML.'] });
      }
    },
  );
}
