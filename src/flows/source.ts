// Flow source loading shared by qa_flow_check / qa_flow_run / qa_flow_repair: inline YAML, a path,
// or a name under .swipium/flows, confined to the project root and to flow file extensions.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { withinRootOrNull } from './paths.js';

export type FlowSourceErrorCode = 'FLOW_NOT_FOUND' | 'INVALID_ARGUMENT' | 'INVALID_FLOW' | 'UNSAFE_ACTION_REFUSED';

/** Flow files are YAML (JSON is valid YAML). Explicit paths must carry one of these extensions so a
 *  read-only check/plan can't be pointed at `.env`, keys or other non-flow files. */
const FLOW_FILE_EXT = /\.(ya?ml|json)$/i;

/** Resolve a flow's YAML from explicit text, a path, or a name under .swipium/flows.
 *  Paths are confined to the project root (after realpath, like templates/baselines and
 *  qa_flow_repair targets): an absolute or `..` path outside it is refused with
 *  UNSAFE_ACTION_REFUSED and never read. */
export function loadFlowSource(
  root: string | undefined,
  flow?: string,
  flowYaml?: string,
): { yamlText?: string; source?: string; error?: string; errorCode?: FlowSourceErrorCode } {
  if (flowYaml && flowYaml.trim()) return { yamlText: flowYaml, source: 'inline' };
  if (!flow) return { error: 'Provide a flow name, a path, or flowYaml.', errorCode: 'INVALID_ARGUMENT' };
  if (!root) {
    return {
      error: `Flow "${flow}" can't be resolved without a project root (flow files are confined to the project root). Pass projectRoot or set SWIPIUM_PROJECT_ROOT, or pass inline flowYaml.`,
      errorCode: isAbsolute(flow) ? 'UNSAFE_ACTION_REFUSED' : 'FLOW_NOT_FOUND',
    };
  }
  const explicitPath = isAbsolute(flow) || /[\\/]/.test(flow) || FLOW_FILE_EXT.test(flow);
  if (explicitPath && !FLOW_FILE_EXT.test(flow)) {
    return {
      error: `Refusing to read "${flow}": flow files must be .yaml, .yml or .json.`,
      errorCode: 'UNSAFE_ACTION_REFUSED',
    };
  }
  const raw: string[] = [];
  if (explicitPath) raw.push(isAbsolute(flow) ? flow : join(root, flow));
  if (!isAbsolute(flow)) {
    raw.push(
      join(root, '.swipium', 'flows', `${flow}.yaml`),
      join(root, '.swipium', 'flows', `${flow}.yml`),
      join(root, '.swipium', 'flows', `${flow}.json`),
    );
    if (FLOW_FILE_EXT.test(flow)) raw.push(join(root, '.swipium', 'flows', flow));
  }
  const candidates: string[] = [];
  for (const p of raw) {
    const confined = withinRootOrNull(root, p);
    if (confined) candidates.push(confined);
    else if (p === raw[0] && explicitPath) {
      return {
        error: `Refusing to read "${flow}": it resolves outside the project root (${root}). Flow files must live under the project root (normally .swipium/flows).`,
        errorCode: 'UNSAFE_ACTION_REFUSED',
      };
    }
  }
  for (const p of candidates) {
    // A directory named like a flow (flows/login.yaml/) is not a flow file: keep looking.
    if (existsSync(p) && statSync(p).isFile()) {
      try {
        const text = readFileSync(p, 'utf8');
        // A POM test (page/element steps) is not a flow; point at its compiled flow.
        if (/^#\s*Swipium test \(POM\)/m.test(text)) {
          const slug = (text.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1] ?? '').trim().replace(/[^\w.-]+/g, '-');
          return {
            error: `${p} is a POM test (page/element steps), not a runnable flow.${slug ? ` Run its compiled flow instead: qa_flow_run flow:"${slug}" (.swipium/flows/${slug}.yaml; regenerate with qa_flow_compile).` : ' Compile it with qa_flow_compile and run the flow under .swipium/flows.'}`,
            errorCode: 'INVALID_FLOW',
          };
        }
        return { yamlText: text, source: p };
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
