import type { RankedCandidate } from './candidates.js';
import type { CoverageClaim, ExploreTask, FeatureKey, FeatureStatus, ReflectionResult, ScreenNode } from './graph.js';

const FEATURE_RULES: Array<{ feature: FeatureKey; re: RegExp; task: string; risk: ExploreTask['risk'] }> = [
  { feature: 'navigation', re: /\b(home|tab|menu|back|next|details|open|view|dashboard|overview)\b/i, task: 'Exercise primary navigation', risk: 'safe' },
  { feature: 'auth', re: /\b(sign in|log in|login|password|email|account|register|create account)\b/i, task: 'Reach and validate authentication', risk: 'unknown' },
  { feature: 'search', re: /\b(search|filter|sort|find)\b/i, task: 'Search or filter content', risk: 'safe' },
  { feature: 'create', re: /\b(add|new|create|compose|upload)\b/i, task: 'Create a new record', risk: 'unknown' },
  { feature: 'edit', re: /\b(edit|update|rename|change|save)\b/i, task: 'Edit an existing record', risk: 'unknown' },
  { feature: 'delete', re: /\b(delete|remove|clear|wipe|discard)\b/i, task: 'Discover delete flow without executing it', risk: 'destructive' },
  { feature: 'share/send', re: /\b(share|send|invite|message|email)\b/i, task: 'Discover share or send flow without external side effects', risk: 'destructive' },
  { feature: 'settings', re: /\b(settings|preferences|privacy|permissions)\b/i, task: 'Inspect settings', risk: 'safe' },
  { feature: 'media', re: /\b(photo|camera|image|video|gallery|media)\b/i, task: 'Exercise media surface', risk: 'unknown' },
  { feature: 'map/location', re: /\b(map|location|nearby|route|gps|address)\b/i, task: 'Exercise map or location surface', risk: 'unknown' },
  { feature: 'purchase', re: /\b(pay|buy|purchase|checkout|subscribe|order)\b/i, task: 'Discover purchase flow without executing it', risk: 'destructive' },
  { feature: 'profile', re: /\b(profile|account|avatar|bio|name)\b/i, task: 'Inspect profile workflow', risk: 'safe' },
  { feature: 'notifications', re: /\b(notification|alert|bell|push)\b/i, task: 'Inspect notification workflow', risk: 'safe' },
];

export const FEATURE_KEYS = FEATURE_RULES.map((r) => r.feature);

export function inferAppDomain(input: { packageId?: string; goal?: string; screenText: string; fixtures: string[] }): { domain: string; evidence: string[] } {
  const hay = `${input.packageId ?? ''} ${input.goal ?? ''} ${input.screenText} ${input.fixtures.join(' ')}`.toLowerCase();
  const matches: Array<[string, RegExp]> = [
    ['commerce', /\b(cart|checkout|order|price|product|shop|store)\b/],
    ['messaging', /\b(chat|message|inbox|send|recipient)\b/],
    ['travel', /\b(flight|booking|trip|hotel|map|route)\b/],
    ['content', /\b(feed|post|article|media|video|photo)\b/],
    ['productivity', /\b(note|task|todo|calendar|document)\b/],
  ];
  const found = matches.find(([, re]) => re.test(hay));
  return { domain: found?.[0] ?? 'general_mobile_app', evidence: [input.packageId, input.goal].filter((x): x is string => !!x) };
}

export function proposeTasks(input: { packageId?: string; goal?: string; screenText: string; fixtures: string[]; candidates: RankedCandidate[] }): ExploreTask[] {
  const hay = `${input.goal ?? ''} ${input.screenText} ${input.candidates.map((c) => `${c.label ?? ''} ${c.locator?.value ?? ''}`).join(' ')}`;
  const tasks: ExploreTask[] = [];
  for (const rule of FEATURE_RULES) {
    if (!rule.re.test(hay)) continue;
    const preconditions: string[] = [];
    if (rule.feature === 'auth' && !input.fixtures.some((f) => /account|login|auth|credential/i.test(f))) preconditions.push('test account credentials');
    if (rule.risk === 'destructive') preconditions.push('disposable test state');
    tasks.push({
      id: `task-${tasks.length + 1}`,
      title: rule.task,
      feature: rule.feature,
      preconditions,
      risk: rule.risk,
      status: rule.risk === 'destructive' ? 'unsafe' : preconditions.length ? 'blocked' : 'proposed',
    });
  }
  if (!tasks.length) {
    tasks.push({ id: 'task-1', title: input.goal || 'Explore primary reachable workflow', feature: 'navigation', preconditions: [], risk: 'safe', status: 'proposed' });
  }
  return tasks;
}

export function estimateFeatureCoverage(nodes: ScreenNode[], tasks: ExploreTask[]): Record<FeatureKey, FeatureStatus> {
  const text = nodes
    .flatMap((n) => [n.title, ...n.elements.flatMap((e) => [e.label, e.locator?.value, e.reason])])
    .filter(Boolean)
    .join(' ');
  const out = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 'not_found'])) as Record<FeatureKey, FeatureStatus>;
  for (const rule of FEATURE_RULES) {
    if (rule.re.test(text)) out[rule.feature] = rule.risk === 'destructive' ? 'unsafe' : 'covered';
  }
  for (const task of tasks) {
    if (task.status === 'blocked') out[task.feature] = task.preconditions.some((p) => /fixture|account|credential|state/i.test(p)) ? 'needs_fixture' : 'blocked';
    if (task.status === 'unsafe') out[task.feature] = 'unsafe';
    if (task.status === 'completed') out[task.feature] = 'covered';
  }
  return out;
}

export function coverageClaimsFrom(features: Record<FeatureKey, FeatureStatus>, nodes: ScreenNode[]): CoverageClaim[] {
  return FEATURE_KEYS.map((feature) => {
    const status = features[feature];
    const evidence = nodes
      .filter((n) => n.elements.some((e) => `${e.label ?? ''} ${e.locator?.value ?? ''}`.toLowerCase().includes(feature.split('/')[0].split('-')[0])))
      .map((n) => n.id);
    return {
      feature,
      status,
      evidence,
      reason: status === 'covered' ? 'reachable UI evidence was observed' : status === 'unsafe' ? 'only high-impact controls were found' : status === 'needs_fixture' ? 'requires declared test data or disposable state' : 'no strong feature signal observed',
    };
  });
}

export function reflectExploration(nodes: ScreenNode[], sameScreenEdges: number, reasons: string[]): ReflectionResult {
  const low = nodes.filter((n) => n.locatorQuality && ['C', 'D'].includes(n.locatorQuality.grade)).map((n) => n.id);
  const shallowLoops = nodes.filter((n) => n.visits >= 3).map((n) => n.id);
  const suiteReadiness = nodes.length > 1 && low.length === 0 ? 'candidate' : nodes.length > 1 ? 'rejected' : 'none';
  return {
    shallowLoops,
    repeatedSameScreenActions: sameScreenEdges,
    lowLocatorReadinessScreens: low,
    suiteReadiness,
    promotedPathCandidate: suiteReadiness === 'candidate' ? `${nodes[0]?.id ?? 's1'} -> ${nodes[nodes.length - 1]?.id ?? 's1'}` : undefined,
    reasons: [
      ...reasons,
      low.length ? `${low.length} screen(s) need better locators before CI promotion` : 'locator readiness is acceptable for candidate suite promotion',
      sameScreenEdges ? `${sameScreenEdges} action(s) did not change screen state` : 'no repeated same-screen action loop detected',
    ],
  };
}
