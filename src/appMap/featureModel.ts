// Feature-NODE inference (SWIPIUM-REQ-01 FeatureNode). Complements featureIndex.ts (the lightweight
// code symbol/route index): this maps the static topology + library signals into candidate
// FeatureNodes for the AppKnowledgeMap. Inference is conservative — a feature backed by a single
// weak signal is a HYPOTHESIS, not a fact (Non-Goals § "Do not treat low-confidence feature
// inference as fact"). Runtime merge later enriches testCoverage + runtimeScreens; tickets scope.

import { combineConfidence } from './provenance.js';
import type { AuthModel, FeatureNode, FeatureRisk, FlowModel, StaticTopology } from './schema.js';

interface FeaturePattern {
  id: string;
  title: string;
  objective: string;
  re: RegExp;
  risk: FeatureRisk;
}

// Ordered, lightweight semantic patterns matched against screen names/routes + source files.
const PATTERNS: FeaturePattern[] = [
  {
    id: 'feature:auth',
    title: 'Authentication',
    objective: 'Sign in / sign up / sign out',
    re: /login|signin|sign-in|signup|sign-up|register|auth|password|forgot/i,
    risk: 'high',
  },
  {
    id: 'feature:onboarding',
    title: 'Onboarding',
    objective: 'First-run welcome / tutorial',
    re: /onboard|welcome|intro|get-?started|walkthrough|tutorial/i,
    risk: 'low',
  },
  {
    id: 'feature:paywall',
    title: 'Paywall / Subscription',
    objective: 'Purchase or subscribe',
    re: /paywall|subscribe|subscription|premium|upgrade|pricing|plans?|purchase|checkout|billing/i,
    risk: 'high',
  },
  { id: 'feature:search', title: 'Search', objective: 'Search / discover content', re: /search|explore|discover|browse/i, risk: 'low' },
  { id: 'feature:profile', title: 'Profile', objective: 'View / edit the user profile', re: /profile|account|\bme\b/i, risk: 'medium' },
  { id: 'feature:settings', title: 'Settings', objective: 'Adjust app settings', re: /settings|preferences|config/i, risk: 'medium' },
  {
    id: 'feature:notifications',
    title: 'Notifications',
    objective: 'View / manage notifications',
    re: /notification|alerts?|inbox/i,
    risk: 'low',
  },
  {
    id: 'feature:create',
    title: 'Create / Add',
    objective: 'Create or add an item',
    re: /create|new|add|compose|post|upload/i,
    risk: 'medium',
  },
  { id: 'feature:detail', title: 'Detail / View', objective: 'View an item detail', re: /detail|view|show|info/i, risk: 'low' },
  {
    id: 'feature:checkout',
    title: 'Cart / Checkout',
    objective: 'Cart and checkout',
    re: /cart|checkout|order|payment|\bpay\b/i,
    risk: 'high',
  },
  { id: 'feature:map', title: 'Map / Location', objective: 'Map or location features', re: /\bmap\b|location|nearby|geo/i, risk: 'low' },
  { id: 'feature:media', title: 'Media', objective: 'Photos / video / camera', re: /camera|photo|video|gallery|media/i, risk: 'low' },
];

export interface FeatureInferenceInputs {
  topo: StaticTopology;
  auth: AuthModel;
  onboarding: FlowModel | null;
  paywalls: FlowModel[];
  hasForms: boolean;
}

export function inferFeatures(input: FeatureInferenceInputs): FeatureNode[] {
  const { topo } = input;
  const features: FeatureNode[] = [];

  for (const pat of PATTERNS) {
    const screens = topo.screens.filter(
      (s) => pat.re.test(s.name) || pat.re.test(s.route ?? '') || s.sourceFiles.some((f) => pat.re.test(f)),
    );
    if (!screens.length) continue;
    const sourceFiles = [...new Set(screens.flatMap((s) => s.sourceFiles))];
    // signals: screen-name match + library corroboration for auth/paywall raise confidence to "fact".
    const signals: number[] = [Math.min(0.85, 0.4 + 0.12 * screens.length)];
    const reasons = [`matched ${screens.length} screen(s)`];
    if (pat.id === 'feature:auth' && input.auth.libraries.length) {
      signals.push(0.7);
      reasons.push(`auth library: ${input.auth.libraries.join(', ')}`);
    }
    if (pat.id === 'feature:paywall' && input.paywalls.some((p) => p.libraries.length)) {
      signals.push(0.7);
      reasons.push('purchase/subscription library present');
    }
    if ((pat.id === 'feature:auth' || pat.id === 'feature:create' || pat.id === 'feature:search') && input.hasForms) {
      signals.push(0.3);
      reasons.push('form library present');
    }
    const confidence = combineConfidence(signals);
    const corroborated = signals.length >= 2 || confidence >= 0.8;
    features.push({
      id: pat.id,
      title: pat.title,
      objective: pat.objective,
      sourceFiles,
      staticScreens: screens.map((s) => s.id),
      runtimeScreens: [],
      actions: [],
      riskLevel: pat.risk,
      testCoverage: 'none',
      blockers: pat.id === 'feature:auth' ? ['Requires test credentials (fixture)'] : [],
      status: corroborated ? 'fact' : 'hypothesis',
      confidence,
      reasons,
    });
  }

  // Navigation is always a feature when there is more than one screen.
  if (topo.screens.length > 1) {
    features.push({
      id: 'feature:navigation',
      title: 'Navigation',
      objective: "Move between the app's primary screens",
      sourceFiles: [],
      staticScreens: topo.screens.slice(0, 12).map((s) => s.id),
      runtimeScreens: [],
      actions: [],
      riskLevel: 'low',
      testCoverage: 'none',
      blockers: [],
      status: 'fact',
      confidence: 0.9,
      reasons: [`${topo.screens.length} screens, ${topo.edges.length} navigation edges`],
    });
  }

  return features;
}
