// Feature objective model (SWIPIUM-REQ-03 "Objective Model Requirements"). PURE, best-effort,
// deterministic. From a resolved FeatureScope it derives what the feature is *for* — happy path,
// expected outputs, inputs, business rules (marked as hypotheses when low-confidence), negative and
// edge cases, destructive boundaries, and the oracle strategy. Every claim carries provenance and a
// confidence so a low-confidence hypothesis is never presented as proof (Non-Goals).

import type { FeatureScope } from './featureScope.js';

export interface InputRequirement {
  name: string;
  type?: string;
  required: boolean;
  source: string;
}

export interface ProvenanceEntry {
  source: 'route' | 'screen' | 'symbol' | 'runtime' | 'test' | 'vocabulary' | 'fixture';
  detail: string;
  confidence: number;
}

export type OracleStrategy = 'structured' | 'visual' | 'api_assisted' | 'manual';

export interface FeatureObjective {
  featureId: string;
  userGoal: string;
  primaryHappyPath: string[];
  expectedOutputs: string[];
  inputFields: InputRequirement[];
  businessRules: string[];
  externalDependencies: string[];
  negativeCases: string[];
  edgeCases: string[];
  destructiveBoundaries: string[];
  oracleStrategy: OracleStrategy;
  confidence: number;
  provenance: ProvenanceEntry[];
  /** Business rules that are low-confidence guesses, flagged so callers never gate a release on them. */
  hypotheses: string[];
}

const AUTH_TERMS = new Set(['auth', 'login', 'signin', 'authentication', 'credentials', 'password', 'account', 'register', 'signup']);
const SEARCH_TERMS = new Set(['search', 'find', 'filter', 'query', 'lookup', 'browse']);
const CREATE_TERMS = new Set(['create', 'add', 'new', 'compose', 'upload', 'post']);
const PAYMENT_TERMS = new Set(['checkout', 'payment', 'pay', 'purchase', 'order', 'subscribe', 'billing']);
const DESTRUCTIVE_TERMS = new Set(['delete', 'remove', 'destroy', 'clear', 'wipe', 'cancel', 'logout', 'deactivate']);

function has(terms: string[], set: Set<string>): boolean {
  return terms.some((t) => set.has(t));
}

export function buildObjective(scope: FeatureScope): FeatureObjective {
  const terms = scope.matchedTerms;
  const provenance: ProvenanceEntry[] = [];
  const happyPath: string[] = [];
  const expectedOutputs: string[] = [];
  const inputFields: InputRequirement[] = [];
  const businessRules: string[] = [];
  const hypotheses: string[] = [];
  const externalDependencies: string[] = [];
  const negativeCases: string[] = [];
  const edgeCases: string[] = [];
  const destructiveBoundaries: string[] = [];

  // ---- entry → happy path ----
  const entry = scope.entryPoints[0];
  if (entry) {
    happyPath.push(`Open the ${entry.kind.replace('_', ' ')} "${entry.value}"`);
    provenance.push({ source: entry.kind === 'route' || entry.kind === 'deep_link' ? 'route' : entry.kind === 'runtime_node' ? 'runtime' : 'screen', detail: `entry point ${entry.value}`, confidence: entry.confidence });
  } else if (scope.staticScreens[0]) {
    happyPath.push(`Navigate to ${scope.staticScreens[0].name}`);
    provenance.push({ source: 'screen', detail: scope.staticScreens[0].name, confidence: scope.staticScreens[0].confidence });
  } else {
    happyPath.push(`Navigate to the ${scope.title} surface`);
  }

  // ---- vocabulary-driven path + outputs + inputs ----
  if (has(terms, SEARCH_TERMS)) {
    happyPath.push('Enter a query and apply the search/filter');
    expectedOutputs.push('A result list updates to reflect the query');
    inputFields.push({ name: 'searchTerm', type: 'text', required: true, source: 'search vocabulary' });
    negativeCases.push('Empty query → no crash; shows empty/zero-results state');
    edgeCases.push('Query with special characters / very long input');
    provenance.push({ source: 'vocabulary', detail: 'search/filter terms', confidence: 0.5 });
  }
  if (has(terms, CREATE_TERMS)) {
    happyPath.push('Fill the required fields and submit');
    expectedOutputs.push('The new item appears / a success confirmation is shown');
    negativeCases.push('Submit with required fields blank → validation error, no creation');
    edgeCases.push('Duplicate / boundary-length values; interruption mid-create');
    businessRules.push('Required fields must be validated before submission');
    hypotheses.push('Required-field set is inferred from vocabulary, not a schema — verify against the form');
    provenance.push({ source: 'vocabulary', detail: 'create/add terms', confidence: 0.45 });
  }
  if (has(terms, AUTH_TERMS)) {
    inputFields.push({ name: 'email', type: 'email', required: true, source: 'auth vocabulary' });
    inputFields.push({ name: 'password', type: 'password', required: true, source: 'auth vocabulary' });
    expectedOutputs.push('On valid credentials the authenticated home/landing surface is reached');
    negativeCases.push('Invalid credentials → inline error, stays on the login screen');
    edgeCases.push('Locked/rate-limited account; OTP/2FA step');
    externalDependencies.push('Authentication backend / identity provider');
    businessRules.push('Invalid credentials must not grant access');
    provenance.push({ source: 'vocabulary', detail: 'auth terms', confidence: 0.6 });
  }
  if (has(terms, PAYMENT_TERMS)) {
    happyPath.push('Proceed through the checkout/payment step');
    expectedOutputs.push('An order/subscription confirmation is shown');
    externalDependencies.push('Payment processor (use sandbox/test mode)');
    destructiveBoundaries.push('Do NOT submit a real payment — only a sandbox/test method, with explicit consent');
    negativeCases.push('Declined card → error surfaced, no charge');
    businessRules.push('A charge must only occur after explicit user confirmation');
    provenance.push({ source: 'vocabulary', detail: 'payment terms', confidence: 0.55 });
  }
  if (has(terms, DESTRUCTIVE_TERMS)) {
    destructiveBoundaries.push('Destructive actions (delete/remove/cancel) require disposable test state + candidate-bound consent');
    negativeCases.push('Cancel the destructive confirmation → nothing is destroyed');
    edgeCases.push('Undo / recovery path after the destructive action');
    provenance.push({ source: 'vocabulary', detail: 'destructive terms', confidence: 0.5 });
  }

  // ---- external dependencies from services in scope ----
  for (const dep of scope.dataDependencies) {
    if (dep.kind === 'external' || dep.kind === 'api') {
      externalDependencies.push(dep.name);
      provenance.push({ source: 'symbol', detail: dep.evidence, confidence: 0.6 });
    }
  }

  // ---- existing tests sharpen the objective ----
  for (const t of scope.existingTests) {
    provenance.push({ source: 'test', detail: `${t.id} ${t.title}`, confidence: 0.7 });
  }

  // ---- defaults / dedupe ----
  if (!happyPath.some((s) => /verif|confirm|outcome|result/i.test(s))) happyPath.push(`Verify the ${scope.title} outcome is shown without an error surface`);
  if (!expectedOutputs.length) expectedOutputs.push(`The ${scope.title} screen renders its primary content without an error surface`);

  // ---- oracle strategy ----
  const oracleStrategy: OracleStrategy = scope.runtimeScreens.length
    ? 'structured'
    : externalDependencies.length
      ? 'api_assisted'
      : scope.staticScreens.length
        ? 'structured'
        : 'manual';

  const userGoal = `As a user, I want to use ${scope.title.toLowerCase()} so that I accomplish its intended outcome.`;

  // objective confidence tracks scope confidence but is capped lower since the model is inferential
  const confidence = Math.round(Math.min(0.9, scope.confidence * 0.9 + 0.1) * 100) / 100;

  return {
    featureId: scope.featureId,
    userGoal,
    primaryHappyPath: dedupe(happyPath),
    expectedOutputs: dedupe(expectedOutputs),
    inputFields,
    businessRules: dedupe(businessRules),
    externalDependencies: dedupe(externalDependencies),
    negativeCases: dedupe(negativeCases),
    edgeCases: dedupe(edgeCases),
    destructiveBoundaries: dedupe(destructiveBoundaries),
    oracleStrategy,
    confidence,
    provenance,
    hypotheses: dedupe(hypotheses),
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
