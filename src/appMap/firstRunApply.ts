// SWIPIUM-REQ-02 / REQ-01 Fix Group 5 — apply first-run classifications to the durable app map.
// runFirstRun() emits AppMapPatch[] (per-screen purpose + auth/onboarding/paywall signals + observed
// transitions). Historically these were written ONLY as a detached session artifact. This module
// folds them into AppKnowledgeMap so a runtime login/onboarding/paywall screen durably updates the
// map's runtime topology + auth/onboarding/paywall models + provenance. PURE (mutates the passed map).

import type { AppKnowledgeMap, RuntimeScreen, FlowModel } from './schema.js';
import type { AppMapPatch } from '../firstRun/types.js';
import { addProvenance, makeProvenance } from './provenance.js';
import { computeUnvisitedStaticScreens } from './runtimeMerge.js';

const AUTH_PURPOSES = new Set(['login', 'create_account', 'login_or_create_account', 'otp_or_email_verification']);

export interface FirstRunApplyResult {
  updatedScreens: number;
  newScreens: number;
  authUpdated: boolean;
  onboardingUpdated: boolean;
  paywallUpdated: boolean;
}

function findScreenBySignature(map: AppKnowledgeMap, sig?: string): RuntimeScreen | undefined {
  if (!sig) return undefined;
  return map.runtimeTopology.screens.find((s) => s.signature === sig || s.uiSignature === sig || s.visualSignature === sig);
}

function defaultPlatform(map: AppKnowledgeMap): 'android' | 'ios' {
  if (map.project.platforms.length === 1) return map.project.platforms[0];
  return map.runtimeTopology.screens[0]?.platform ?? 'android';
}

function upsertPaywall(map: AppKnowledgeMap, screenId: string, confidence: number): void {
  let pw = map.paywalls.find((f) => f.kind === 'paywall');
  if (!pw) {
    pw = { id: 'paywall', kind: 'paywall', present: true, signals: [], libraries: [], screens: [], confidence: 0 } as FlowModel;
    map.paywalls.push(pw);
  }
  pw.present = true;
  pw.signals = [...new Set([...pw.signals, 'runtime_first_run'])];
  if (!pw.screens.includes(screenId)) pw.screens.push(screenId);
  pw.confidence = Math.max(pw.confidence, confidence);
}

/** Fold first-run classifications into the map's runtime topology + auth/onboarding/paywall models. */
export function applyFirstRunPatches(map: AppKnowledgeMap, patches: AppMapPatch[], at: string): FirstRunApplyResult {
  const res: FirstRunApplyResult = {
    updatedScreens: 0,
    newScreens: 0,
    authUpdated: false,
    onboardingUpdated: false,
    paywallUpdated: false,
  };
  const platform = defaultPlatform(map);

  // Resolve the strongest static-screen link from a patch (Vision Gap Fix 2) against ids that actually
  // exist in the static topology, so a runtime auth/onboarding screen durably links to its static id.
  const staticIds = new Set(map.staticTopology.screens.map((s) => s.id));
  const staticLinkOf = (p: AppMapPatch): { id: string; confidence: number } | undefined => {
    const links = (p.links ?? []).filter((l) => l.kind === 'staticScreen' && staticIds.has(l.id));
    if (!links.length) return undefined;
    return links.reduce((best, l) => (l.confidence > best.confidence ? l : best), links[0]);
  };

  for (const p of patches) {
    const staticLink = staticLinkOf(p);
    let screen = findScreenBySignature(map, p.screenSignature);
    if (screen) {
      screen.purpose = p.purpose;
      if (p.authState) screen.authState = p.authState;
      screen.lastSeen = at;
      screen.lastArtifactUris = [...new Set([...(p.evidence ?? []), ...screen.lastArtifactUris])].slice(0, 10);
      if (staticLink) {
        screen.linkedStaticScreenId = staticLink.id;
        screen.linkConfidence = Math.max(screen.linkConfidence ?? 0, staticLink.confidence);
        screen.unmapped = false;
      }
      res.updatedScreens++;
    } else {
      screen = {
        id: `r${map.runtimeTopology.screens.length + 1}`,
        signature: p.screenSignature,
        platform,
        purpose: p.purpose,
        authState: p.authState,
        lastArtifactUris: (p.evidence ?? []).slice(0, 10),
        locatorReadiness: 'unknown',
        firstSeen: at,
        lastSeen: at,
        visits: 1,
        ...(staticLink
          ? { linkedStaticScreenId: staticLink.id, linkConfidence: staticLink.confidence, unmapped: false }
          : { unmapped: true }),
      };
      map.runtimeTopology.screens.push(screen);
      res.newScreens++;
    }

    if (AUTH_PURPOSES.has(p.purpose)) {
      map.auth.hasAuth = true;
      map.auth.loginScreenSeen = true;
      if (!map.auth.screens.includes(screen.id)) map.auth.screens.push(screen.id);
      // Link the static screen too (Fix 2): the auth model lists both the runtime and static screen.
      if (staticLink && !map.auth.screens.includes(staticLink.id)) map.auth.screens.push(staticLink.id);
      map.auth.signals = [...new Set([...map.auth.signals, 'runtime_first_run'])];
      map.auth.confidence = Math.max(map.auth.confidence, p.confidence);
      res.authUpdated = true;
    } else if (p.purpose === 'onboarding') {
      const ob: FlowModel = map.onboarding ?? {
        id: 'onboarding',
        kind: 'onboarding',
        present: false,
        signals: [],
        libraries: [],
        screens: [],
        confidence: 0,
      };
      ob.present = true;
      ob.signals = [...new Set([...ob.signals, 'runtime_first_run'])];
      if (!ob.screens.includes(screen.id)) ob.screens.push(screen.id);
      ob.confidence = Math.max(ob.confidence, p.confidence);
      map.onboarding = ob;
      res.onboardingUpdated = true;
    } else if (p.purpose === 'paywall') {
      upsertPaywall(map, screen.id, p.confidence);
      res.paywallUpdated = true;
    }
  }

  // Observed transitions → runtime edges (best-effort; only when both endpoints resolve).
  for (const p of patches) {
    const fromSig = p.transition?.fromSignature;
    if (!fromSig) continue;
    const from = findScreenBySignature(map, fromSig);
    const to = findScreenBySignature(map, p.screenSignature);
    if (!from || !to) continue;
    const exists = map.runtimeTopology.edges.find((e) => e.from === from.id && e.to === to.id && e.action.type === 'first_run_step');
    if (!exists) {
      map.runtimeTopology.edges.push({
        from: from.id,
        to: to.id,
        action: { type: 'first_run_step', targetDescription: p.purpose },
        outcome: p.transition?.outcome ?? 'changed_screen',
        evidenceUris: (p.evidence ?? []).slice(0, 5),
        observedCount: 1,
      });
    }
  }

  map.runtimeTopology.unvisitedStaticScreens = computeUnvisitedStaticScreens(map);
  if (patches.length) {
    addProvenance(
      map,
      makeProvenance('runtime', at, `First-run classifications: ${[...new Set(patches.map((p) => p.purpose))].slice(0, 6).join(', ')}`, {
        targetType: 'map',
      }),
    );
  }
  return res;
}
