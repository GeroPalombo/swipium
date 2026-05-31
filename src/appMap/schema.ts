// AppKnowledgeMap (SWIPIUM-REQ-01) — the durable, project-level business-context layer Swipium
// reads before acting and writes back to after observing. It MERGES static code analysis, app
// config, runtime exploration, feature hypotheses, automation artifacts, tickets, and test cases
// into one schema-versioned document persisted at `.swipium/app-map.json`.
//
// Design rules baked into the shape:
//  - Every fact carries PROVENANCE (which source it came from) and CONFIDENCE (with reason codes).
//  - Low-confidence inference is a HYPOTHESIS, never asserted as fact (Non-Goals §).
//  - Contradictory runtime observations are preserved as versioned facts, not overwritten blindly.
//  - Large arrays are returned by resource URI by the tools, not flooded into a text result.

import type { Framework } from '../context/detect.js';

/** Current on-disk schema version. Bumping this requires a migration in migrations.ts. */
export const APP_MAP_SCHEMA_VERSION = 1 as const;

export type ProvenanceSource =
  | 'code_scan'
  | 'app_config'
  | 'runtime'
  | 'ticket'
  | 'user_note'
  | 'test_case'
  | 'report';

/** Where a fact came from. Every non-trivial node should be traceable to at least one of these. */
export interface ProvenanceEntry {
  id: string;
  source: ProvenanceSource;
  at: string; // ISO timestamp
  detail: string; // human description of what this established
  refs?: string[]; // source files, artifact URIs, ticket ids, session ids
  targetType?: 'screen' | 'feature' | 'edge' | 'auth' | 'input' | 'ticket' | 'test' | 'identity' | 'map';
  targetId?: string;
}

/** Per-node confidence with machine-readable reason codes (so stale/weak facts are obvious). */
export interface ConfidenceEntry {
  score: number; // 0..1
  reasons: string[]; // reason codes, e.g. 'route_file_present', 'single_signal', 'parser_partial'
}

export interface ConfidenceSummary {
  overall: number; // 0..1
  features: Record<string, ConfidenceEntry>;
  screens: Record<string, ConfidenceEntry>;
}

export interface ProjectIdentity {
  root: string;
  gitRemote: string | null;
  packageName: string | null; // package.json name / gradle namespace / pubspec name
  workspaceTarget: string | null; // monorepo workspace, if any
  framework: Framework;
  platforms: Array<'android' | 'ios'>;
}

export interface SourceFingerprintFile {
  path: string; // relative to project root
  hash: string; // sha256:...
  mtimeMs: number;
}

export interface SourceFingerprint {
  generatedAt: string;
  files: SourceFingerprintFile[];
}

export interface AppIdentity {
  androidPackage: string | null;
  iosBundleId: string | null;
  appName: string | null;
  version: string | null;
  artifactHash: string | null;
  environment: string | null; // 'debug' | 'release' | 'test' | ...
}

export type StaticScreenKind =
  | 'route'
  | 'screen'
  | 'component'
  | 'modal'
  | 'tab'
  | 'layout'
  | 'not_found'
  | 'activity'
  | 'fragment'
  | 'view_controller'
  | 'page';

/**
 * Compact, derived issue summary for a screen or feature (SWIPIUM-REQ-08). The issue ledger
 * (`.swipium/issues-log.jsonl`) is the source of truth; the app map stores only pointers + counts,
 * never full issue events. Rebuilt on every app-map refresh from the issue index.
 */
export interface AppMapIssueSummary {
  openIssueIds: string[];
  recurringIssueIds: string[];
  hardGateIssueIds: string[];
  storeComplianceIssueIds: string[];
  knownNoiseIssueIds: string[];
  improvementIssueIds: string[];
  fixedIssueIds: string[];
  counts: {
    open: number;
    recurring: number;
    hardGate: number;
    storeCompliance: number;
    knownNoise: number;
    improvement: number;
    fixed: number;
  };
  releaseImpact: 'block' | 'warn' | 'pass';
  lastIssueSeenAt?: string;
  topIssueIds: string[];
  updatedAt: string;
}

export interface StaticScreen {
  id: string; // stable id derived from route/name
  name: string;
  route?: string; // route path / url / nav name
  kind: StaticScreenKind;
  sourceFiles: string[]; // relative paths
  deepLinks?: string[];
  exported?: boolean;
  navParams?: string[];
  confidence: number; // 0..1
  reasons: string[];
  /** Derived issue summary (SWIPIUM-REQ-08). */
  issueSummary?: AppMapIssueSummary;
}

export interface NavigationEdge {
  from?: string; // static screen id (may be unknown)
  to: string; // static screen id or route name
  kind: 'navigation' | 'tab' | 'stack' | 'drawer' | 'deep_link' | 'route_declaration';
  evidence: string; // "file:symbol" or call site
  confidence: number;
}

export interface RouteConstant {
  name: string;
  value: string;
  file: string;
}

export interface StaticTopology {
  framework: Framework;
  router: string | null; // 'expo-router' | 'react-navigation' | 'jetpack-navigation' | 'compose-navigation' | 'flutter-routes' | 'go_router' | 'storyboard' | null
  screens: StaticScreen[];
  edges: NavigationEdge[];
  deepLinks: string[];
  routeConstants: RouteConstant[];
  nativeActivities: string[];
  viewControllers: string[];
  flutterRoutes: string[];
  permissions: string[];
  parserNotes: string[]; // parser failures recorded as partial confidence, never hard blockers
}

export interface RuntimeContradiction {
  at: string;
  field: string;
  was: unknown;
  now: unknown;
}

export interface RuntimeScreen {
  id: string;
  signature: string;
  title?: string;
  route?: string;
  platform: 'android' | 'ios';
  foregroundOwner?: string; // activity / view controller
  uiSignature?: string; // structured tree signature
  visualSignature?: string; // used when structured tree is missing
  textTokens?: string[];
  locatorIds?: string[]; // accessibility / resource ids
  screenshotHash?: string;
  lastArtifactUris: string[];
  authState?: string;
  /** First-run classification of this screen (login/onboarding/paywall/home/...), when observed. */
  purpose?: string;
  locatorReadiness: 'A' | 'B' | 'C' | 'D' | 'unknown';
  firstSeen: string;
  lastSeen: string;
  visits: number;
  linkedStaticScreenId?: string;
  linkConfidence?: number;
  unmapped?: boolean; // no static screen matched ("unmapped runtime screen")
  contradictions?: RuntimeContradiction[];
  /** Derived issue summary (SWIPIUM-REQ-08). */
  issueSummary?: AppMapIssueSummary;
}

export interface RuntimeEdge {
  from: string; // runtime screen id
  to?: string; // runtime screen id
  action: { type: string; targetDescription: string };
  outcome: string;
  evidenceUris: string[];
  observedCount: number;
}

export interface RuntimeTopology {
  mergedFromSessions: string[];
  screens: RuntimeScreen[];
  edges: RuntimeEdge[];
  /** Static screens declared in code but never reached at runtime ("unvisited static screen"). */
  unvisitedStaticScreens: string[];
}

export type FeatureRisk = 'low' | 'medium' | 'high';
export type TestCoverage = 'none' | 'partial' | 'covered';

export interface FeatureNode {
  id: string;
  title: string;
  objective?: string;
  sourceFiles: string[];
  staticScreens: string[]; // static screen ids
  runtimeScreens: string[]; // runtime screen ids
  actions: string[];
  riskLevel: FeatureRisk;
  testCoverage: TestCoverage;
  blockers: string[];
  /** 'fact' only when corroborated by ≥2 signals or runtime; otherwise a 'hypothesis'. */
  status: 'fact' | 'hypothesis';
  confidence: number;
  reasons: string[];
  /** Derived issue summary rolled up from this feature's screens + linked test cases (REQ-08). */
  issueSummary?: AppMapIssueSummary;
}

export interface AuthModel {
  hasAuth: boolean;
  signals: string[]; // dependency / import signals
  libraries: string[];
  screens: string[]; // static or runtime screen ids
  loginScreenSeen?: boolean;
  confidence: number;
}

export interface FlowModel {
  id: string;
  kind: 'onboarding' | 'paywall' | 'subscription';
  present: boolean;
  signals: string[];
  libraries: string[];
  screens: string[];
  confidence: number;
}

export interface InputModel {
  fieldPurpose: string; // 'email' | 'password' | 'search' | 'otp' | ...
  inputType?: string;
  safeGenerator?: string; // e.g. 'faker.internet.email'
  fixtureRequired: boolean;
  secret: boolean;
  validation?: string; // expectation, e.g. 'min 8 chars'
  screen?: string; // screen id when known
  source: string; // file or 'runtime'
}

export interface TestDataPolicy {
  allowedGenerators: string[];
  disallowedEnvironments: string[]; // e.g. ['production']
  emailDefault: string | null;
  passwordDefault: string | null;
  cleanupExpectations: string;
}

export interface CoverageModel {
  staticScreens: number;
  runtimeScreens: number;
  linkedScreens: number;
  unvisitedStaticScreens: number;
  unmappedRuntimeScreens: number;
  featureCoverage: Record<string, TestCoverage>;
  staleTests: number;
  /** runtimeScreens linked to static / static screens (0..100). */
  overallPercent: number;
}

export interface AutomationSuiteRef {
  name: string;
  path: string;
  framework?: string; // wdio | appium-python | maestro | ...
  linkedFeatureIds?: string[];
  linkedScreenIds?: string[];
}

export interface AutomationModel {
  suites: AutomationSuiteRef[];
  flows: Array<{ name: string; uri: string }>;
  recordedActionCount?: number;
}

export interface TestCaseRef {
  id: string;
  title: string;
  featureId?: string;
  screenId?: string;
  status?: string;
  source?: string; // suite path / report
  lastRun?: string;
  stale?: boolean;
}

export interface TestSuiteIndex {
  cases: TestCaseRef[];
}

export interface TicketTrace {
  id: string;
  ref?: string; // Jira / issue URL
  touchedFiles: string[];
  scopedFeatures: string[];
  generatedCases: string[];
  executedRuns: string[];
}

export interface TicketTraceIndex {
  tickets: TicketTrace[];
}

export interface AppKnowledgeMap {
  schemaVersion: typeof APP_MAP_SCHEMA_VERSION;
  project: ProjectIdentity;
  generatedAt: string;
  updatedAt: string;
  sourceFingerprint: SourceFingerprint;
  appIdentity: AppIdentity;
  staticTopology: StaticTopology;
  runtimeTopology: RuntimeTopology;
  features: FeatureNode[];
  auth: AuthModel;
  onboarding: FlowModel | null;
  paywalls: FlowModel[];
  inputModels: InputModel[];
  testDataPolicy: TestDataPolicy;
  coverage: CoverageModel;
  automation: AutomationModel;
  testSuite: TestSuiteIndex;
  tickets: TicketTraceIndex;
  provenance: ProvenanceEntry[];
  confidence: ConfidenceSummary;
}

/** A default, empty map for `project`. Filled in by the static scanner + runtime merge. */
export function emptyAppMap(project: ProjectIdentity, generatedAt: string): AppKnowledgeMap {
  return {
    schemaVersion: APP_MAP_SCHEMA_VERSION,
    project,
    generatedAt,
    updatedAt: generatedAt,
    sourceFingerprint: { generatedAt, files: [] },
    appIdentity: { androidPackage: null, iosBundleId: null, appName: null, version: null, artifactHash: null, environment: null },
    staticTopology: {
      framework: project.framework,
      router: null,
      screens: [],
      edges: [],
      deepLinks: [],
      routeConstants: [],
      nativeActivities: [],
      viewControllers: [],
      flutterRoutes: [],
      permissions: [],
      parserNotes: [],
    },
    runtimeTopology: { mergedFromSessions: [], screens: [], edges: [], unvisitedStaticScreens: [] },
    features: [],
    auth: { hasAuth: false, signals: [], libraries: [], screens: [], confidence: 0 },
    onboarding: null,
    paywalls: [],
    inputModels: [],
    testDataPolicy: {
      allowedGenerators: ['faker.internet.email', 'faker.internet.password', 'faker.person.fullName', 'static.search-term'],
      disallowedEnvironments: ['production'],
      emailDefault: null,
      passwordDefault: null,
      cleanupExpectations: 'Use disposable accounts/data only; never run destructive flows against production.',
    },
    coverage: {
      staticScreens: 0,
      runtimeScreens: 0,
      linkedScreens: 0,
      unvisitedStaticScreens: 0,
      unmappedRuntimeScreens: 0,
      featureCoverage: {},
      staleTests: 0,
      overallPercent: 0,
    },
    automation: { suites: [], flows: [] },
    testSuite: { cases: [] },
    tickets: { tickets: [] },
    provenance: [],
    confidence: { overall: 0, features: {}, screens: {} },
  };
}
