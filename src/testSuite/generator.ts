// Canonical-case generator (SWIPIUM-REQ-06 "qa_suite_generate" + integration hooks). PURE:
// turns a generated POM, the session's observed outcomes (notes), declared fixtures, and guided
// exploration coverage into CanonicalTestCase candidates with a blank id (`''`) — merge.ts assigns a
// stable id and dedupes. Mirrors src/suite/testcase.ts's intent vs. actual discipline but emits the
// long-lived canonical schema (creativity level, traceability, automation readiness, history seed).

import type { PomResult } from '../suite/pom.js';
import type { Fixture, TestNote, ExplorationRecord, TestOutcome } from '../session/store.js';
import {
  type CanonicalTestCase,
  type CasePlatform,
  type CreativityLevel,
  type CaseType,
  type CasePriority,
  type CaseStatus,
  type ActualStatus,
  type ReplayStatus,
  type LocatorReadiness,
  type ProvenanceSource,
  type ActualResultSummary,
  TEST_SUITE_SCHEMA_VERSION,
  functionalitySlug,
} from './schema.js';
import { buildMapLinks, buildEvidence } from './traceability.js';

export interface GenerateInput {
  pom?: PomResult;
  appId?: string;
  platforms?: CasePlatform[];
  /** Human functionality label; defaults from the POM flow name. */
  functionality?: string;
  creativityLevel?: CreativityLevel;
  type?: CaseType;
  priority?: CasePriority;
  status?: CaseStatus;
  fixtures?: Fixture[];
  notes?: TestNote[];
  exploration?: ExplorationRecord;
  screens?: string[];
  ticketRefs?: string[];
  requirementRefs?: string[];
  tags?: string[];
  source: ProvenanceSource;
  now: string;
  replayStatus?: ReplayStatus;
  includeManualOnly?: boolean;
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function outcomeToActual(o: TestOutcome): ActualStatus {
  return o === 'not_applicable' ? 'skipped' : o;
}

function readinessGrade(brittlePct: number): LocatorReadiness {
  if (brittlePct <= 0) return 'A';
  if (brittlePct < 25) return 'B';
  if (brittlePct < 50) return 'C';
  return 'D';
}

/** Fold the session's recorded outcomes into one honest actual-result summary for this flow. */
function actualFromNotes(notes: TestNote[], now: string): ActualResultSummary {
  if (!notes.length) {
    return {
      status: 'not_run',
      summary: 'Generated from recorded actions; not executed as a discrete test — replay to capture an actual result.',
      evidence: [],
    };
  }
  const statuses = notes.map((n) => outcomeToActual(n.outcome));
  const status: ActualStatus = statuses.includes('fail')
    ? 'fail'
    : statuses.includes('blocked')
      ? 'blocked'
      : statuses.every((s) => s === 'skipped')
        ? 'skipped'
        : 'pass';
  const summary = notes.map((n) => `${n.workflow}: ${n.outcome}${n.reason ? ` — ${n.reason}` : ''}`).join('; ');
  const evidence = notes.flatMap((n) => n.artifactUris ?? []);
  const failureCode = notes.find((n) => n.outcome === 'fail' || n.outcome === 'blocked')?.category;
  return { status, summary, lastRunAt: now, evidence, failureCode };
}

/** Build the primary canonical case for a recorded POM flow. */
export function caseFromPom(input: GenerateInput): CanonicalTestCase | null {
  const pom = input.pom;
  if (!pom) return null;
  const functionality = input.functionality ?? pom.testName.replace(/[-_]/g, ' ');
  const featureId = functionalitySlug(functionality);
  const platforms = input.platforms ?? ['android'];
  const fixtures = input.fixtures ?? [];
  const notes = input.notes ?? [];
  const creativityLevel = input.creativityLevel ?? 'standard';
  const replayStatus = input.replayStatus ?? 'not_replayed';

  const steps = pom.steps.map((s, i) => ({
    index: i + 1,
    action: s.action,
    target: s.element ?? (s.coords ? `(${s.coords[0]},${s.coords[1]})` : undefined),
    data: s.secret ? '••• (secret)' : (s.text ?? s.url ?? s.key ?? s.direction),
    expected: s.action === 'assertVisible' && s.text ? `${s.text} is visible` : undefined,
    mapScreenId: s.page,
    automationSelector: s.element,
  }));

  const expectedResult = pom.steps.filter((s) => s.action === 'assertVisible' && s.text).map((s) => `${s.text} is visible`);
  if (!expectedResult.length) expectedResult.push('App reaches the expected post-flow screen without an error surface');

  const automationStatus = pom.audit.brittle > 0 ? 'partial' : 'automated';
  const actualResult = actualFromNotes(notes, input.now);
  const visualOnly = notes.some((n) => n.method === 'visual' || n.verifiedVisually);

  return {
    schemaVersion: TEST_SUITE_SCHEMA_VERSION,
    id: '',
    featureId,
    functionality,
    title: functionality,
    description: `Verify the "${functionality}" flow end-to-end.`,
    objective: `Verify the "${functionality}" flow end-to-end.`,
    priority: input.priority ?? 'P0',
    type: input.type ?? 'smoke',
    creativityLevel,
    platforms,
    preconditions: ['app installed', ...(input.appId ? [`app id ${input.appId}`] : []), ...fixtures.map((f) => f.requiredState ?? f.name)],
    fixtures: fixtures.map((f) => f.name),
    testData: [
      ...fixtures.flatMap((f) =>
        Object.entries(f.fields ?? {}).map(([k, v]) => ({
          name: k,
          value: v.secret ? undefined : v.value,
          secret: v.secret,
          source: f.name,
        })),
      ),
      ...pom.variables.map((v) => ({ name: v, secret: true as const, source: 'flow-variable' })),
    ],
    steps,
    expectedResult,
    actualResult,
    automation: {
      status: automationStatus,
      framework: 'swipium_flow',
      pageObjects: pom.pages.map((p) => `pages/${kebab(p.name)}.page.yaml`),
      testFiles: [`tests/${kebab(pom.testName)}.smoke.yaml`],
      locatorReadiness: readinessGrade(pom.audit.brittlePct),
      replayStatus,
    },
    status: input.status ?? 'active',
    risk: [
      ...(pom.audit.brittle > 0 ? [`${pom.audit.brittle} brittle locator(s) — flow may break on UI changes`] : []),
      ...(visualOnly ? ['some verification was visual-only — weaker than a structured assertion'] : []),
      ...(pom.variables.length ? [`requires test data: ${pom.variables.join(', ')}`] : []),
    ],
    cleanup: ['return to home/initial screen'],
    mapLinks: buildMapLinks({ pages: pom.pages.map((p) => p.name), screens: input.screens, featureId }),
    ticketRefs: input.ticketRefs ?? [],
    requirementRefs: input.requirementRefs ?? [],
    evidence: buildEvidence(notes.flatMap((n) => n.artifactUris ?? [])),
    history: [],
    tags: Array.from(new Set([input.type ?? 'smoke', creativityLevel, ...(input.tags ?? [])])),
    createdAt: input.now,
    updatedAt: input.now,
    provenance: [],
  };
}

/** Draft cases promoted from guided exploration's per-feature coverage (confidence → draft vs active). */
export function casesFromExploration(input: GenerateInput): CanonicalTestCase[] {
  const exp = input.exploration;
  const coverage = exp?.summary.featureCoverage;
  if (!coverage) return [];
  const platforms = input.platforms ?? ['android'];
  return Object.entries(coverage).map(([feature, conf]) => {
    const functionality = feature;
    const featureId = functionalitySlug(functionality);
    // "covered"/"verified" → active; "partial"/"seen"/anything weaker → draft.
    const status: CaseStatus = /cover|verif|pass|done/i.test(conf) ? 'active' : 'draft';
    return {
      schemaVersion: TEST_SUITE_SCHEMA_VERSION,
      id: '',
      featureId,
      functionality,
      title: functionality,
      description: `Exercise the "${functionality}" feature discovered during guided exploration.`,
      objective: `Exercise the "${functionality}" feature.`,
      priority: input.priority ?? 'P1',
      type: 'functional' as CaseType,
      creativityLevel: input.creativityLevel ?? 'standard',
      platforms,
      preconditions: ['app installed'],
      fixtures: [],
      testData: [],
      steps: [
        {
          index: 1,
          action: 'explore',
          target: functionality,
          expected: `${functionality} is reachable and renders without an error surface`,
        },
      ],
      expectedResult: [`${functionality} is reachable and renders without an error surface`],
      actualResult: {
        status: (exp!.summary.appErrors > 0 ? 'fail' : 'pass') as ActualStatus,
        summary: `Exploration coverage: ${conf}`,
        lastRunAt: input.now,
        evidence: [],
      },
      automation: {
        status: 'candidate',
        framework: 'swipium_flow',
        pageObjects: [],
        testFiles: [],
        locatorReadiness: 'D',
        replayStatus: 'not_replayed',
      },
      status,
      risk: [],
      cleanup: [],
      mapLinks: buildMapLinks({ featureId }),
      ticketRefs: input.ticketRefs ?? [],
      requirementRefs: input.requirementRefs ?? [],
      evidence: [],
      history: [],
      tags: ['exploration', input.creativityLevel ?? 'standard'],
      createdAt: input.now,
      updatedAt: input.now,
      provenance: [],
    } satisfies CanonicalTestCase;
  });
}

/** Fill a partial/manual case (e.g. from qa_suite_update input) into a complete CanonicalTestCase. */
export function normalizeCase(input: Partial<CanonicalTestCase> & { functionality?: string }, now: string): CanonicalTestCase {
  const functionality = input.functionality ?? input.title ?? 'general';
  const featureId = input.featureId ?? functionalitySlug(functionality);
  return {
    schemaVersion: TEST_SUITE_SCHEMA_VERSION,
    id: input.id ?? '',
    featureId,
    functionality,
    title: input.title ?? functionality,
    description: input.description ?? '',
    objective: input.objective ?? input.title ?? functionality,
    priority: input.priority ?? 'P2',
    type: input.type ?? 'functional',
    creativityLevel: input.creativityLevel ?? 'standard',
    platforms: input.platforms?.length ? input.platforms : ['android'],
    preconditions: input.preconditions ?? [],
    fixtures: input.fixtures ?? [],
    testData: input.testData ?? [],
    steps: (input.steps ?? []).map((s, i) => ({ ...s, index: s.index ?? i + 1 })),
    expectedResult: input.expectedResult ?? [],
    actualResult: input.actualResult ?? { status: 'not_run', summary: 'Authored manually; not yet run.', evidence: [] },
    automation: input.automation ?? {
      status: 'manual',
      pageObjects: [],
      testFiles: [],
      locatorReadiness: 'D',
      replayStatus: 'not_replayed',
    },
    status: input.status ?? 'draft',
    risk: input.risk ?? [],
    cleanup: input.cleanup ?? [],
    mapLinks: input.mapLinks ?? [],
    ticketRefs: input.ticketRefs ?? [],
    requirementRefs: input.requirementRefs ?? [],
    evidence: input.evidence ?? [],
    history: input.history ?? [],
    owner: input.owner,
    tags: input.tags ?? [],
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    provenance: input.provenance ?? [],
    manuallyEdited: input.manuallyEdited,
  };
}

/** Top-level: build every candidate case for a run (POM flow + exploration drafts). */
export function generateCanonicalCases(input: GenerateInput): CanonicalTestCase[] {
  const cases: CanonicalTestCase[] = [];
  const primary = caseFromPom(input);
  if (primary) cases.push(primary);
  cases.push(...casesFromExploration(input));
  return cases;
}
