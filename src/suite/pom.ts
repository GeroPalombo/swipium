// Screen/Page Object Model generation (roadmap §6) — turn a linear action recording into a
// MAINTAINABLE suite where selectors live in page objects and tests reference them by name,
// instead of duplicating raw selectors. PURE: no filesystem, no device — callers serialize the
// returned files. Also produces a locator audit (durable vs brittle) with app-code remediation,
// because durable automation is the point (§2.4 / §6 locator policy).

import { stringify } from 'yaml';
import type { RecordedAction } from '../session/store.js';

export type Durability = 'durable' | 'semi' | 'brittle';
export type LocatorAuditCode = 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER' | 'COORDINATE_ONLY';

export interface PomElement {
  name: string;
  selector?: string;
  selectorKind: string;
  fallbackText?: string;
  coords?: [number, number];
  required: boolean;
  secure?: boolean;
  durability: Durability;
  readinessCode?: LocatorAuditCode;
  /** App-code change that would make this element durably testable (§6 locator policy). */
  remediation?: string;
}

export interface PomPage {
  name: string;
  screen?: string; // source foreground owner
  elements: PomElement[];
}

export interface PomTestStep {
  page: string;
  element?: string;
  action: 'tap' | 'inputText' | 'press' | 'swipe' | 'scrollTo' | 'openUrl' | 'assertVisible';
  text?: string;
  secret?: boolean;
  key?: string;
  direction?: string;
  url?: string;
  coords?: [number, number];
}

export interface LocatorAuditEntry {
  page: string;
  element: string;
  durability: Durability;
  selectorKind: string;
  code?: LocatorAuditCode;
  remediation?: string;
}

export interface GeneratedFile {
  path: string; // relative to .swipium/
  content: string;
}

export interface PomResult {
  pages: PomPage[];
  testName: string;
  steps: PomTestStep[];
  variables: string[];
  audit: { entries: LocatorAuditEntry[]; durable: number; semi: number; brittle: number; brittlePct: number };
  files: GeneratedFile[];
}

function durabilityOf(kind?: string): Durability {
  switch (kind) {
    case 'accessibility_id':
    case 'resource_id':
      return 'durable';
    case 'name':
    case 'predicate':
    case 'class_chain':
    case 'text':
      return 'semi';
    default:
      return 'brittle'; // coords / unknown
  }
}

function pascal(s: string): string {
  const parts = s
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('') || 'Screen';
}

function camel(s: string): string {
  const p = pascal(s);
  return p ? p[0].toLowerCase() + p.slice(1) : 'el';
}

/** Page name from a foreground-owner string: strip android package, take a readable segment. */
function pageNameFromScreen(screen: string | undefined, index: number): string {
  if (!screen) return `Screen${index + 1}Page`;
  // android: com.app/.LoginActivity → LoginActivity → LoginPage
  const activity = screen.includes('/') ? screen.split('/').pop()! : screen.split('.').pop()!;
  const base = activity.replace(/Activity$|ViewController$|Screen$/i, '');
  return `${pascal(base || activity)}Page`;
}

/** Derive a meaningful secret variable name (P0.5) — reuses an existing ${VAR} the agent set,
 *  else names from the field (password/otp/token), else a numbered SWIPIUM_SECRET_N. */
function secretVarFor(a: { text?: string; selector?: string }, index: number): string {
  const existing = a.text?.match(/^\$\{([^}]+)\}$/);
  // Reuse an already-meaningful var; but rename a generic recorder placeholder (SECRET_N).
  if (existing && !/^SECRET_\d+$/i.test(existing[1])) return existing[1];
  const key = `${a.selector ?? ''}`.toLowerCase();
  if (/pass/.test(key)) return 'SWIPIUM_TEST_PASSWORD';
  if (/otp|code|2fa|mfa/.test(key)) return 'SWIPIUM_TEST_OTP';
  if (/token|api[_-]?key/.test(key)) return 'SWIPIUM_TEST_TOKEN';
  if (/pin/.test(key)) return 'SWIPIUM_TEST_PIN';
  return `SWIPIUM_SECRET_${index}`;
}

function remediationFor(el: { selectorKind: string; selector?: string; screen?: string }): string | undefined {
  if (el.selectorKind === 'coords') {
    return `add a testID (RN) / accessibilityIdentifier (iOS) / android:contentDescription / Flutter Key + Semantics(identifier:) to the tapped element${el.screen ? ` on ${el.screen}` : ''} — it has no durable locator`;
  }
  if (el.selectorKind === 'text') {
    return `text selector "${el.selector}" is locale/copy-fragile — add an accessibilityIdentifier/testID (or a Flutter Key/Semantics label) for CI-stable replay`;
  }
  if (el.selectorKind === 'name') {
    return `iOS name selector "${el.selector}" can drift with labels/localization — add an accessibilityIdentifier for CI-stable replay`;
  }
  if (el.selectorKind === 'predicate' || el.selectorKind === 'class_chain') {
    return `iOS ${el.selectorKind} selector "${el.selector}" is a fallback locator — prefer accessibilityIdentifier and avoid XPath-style hierarchy dependence`;
  }
  return undefined;
}

function auditCodeFor(el: { selectorKind: string }): LocatorAuditCode | undefined {
  if (el.selectorKind === 'coords') return 'COORDINATE_ONLY';
  if (el.selectorKind === 'text' || el.selectorKind === 'name' || el.selectorKind === 'predicate' || el.selectorKind === 'class_chain') return 'IOS_MISSING_ACCESSIBILITY_IDENTIFIER';
  return undefined;
}

/**
 * Build the POM model + serialized files from a recording.
 *  - segments the recording into pages by screen (foreground owner);
 *  - hoists each distinct selector into a named page element (de-duped);
 *  - emits a test that references `page` + `element` (no raw selectors in the test);
 *  - turns secrets into ${VARS};
 *  - audits every locator's durability with app-code remediation.
 */
export function generatePom(
  actions: RecordedAction[],
  opts: { name: string; appId?: string; budgetProfile?: string },
): PomResult {
  // 1. segment into pages by contiguous screen.
  const pages: PomPage[] = [];
  const usedPageNames = new Set<string>();
  const pageByScreen = new Map<string, PomPage>();

  const pageFor = (screen: string | undefined): PomPage => {
    const key = screen ?? '__unknown__';
    const existing = pageByScreen.get(key);
    if (existing) return existing;
    let name = pageNameFromScreen(screen, pages.length);
    let n = 2;
    const baseName = name;
    while (usedPageNames.has(name)) name = `${baseName.replace(/Page$/, '')}${n++}Page`;
    usedPageNames.add(name);
    const page: PomPage = { name, screen, elements: [] };
    pages.push(page);
    pageByScreen.set(key, page);
    return page;
  };

  const steps: PomTestStep[] = [];
  const variables: string[] = [];
  let secretCount = 0;

  const ensureElement = (page: PomPage, a: RecordedAction): string | undefined => {
    // Coordinate-only actions have no nameable element — keep as inline coords in the step.
    if (!a.selector || a.selectorKind === 'coords') return undefined;
    const baseName = camel(a.selector);
    let name = baseName || 'el';
    // Reuse if an element with the same selector already exists on this page.
    const match = page.elements.find((e) => e.selector === a.selector && e.selectorKind === a.selectorKind);
    if (match) return match.name;
    let n = 2;
    while (page.elements.some((e) => e.name === name)) name = `${baseName}${n++}`;
    const durability = durabilityOf(a.selectorKind);
    const readinessCode = auditCodeFor({ selectorKind: a.selectorKind ?? 'text' });
    const el: PomElement = {
      name,
      selector: a.selector,
      selectorKind: a.selectorKind ?? 'text',
      fallbackText: a.selectorKind === 'text' ? a.selector : undefined,
      required: true,
      secure: a.secret || undefined,
      durability,
      readinessCode,
      remediation: remediationFor({ selectorKind: a.selectorKind ?? 'text', selector: a.selector, screen: a.screen }),
    };
    page.elements.push(el);
    return name;
  };

  for (const a of actions) {
    const page = pageFor(a.screen);
    switch (a.action) {
      case 'tap':
      case 'clear': {
        const element = ensureElement(page, a);
        if (element) steps.push({ page: page.name, element, action: a.action === 'clear' ? 'inputText' : 'tap', ...(a.action === 'clear' ? { text: '' } : {}) });
        else steps.push({ page: page.name, action: 'tap', coords: [a.x ?? 0, a.y ?? 0] });
        break;
      }
      case 'type': {
        const element = ensureElement(page, a);
        let text = a.text ?? '';
        if (a.secret) {
          // Secret values become ${SWIPIUM_TEST_*} variables — never the raw value (P0.5).
          const v = secretVarFor(a, ++secretCount);
          text = `\${${v}}`;
          variables.push(v);
        } else {
          // A non-secret value the agent already templated (e.g. ${SWIPIUM_TEST_EMAIL}) is preserved.
          for (const m of text.matchAll(/\$\{([^}]+)\}/g)) variables.push(m[1]);
        }
        steps.push({ page: page.name, element, action: 'inputText', text, secret: a.secret || undefined });
        break;
      }
      case 'press':
        steps.push({ page: page.name, action: 'press', key: a.key ?? 'back' });
        break;
      case 'swipe':
        steps.push({ page: page.name, action: 'swipe', direction: a.direction ?? 'up' });
        break;
      case 'scroll': {
        const element = ensureElement(page, a);
        if (element) steps.push({ page: page.name, element, action: 'scrollTo' });
        else steps.push({ page: page.name, action: 'swipe', direction: a.direction ?? 'up' });
        break;
      }
      case 'open_url':
        steps.push({ page: page.name, action: 'openUrl', url: a.url ?? '' });
        break;
      case 'assert_visual':
        steps.push({ page: page.name, action: 'assertVisible', text: a.assertion ?? a.selector });
        break;
    }
  }

  // 2. audit.
  const entries: LocatorAuditEntry[] = [];
  for (const p of pages) {
    for (const e of p.elements) {
      entries.push({ page: p.name, element: e.name, durability: e.durability, selectorKind: e.selectorKind, code: e.readinessCode, remediation: e.remediation });
    }
  }
  // coordinate-only steps also count against durability.
  for (const s of steps) {
    if (!s.element && s.coords) entries.push({ page: s.page, element: `(coords ${s.coords[0]},${s.coords[1]})`, durability: 'brittle', selectorKind: 'coords', code: 'COORDINATE_ONLY', remediation: remediationFor({ selectorKind: 'coords' }) });
  }
  const durable = entries.filter((e) => e.durability === 'durable').length;
  const semi = entries.filter((e) => e.durability === 'semi').length;
  const brittle = entries.filter((e) => e.durability === 'brittle').length;
  const total = entries.length || 1;
  const audit = { entries, durable, semi, brittle, brittlePct: Math.round((brittle / total) * 100) };

  // 3. serialize files.
  const files: GeneratedFile[] = [];
  for (const p of pages) {
    const elementsYaml: Record<string, unknown> = {};
    for (const e of p.elements) {
      const ev: Record<string, unknown> = {};
      if (e.selectorKind === 'accessibility_id') ev['accessibility id'] = e.selector;
      else if (e.selectorKind === 'resource_id') ev['resource-id'] = e.selector;
      else if (e.selectorKind === 'text') ev.text = e.selector;
      else ev[e.selectorKind] = e.selector;
      if (e.fallbackText && e.selectorKind !== 'text') ev.fallbackText = e.fallbackText;
      if (e.required) ev.required = true;
      if (e.secure) ev.secure = true;
      ev.durability = e.durability;
      if (e.readinessCode) ev.readinessCode = e.readinessCode;
      if (e.remediation) ev.remediation = e.remediation;
      elementsYaml[e.name] = ev;
    }
    const pageObj = { name: p.name, platforms: ['android', 'ios'], screen: p.screen ?? undefined, elements: elementsYaml };
    files.push({ path: `pages/${kebab(p.name)}.page.yaml`, content: `# Swipium page object — review before committing.\n${stringify(pageObj)}` });
  }

  const testObj: Record<string, unknown> = { name: opts.name };
  if (opts.appId) testObj.appId = opts.appId;
  if (opts.budgetProfile) testObj.budgetProfile = opts.budgetProfile;
  testObj.uses = pages.map((p) => `pages/${kebab(p.name)}.page.yaml`);
  testObj.steps = steps.map(serializeStep);
  const testHeader = [
    '# Swipium test (POM) — selectors live in page objects; this test references them by name.',
    ...(variables.length ? [`# variables — provide via qa_flow_run { variables }: ${variables.join(', ')}`] : []),
    `# locator durability: ${durable} durable / ${semi} semi / ${brittle} brittle (${audit.brittlePct}% brittle)`,
  ].join('\n');
  files.push({ path: `tests/${kebab(opts.name)}.smoke.yaml`, content: `${testHeader}\n${stringify(testObj)}` });

  const suiteObj = { name: 'smoke', tests: [`tests/${kebab(opts.name)}.smoke.yaml`] };
  files.push({ path: 'suites/smoke.yaml', content: `# Swipium suite.\n${stringify(suiteObj)}` });

  files.push({ path: 'locators/locator-audit.json', content: JSON.stringify(audit, null, 2) });

  return { pages, testName: opts.name, steps, variables: [...new Set(variables)], audit, files };
}

function serializeStep(s: PomTestStep): Record<string, unknown> {
  const ref = s.element ? { page: s.page, element: s.element } : { page: s.page };
  switch (s.action) {
    case 'tap':
      return s.element ? { ...ref, action: 'tap' } : { ...ref, action: 'tapAt', coords: s.coords };
    case 'inputText':
      return { ...ref, action: 'inputText', text: s.text ?? '', ...(s.secret ? { secret: true } : {}) };
    case 'press':
      return { ...ref, action: 'press', key: s.key };
    case 'swipe':
      return { ...ref, action: 'swipe', direction: s.direction };
    case 'scrollTo':
      return { ...ref, action: 'scrollTo' };
    case 'openUrl':
      return { ...ref, action: 'openUrl', url: s.url };
    case 'assertVisible':
      return { ...ref, action: 'assertVisible', text: s.text };
  }
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
