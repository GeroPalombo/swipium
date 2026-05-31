// Vision Gap Fix 2 — match a runtime observation to likely STATIC screens from the durable app map,
// so first-run classification validates the live screen against code/app-map context instead of from
// runtime UI alone. Pure: scores each static screen against the observation's foreground owner, route/
// name tokens, visible text, source-file names, and the map's known auth/onboarding/paywall models,
// then emits StaticScreenCandidate[] (id + inferred purpose + match hints) for classifyCurrentScreen().

import type { AppKnowledgeMap, StaticScreen } from './schema.js';
import type { StaticScreenCandidate } from '../firstRun/classifyScreen.js';
import type { ScreenPurpose } from '../firstRun/types.js';

export interface ObservationLike {
  foreground: string;
  visibleText: string;
  route?: string;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3);
}

/** Map a static screen to a first-run purpose using the app map's auth/onboarding/paywall models. */
function purposeForStaticScreen(map: AppKnowledgeMap, screen: StaticScreen): ScreenPurpose | undefined {
  if (map.auth?.screens?.includes(screen.id)) {
    return /create|register|sign\s?up/i.test(`${screen.name} ${screen.route ?? ''}`) ? 'create_account' : 'login';
  }
  if (map.onboarding?.screens?.includes(screen.id)) return 'onboarding';
  if (map.paywalls?.some((p) => p.screens.includes(screen.id))) return 'paywall';
  const hay = `${screen.name} ${screen.route ?? ''} ${screen.sourceFiles.join(' ')}`;
  if (/login|signin|sign-in/i.test(hay)) return 'login';
  if (/register|signup|sign-up|create.?account/i.test(hay)) return 'create_account';
  if (/onboard|welcome|intro|tour|getstarted/i.test(hay)) return 'onboarding';
  if (/paywall|subscribe|subscription|upgrade|premium/i.test(hay)) return 'paywall';
  if (/permission/i.test(hay)) return 'permissions_prompt';
  if (/\b(home|feed|dashboard|main|tabs?)\b/i.test(hay)) return 'home';
  return undefined;
}

interface ScoredCandidate {
  screen: StaticScreen;
  score: number;
  hints: string[];
}

/**
 * Rank likely static screens for a runtime observation. Returns the strongest candidates with an
 * inferred purpose and the visible-text hints that match (so the classifier weights corroboration).
 */
export function staticCandidatesForObservation(map: AppKnowledgeMap, obs: ObservationLike, limit = 4): StaticScreenCandidate[] {
  const screens = map.staticTopology?.screens ?? [];
  if (!screens.length) return [];
  const textTokens = new Set(tokenize(obs.visibleText));
  const fgTokens = new Set([...tokenize(obs.foreground), ...tokenize(obs.route ?? '')]);

  const scored: ScoredCandidate[] = [];
  for (const screen of screens) {
    const nameTokens = new Set([...tokenize(screen.name), ...tokenize(screen.route ?? ''), ...screen.sourceFiles.flatMap((f) => tokenize(f))]);
    let score = 0;
    const hints: string[] = [];
    // Foreground owner / activity / view controller match (strong signal).
    for (const t of fgTokens) if (nameTokens.has(t)) { score += 2; hints.push(t); }
    // Visible-text token overlap with the screen name/route (weaker corroboration).
    for (const t of nameTokens) if (textTokens.has(t)) { score += 1; if (!hints.includes(t)) hints.push(t); }
    // The map already knows this screen is an auth/onboarding/paywall gate.
    const purpose = purposeForStaticScreen(map, screen);
    if (purpose && (score > 0 || screens.length <= 3)) score += 0.5;
    if (score > 0) scored.push({ screen, score, hints: hints.slice(0, 6) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({
    id: s.screen.id,
    purpose: purposeForStaticScreen(map, s.screen),
    hints: s.hints.length ? s.hints : [s.screen.name, ...(s.screen.route ? [s.screen.route] : [])].filter(Boolean),
  }));
}
