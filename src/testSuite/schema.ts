// Canonical persistent QA test-case suite schema (SWIPIUM-REQ-06). This is the long-lived,
// project-level QA knowledge that grows with the app map — distinct from the per-run test catalog
// (src/report/testCatalog.ts) and the per-suite POM catalog (src/suite/testcase.ts), which are
// snapshots. A CanonicalTestCase carries manual + automated coverage, expected vs. actual results,
// creativity level, automation readiness, traceability to the app/tickets/requirements, and a
// historical run ledger. PURE: types + validation + id helpers only; the store (store.ts) does IO.

export const TEST_SUITE_SCHEMA_VERSION = 1 as const;

export type CasePriority = 'P0' | 'P1' | 'P2' | 'P3';
export type CaseType =
  'smoke' | 'functional' | 'regression' | 'negative' | 'edge' | 'accessibility' | 'visual' | 'performance' | 'security';
export type CreativityLevel = 'conservative' | 'standard' | 'creative' | 'adversarial';
export type CasePlatform = 'android' | 'ios';
export type CaseStatus = 'active' | 'draft' | 'deprecated' | 'blocked' | 'manual_only';
export type ActualStatus = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not_run';
export type AutomationStatus = 'automated' | 'partial' | 'manual' | 'candidate' | 'not_automatable_yet';
export type AutomationFramework = 'swipium_flow' | 'appium_js' | 'appium_python' | 'maestro';
export type LocatorReadiness = 'A' | 'B' | 'C' | 'D';
export type ReplayStatus = 'not_replayed' | 'dry_run' | 'same_session' | 'fresh_state' | 'failed' | 'blocked';

export interface TestStep {
  index: number;
  action: string;
  target?: string;
  data?: string;
  expected?: string;
  mapScreenId?: string;
  automationSelector?: string;
}

export interface ActualResultSummary {
  status: ActualStatus;
  summary: string;
  lastRunAt?: string;
  evidence: string[];
  failureCode?: string;
}

// SWIPIUM-REQ-08 — links a canonical test case to issue-ledger records. The issue ledger remains the
// source of truth; the suite stores only the issue id + fingerprint + relationship, never events.
export type TestCaseIssueRelationship = 'caused_failure' | 'blocks_case' | 'verified_fixed' | 'known_noise' | 'improvement';
export type TestCaseRunIssueRelationship = 'observed' | 'verified_fixed' | 'regressed' | 'suppressed';

export interface TestCaseIssueRef {
  issueId: string;
  fingerprint: string;
  relationship: TestCaseIssueRelationship;
  firstLinkedAt: string;
  lastLinkedAt: string;
  /** Last known issue state (mirror of the ledger; advisory, not authoritative). */
  lastIssueState: string;
  lastReportUri?: string;
}

export interface TestCaseRunIssueLink {
  issueId: string;
  fingerprint: string;
  relationship: TestCaseRunIssueRelationship;
  reportUri?: string;
  evidenceUris?: string[];
}

export interface AutomationLink {
  status: AutomationStatus;
  framework?: AutomationFramework;
  pageObjects: string[];
  testFiles: string[];
  locatorReadiness: LocatorReadiness;
  replayStatus: ReplayStatus;
}

export interface TestDataRef {
  name: string;
  value?: string; // never a raw secret — redacted/placeholder
  secret?: boolean;
  source?: string;
}

export interface AppMapLink {
  kind: 'screen' | 'feature' | 'static_screen' | 'runtime_screen' | 'source_file' | 'node';
  id: string;
  label?: string;
}

export interface EvidenceRef {
  uri: string;
  kind?: string;
  label?: string;
}

/** One entry in a case's historical run ledger. */
export interface TestRunRef {
  runId: string;
  at: string;
  status: ActualStatus;
  summary?: string;
  source: ProvenanceSource;
  evidence: string[];
  /** Issue-ledger links observed/verified on this run (SWIPIUM-REQ-08). */
  issueLinks?: TestCaseRunIssueLink[];
}

export type ProvenanceSource = 'report' | 'exploration' | 'feature' | 'ticket' | 'manual' | 'generate' | 'suite';

export interface ProvenanceEntry {
  source: ProvenanceSource;
  at: string;
  sourceUri?: string;
  /** Fields this provenance entry wrote — used to protect manually-curated fields on regeneration. */
  fields?: string[];
  note?: string;
}

export interface CanonicalTestCase {
  schemaVersion: typeof TEST_SUITE_SCHEMA_VERSION;
  id: string;
  featureId: string;
  functionality: string;
  title: string;
  description: string;
  objective: string;
  priority: CasePriority;
  type: CaseType;
  creativityLevel: CreativityLevel;
  platforms: CasePlatform[];
  preconditions: string[];
  fixtures: string[];
  testData: TestDataRef[];
  steps: TestStep[];
  expectedResult: string[];
  actualResult: ActualResultSummary;
  automation: AutomationLink;
  status: CaseStatus;
  risk: string[];
  cleanup: string[];
  mapLinks: AppMapLink[];
  ticketRefs: string[];
  requirementRefs: string[];
  evidence: EvidenceRef[];
  history: TestRunRef[];
  owner?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  provenance: ProvenanceEntry[];
  /** True once a human edits the case; protects curated fields from generated overwrites. */
  manuallyEdited?: boolean;
  /** Durable links to issue-ledger records (SWIPIUM-REQ-08). The ledger is the source of truth. */
  issueRefs?: TestCaseIssueRef[];
}

/** The top-level `.swipium/test-suite.json` document. */
export interface TestSuiteFile {
  schemaVersion: typeof TEST_SUITE_SCHEMA_VERSION;
  updatedAt: string;
  appId?: string;
  cases: CanonicalTestCase[];
  /** IDs that have been allocated (incl. deprecated) so they are never reused. */
  retiredIds: string[];
}

export const PRIORITIES: CasePriority[] = ['P0', 'P1', 'P2', 'P3'];
export const CASE_TYPES: CaseType[] = [
  'smoke',
  'functional',
  'regression',
  'negative',
  'edge',
  'accessibility',
  'visual',
  'performance',
  'security',
];
export const CREATIVITY_LEVELS: CreativityLevel[] = ['conservative', 'standard', 'creative', 'adversarial'];
export const CASE_STATUSES: CaseStatus[] = ['active', 'draft', 'deprecated', 'blocked', 'manual_only'];
export const ACTUAL_STATUSES: ActualStatus[] = ['pass', 'fail', 'blocked', 'skipped', 'not_run'];
export const AUTOMATION_STATUSES: AutomationStatus[] = ['automated', 'partial', 'manual', 'candidate', 'not_automatable_yet'];
export const LOCATOR_READINESS: LocatorReadiness[] = ['A', 'B', 'C', 'D'];

/** Fields populated by generation; everything else is curated/manual and never overwritten silently. */
export const GENERATED_FIELDS = ['steps', 'expectedResult', 'automation', 'mapLinks', 'preconditions', 'fixtures', 'testData'] as const;

export function emptySuite(appId?: string, now = new Date().toISOString()): TestSuiteFile {
  return { schemaVersion: TEST_SUITE_SCHEMA_VERSION, updatedAt: now, appId, cases: [], retiredIds: [] };
}

/** Slugify a functionality label into a stable, filesystem-safe segment (e.g. "Weather Analysis" → "weather-analysis"). */
export function functionalitySlug(functionality: string): string {
  return (
    functionality
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'general'
  );
}

/** Derive the ID prefix token for a functionality (e.g. "weather-analysis" → "WEATHER"). */
export function idPrefix(functionality: string): string {
  const slug = functionalitySlug(functionality);
  const token = slug.split('-')[0] || 'gen';
  return (
    token
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10)
      .toUpperCase() || 'GEN'
  );
}

/** A normalized identity key for de-duplication: feature + objective + ordered (action→target) steps. */
export function caseIdentity(c: Pick<CanonicalTestCase, 'featureId' | 'objective' | 'steps'>): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const stepKey = c.steps.map((s) => `${norm(s.action)}>${norm(s.target ?? '')}`).join('|');
  return `${norm(c.featureId)}::${norm(c.objective)}::${stepKey}`;
}

/** Validate a single canonical case, returning human-readable errors (empty = valid). */
export function validateCase(c: CanonicalTestCase): string[] {
  const errors: string[] = [];
  const must = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg);
  };
  must(c.schemaVersion === TEST_SUITE_SCHEMA_VERSION, `schemaVersion must be ${TEST_SUITE_SCHEMA_VERSION}`);
  must(!!c.id, 'id is required');
  must(!!c.featureId, `${c.id}: featureId is required`);
  must(!!c.functionality, `${c.id}: functionality is required`);
  must(!!c.title, `${c.id}: title is required`);
  must(PRIORITIES.includes(c.priority), `${c.id}: invalid priority ${c.priority}`);
  must(CASE_TYPES.includes(c.type), `${c.id}: invalid type ${c.type}`);
  must(CREATIVITY_LEVELS.includes(c.creativityLevel), `${c.id}: invalid creativityLevel ${c.creativityLevel}`);
  must(CASE_STATUSES.includes(c.status), `${c.id}: invalid status ${c.status}`);
  must(Array.isArray(c.platforms) && c.platforms.length > 0, `${c.id}: at least one platform required`);
  must(Array.isArray(c.steps), `${c.id}: steps must be an array`);
  must(Array.isArray(c.expectedResult), `${c.id}: expectedResult must be an array`);
  must(!!c.actualResult && ACTUAL_STATUSES.includes(c.actualResult.status), `${c.id}: invalid actualResult.status`);
  must(!!c.automation && AUTOMATION_STATUSES.includes(c.automation.status), `${c.id}: invalid automation.status`);
  must(!!c.automation && LOCATOR_READINESS.includes(c.automation.locatorReadiness), `${c.id}: invalid automation.locatorReadiness`);
  return errors;
}

/** Validate the whole suite (per-case + duplicate-id check). */
export function validateSuite(suite: TestSuiteFile): string[] {
  const errors: string[] = [];
  if (suite.schemaVersion !== TEST_SUITE_SCHEMA_VERSION) errors.push(`suite schemaVersion must be ${TEST_SUITE_SCHEMA_VERSION}`);
  const seen = new Set<string>();
  for (const c of suite.cases) {
    if (seen.has(c.id)) errors.push(`duplicate id ${c.id}`);
    seen.add(c.id);
    errors.push(...validateCase(c));
  }
  return errors;
}
