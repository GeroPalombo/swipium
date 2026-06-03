// Query normalization + synonym expansion (SWIPIUM-REQ-03 "Query and Ranking Requirements").
// Deterministic, English-leaning v1 (Non-Goals: schema allows locale/synonym expansion later).
// A feature request like "weather analysis feature" expands to the broader vocabulary the code
// might actually use ("forecast", "temperature", "radar", …) so static/runtime matches are found.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'feature', 'features', 'flow', 'flows',
  'screen', 'screens', 'page', 'pages', 'test', 'testing', 'tests', 'my', 'app', 'this', 'with', 'that',
  'functionality', 'function', 'section', 'module', 'workflow',
]);

// Bidirectional-ish synonym groups: any term in a group expands to the whole group. Kept small and
// high-signal; the index's own token splitting handles the rest.
const SYNONYM_GROUPS: string[][] = [
  ['weather', 'forecast', 'climate', 'temperature', 'radar', 'precipitation', 'wind', 'humidity', 'meteo'],
  ['analysis', 'analytics', 'analyze', 'insight', 'insights', 'report', 'stats', 'statistics'],
  ['alert', 'alerts', 'notification', 'notifications', 'warning', 'warnings'],
  ['auth', 'login', 'signin', 'logon', 'authentication', 'credentials', 'password', 'account'],
  ['signup', 'register', 'registration', 'onboarding', 'enroll'],
  ['search', 'find', 'filter', 'query', 'lookup', 'browse'],
  ['checkout', 'payment', 'purchase', 'pay', 'billing', 'cart', 'order', 'subscription', 'subscribe'],
  ['profile', 'account', 'settings', 'preferences', 'avatar'],
  ['map', 'location', 'geolocation', 'gps', 'nearby', 'route', 'navigation'],
  ['chat', 'message', 'messaging', 'inbox', 'conversation', 'thread'],
  ['media', 'photo', 'image', 'camera', 'video', 'gallery', 'upload'],
  ['feed', 'timeline', 'post', 'posts', 'article', 'content'],
  ['favorite', 'favorites', 'bookmark', 'saved', 'wishlist', 'like'],
  ['delete', 'remove', 'destroy', 'clear', 'discard'],
  ['share', 'send', 'invite', 'export'],
];

const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const idx = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const set = new Set(group);
    for (const term of group) idx.set(term, set);
  }
  return idx;
})();

export interface NormalizedQuery {
  raw: string;
  /** Salient terms typed by the user (stopwords removed). These drive title + cluster naming. */
  coreTerms: string[];
  /** coreTerms ∪ synonym expansions — the full search vocabulary. */
  expandedTerms: string[];
}

function splitTerms(query: string): string[] {
  return query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/** Normalize a feature request into core terms + a synonym-expanded search vocabulary. */
export function normalizeQuery(query: string): NormalizedQuery {
  const core: string[] = [];
  const seenCore = new Set<string>();
  for (const t of splitTerms(query)) {
    if (STOPWORDS.has(t) || seenCore.has(t)) continue;
    seenCore.add(t);
    core.push(t);
  }
  // Fall back to the raw split if every term was a stopword (e.g. "settings" alone is fine, but
  // "the app" should still yield something to search on).
  const coreTerms = core.length ? core : splitTerms(query).filter((t) => !seenCore.has(t));
  const expanded = new Set<string>(coreTerms);
  for (const t of coreTerms) {
    const group = SYNONYM_INDEX.get(t);
    if (group) for (const s of group) expanded.add(s);
  }
  return { raw: query, coreTerms, expandedTerms: [...expanded] };
}

/** Are two term sets about genuinely different features (no shared core term)? Drives disambiguation. */
export function termsAreUnrelated(a: string[], b: string[]): boolean {
  const sb = new Set(b);
  return !a.some((t) => sb.has(t));
}
