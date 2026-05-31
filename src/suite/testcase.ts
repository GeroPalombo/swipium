// Test-case documentation (roadmap §7) — turn a generated POM suite + the session's observed
// state into an industry-style test case catalog (TC-xxx) with preconditions, steps, expected
// result, automation status, known blockers, and last-run evidence. PURE; callers serialize.

import { stringify } from 'yaml';
import type { PomResult, PomTestStep } from './pom.js';
import type { Fixture, TestNote } from '../session/store.js';

export type Priority = 'P0' | 'P1' | 'P2';

export interface TestCase {
  id: string;
  title: string;
  purpose: string;
  priority: Priority;
  platform: string;
  preconditions: string[];
  fixtures: string[];
  steps: string[];
  expected: string[];
  /** What the run actually observed for this flow (Deliverable 4) — never conflated with `expected`. */
  actualResult: string[];
  cleanup: string[];
  risks: string[];
  automation: { status: 'automated' | 'partial' | 'manual'; test?: string; pageObjects: string[] };
  /** Replay proof state for this case's suite (Deliverable 4) — honest default `not_replayed`. */
  replayStatus: 'not_replayed' | 'dry_run' | 'same_session' | 'fresh_state' | 'failed' | 'blocked';
  knownBlockers: string[];
  evidence: string[];
}

export interface TestCaseResult {
  cases: TestCase[];
  yaml: string;
  markdown: string;
}

function humanStep(s: PomTestStep): string {
  switch (s.action) {
    case 'tap':
      return s.element ? `Tap ${s.element} on ${s.page}` : `Tap at (${s.coords?.[0]},${s.coords?.[1]}) on ${s.page}`;
    case 'inputText':
      return `Enter ${s.secret ? 'secret value' : `"${s.text}"`} into ${s.element ?? 'the focused field'} on ${s.page}`;
    case 'press':
      return `Press ${s.key}`;
    case 'swipe':
      return `Swipe ${s.direction} on ${s.page}`;
    case 'scrollTo':
      return `Scroll to ${s.element} on ${s.page}`;
    case 'openUrl':
      return `Open ${s.url}`;
    case 'assertVisible':
      return `Verify "${s.text}" is visible on ${s.page}`;
  }
}

export function generateTestCases(
  pom: PomResult,
  opts: {
    appId?: string;
    platform?: string;
    fixtures?: Fixture[];
    notes?: TestNote[];
    budgetProfile?: string;
    replayStatus?: TestCase['replayStatus'];
  },
): TestCaseResult {
  const platform = opts.platform ?? 'android+ios';
  const fixtures = opts.fixtures ?? [];
  const notes = opts.notes ?? [];
  const replayStatus = opts.replayStatus ?? 'not_replayed';

  // Automation status from the locator audit: any brittle locator → partial, else automated.
  const status: TestCase['automation']['status'] = pom.audit.brittle > 0 ? 'partial' : 'automated';

  const knownBlockers = notes
    .filter((n) => n.outcome === 'blocked' || n.category === 'missing_test_data')
    .map((n) => `${n.workflow}: ${n.reason ?? n.missingPrecondition ?? 'blocked'}${n.recommendedSetup ? ` — ${n.recommendedSetup}` : ''}`);
  const evidence = notes.flatMap((n) => n.artifactUris ?? []);
  const verifiedVisualOnly = notes.some((n) => n.method === 'visual' || n.verifiedVisually);

  const expected = pom.steps
    .filter((s) => s.action === 'assertVisible' && s.text)
    .map((s) => `${s.text} is visible`);
  if (expected.length === 0) expected.push('App reaches the expected post-flow screen without an error surface');

  // Actual result = what THIS run observed (Deliverable 4). Kept separate from `expected` so a
  // reviewer/QA can compare intent vs. outcome. When the flow was only recorded (not executed as a
  // discrete test), say so honestly rather than implying a pass.
  const actualResult = notes.length
    ? notes.map((n) => `${n.workflow}: ${n.outcome}${n.reason ? ` — ${n.reason}` : ''}`)
    : ['Not executed as a discrete test in this run — generated from recorded actions; replay to capture an actual result.'];

  const tc: TestCase = {
    id: `TC-${(opts.appId ?? 'APP').split('.').pop()!.slice(0, 6).toUpperCase()}-001`,
    title: pom.testName.replace(/[-_]/g, ' '),
    purpose: `Verify the "${pom.testName}" flow end-to-end.`,
    priority: 'P0',
    platform,
    preconditions: ['app installed', ...(opts.appId ? [`app id ${opts.appId}`] : []), ...fixtures.map((f) => f.requiredState ?? f.name)],
    fixtures: fixtures.map((f) => f.name),
    steps: pom.steps.map(humanStep),
    expected,
    actualResult,
    cleanup: ['return to home/initial screen', ...(verifiedVisualOnly ? [] : [])],
    risks: [
      ...(pom.audit.brittle > 0 ? [`${pom.audit.brittle} brittle locator(s) — flow may break on UI changes (see locator audit)`] : []),
      ...(verifiedVisualOnly ? ['some verification was visual-only — weaker than a structured assertion'] : []),
      ...(pom.variables.length ? [`requires test data: ${pom.variables.join(', ')}`] : []),
    ],
    automation: { status, test: `tests/${kebab(pom.testName)}.smoke.yaml`, pageObjects: pom.pages.map((p) => `pages/${kebab(p.name)}.page.yaml`) },
    replayStatus,
    knownBlockers,
    evidence,
  };

  const cases = [tc];
  const yaml = `# Swipium test case catalog.\n${stringify({ cases })}`;
  const markdown = renderMarkdown(cases);
  return { cases, yaml, markdown };
}

function renderMarkdown(cases: TestCase[]): string {
  const out: string[] = ['# Test Cases', ''];
  for (const c of cases) {
    out.push(
      `## ${c.id}: ${c.title}`,
      ``,
      `- **Priority:** ${c.priority}  **Platform:** ${c.platform}  **Automation:** ${c.automation.status}`,
      `- **Purpose:** ${c.purpose}`,
      ``,
      `**Preconditions:**`,
      ...c.preconditions.map((p) => `- ${p}`),
      ``,
      `**Steps:**`,
      ...c.steps.map((s, i) => `${i + 1}. ${s}`),
      ``,
      `**Expected:**`,
      ...c.expected.map((e) => `- ${e}`),
      ``,
      `**Actual result:**`,
      ...c.actualResult.map((e) => `- ${e}`),
      ``,
      `- **Replay status:** ${c.replayStatus}`,
      ...(c.evidence.length ? [`- **Evidence:** ${c.evidence.join(', ')}`] : []),
      ...(c.cleanup.length ? [`- **Cleanup:** ${c.cleanup.join('; ')}`] : []),
      ...(c.risks.length ? [``, `**Risks:**`, ...c.risks.map((r) => `- ${r}`)] : []),
      ...(c.knownBlockers.length ? [``, `**Known blockers:**`, ...c.knownBlockers.map((b) => `- ${b}`)] : []),
      ...(c.automation.pageObjects.length ? [``, `**Page objects:** ${c.automation.pageObjects.join(', ')}`] : []),
      ``,
    );
  }
  return out.join('\n');
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
