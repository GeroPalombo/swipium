import type { Fixture, Session } from '../session/store.js';

export type FixtureGenerator = 'email' | 'person_name' | 'number' | 'text' | 'city' | 'country' | 'color' | 'phone' | 'date';
export type FixtureGeneratorInput =
  | FixtureGenerator
  | 'email_address'
  | 'person'
  | 'full_name'
  | 'display_name'
  | 'city_name'
  | 'country_name'
  | 'phone_number'
  | 'mobile'
  | 'numeric'
  | 'date_iso';

export interface ResolvedFixtureValue {
  value: string;
  varName: string;
  secret: boolean;
  fixture: string;
  field: string;
  source: 'variable' | 'value' | 'generator' | 'legacy_value';
  generator?: FixtureGenerator;
}

export interface FixtureMatchContext {
  role?: string;
  inputType?: string;
  placeholder?: string;
  nearbyText?: string;
}

interface FixtureFieldSpec {
  value?: string;
  var?: string;
  secret?: boolean;
  generator?: string;
  role?: string;
  inputType?: string;
}

const GENERATORS: Record<FixtureGenerator, () => string> = {
  email: () => `swipium.qa.${Date.now()}@example.test`,
  person_name: () => 'Swipium QA User',
  number: () => '42',
  text: () => 'Swipium test value',
  city: () => 'Test City',
  country: () => 'Testland',
  color: () => 'Blue',
  phone: () => '+15550101000',
  date: () => '2026-01-15',
};

const GENERATOR_ALIASES: Record<string, FixtureGenerator> = {
  email: 'email',
  email_address: 'email',
  person: 'person_name',
  person_name: 'person_name',
  full_name: 'person_name',
  display_name: 'person_name',
  number: 'number',
  numeric: 'number',
  text: 'text',
  city: 'city',
  city_name: 'city',
  country: 'country',
  country_name: 'country',
  color: 'color',
  phone: 'phone',
  phone_number: 'phone',
  mobile: 'phone',
  date: 'date',
  date_iso: 'date',
};

const FIELD_HINTS: Array<{ field: string; re: RegExp }> = [
  { field: 'email', re: /\b(email|user(name)?|login|account)\b/i },
  { field: 'password', re: /\b(pass(word)?|secret)\b/i },
  { field: 'otp', re: /\b(otp|code|2fa|mfa)\b/i },
  { field: 'display_name', re: /\b(display\s*name|full\s*name|name)\b/i },
  { field: 'first_name', re: /\b(first\s*name|given\s*name)\b/i },
  { field: 'last_name', re: /\b(last\s*name|family\s*name|surname)\b/i },
  { field: 'city', re: /\bcity\b/i },
  { field: 'country', re: /\bcountry\b/i },
  { field: 'phone', re: /\b(phone|mobile|tel)\b/i },
  { field: 'date', re: /\b(date|birthday|dob)\b/i },
  { field: 'search', re: /\b(search|query|find|filter)\b/i },
];

function variableName(fixture: string, field: string): string {
  return `SWIPIUM_${fixture}_${field}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function fixtureFields(f: Fixture): Record<string, FixtureFieldSpec> {
  if (!f.fields || typeof f.fields !== 'object') return {};
  return f.fields as Record<string, FixtureFieldSpec>;
}

function normalizeText(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeGenerator(value?: string): FixtureGenerator | undefined {
  if (!value) return undefined;
  return GENERATOR_ALIASES[value.trim().toLowerCase().replace(/[-\s]+/g, '_')];
}

function fieldScore(fieldName: string, spec: FixtureFieldSpec, key: string, context: FixtureMatchContext = {}): number {
  const normalizedField = normalizeText(fieldName);
  const tokens = normalizedField.split(' ').filter(Boolean);
  let score = normalizedField && key.includes(normalizedField) ? 30 : 0;
  if (!score && tokens.length > 1 && tokens.every((token) => key.includes(token))) score += 20;
  const hint = FIELD_HINTS.find((h) => h.field === fieldName || h.re.test(fieldName));
  if (hint?.re.test(key)) score += 50;
  if (spec.role) {
    const role = normalizeText(context.role);
    const wanted = normalizeText(spec.role);
    if (wanted && ((role && (role.includes(wanted) || wanted.includes(role))) || key.includes(wanted))) score += 35;
  }
  if (spec.inputType) {
    const wanted = normalizeText(spec.inputType);
    const inputType = normalizeText(context.inputType);
    const role = normalizeText(context.role);
    if (wanted && (inputType.includes(wanted) || role.includes(wanted) || key.includes(wanted))) score += 45;
    const typeHint = FIELD_HINTS.find((h) => h.field === wanted || h.re.test(wanted));
    if (typeHint?.re.test(key)) score += 35;
  }
  if (normalizeGenerator(spec.generator) && hint?.re.test(key)) score += 10;
  return score;
}

export function resolveFixtureValue(session: Session, label?: string, locatorValue?: string, context: FixtureMatchContext = {}): ResolvedFixtureValue | undefined {
  const key = normalizeText(`${label ?? ''} ${locatorValue ?? ''} ${context.placeholder ?? ''} ${context.nearbyText ?? ''} ${context.role ?? ''} ${context.inputType ?? ''}`);
  let best: { fixture: Fixture; field: string; score: number } | undefined;
  for (const fixture of session.fixtures) {
    for (const field of Object.keys(fixtureFields(fixture))) {
      const score = fieldScore(field, fixtureFields(fixture)[field], key, context);
      if (score > (best?.score ?? 0)) best = { fixture, field, score };
    }
  }
  if (best && best.score > 0) {
    const spec = fixtureFields(best.fixture)[best.field];
    const varName = spec.var ?? variableName(best.fixture.name, best.field);
    const secret = !!spec.secret || /pass|secret|token|otp|pin|cvv|key/i.test(best.field);
    const generated = session.generatedValues.find((g) => g.varName === varName && g.fixture === best.fixture.name && g.field === best.field);
    if (generated) {
      session.inputValues.set(varName, generated.value);
      return { value: generated.value, varName, secret: generated.secret, fixture: best.fixture.name, field: best.field, source: 'generator', generator: generated.generator as FixtureGenerator };
    }
    const fromVar = session.inputValues.get(varName) ?? (spec.var ? process.env[spec.var] : undefined);
    if (fromVar != null) return { value: fromVar, varName, secret, fixture: best.fixture.name, field: best.field, source: 'variable' };
    if (spec.value != null) return { value: spec.value, varName, secret, fixture: best.fixture.name, field: best.field, source: 'value' };
    const generator = normalizeGenerator(spec.generator);
    if (generator && GENERATORS[generator]) {
      const value = GENERATORS[generator]();
      session.inputValues.set(varName, value);
      session.generatedValues.push({ at: Date.now(), fixture: best.fixture.name, field: best.field, varName, generator, value, secret: false });
      return { value, varName, secret: false, fixture: best.fixture.name, field: best.field, source: 'generator', generator };
    }
  }

  const legacy = key ? session.fixtures.find((f) => f.value && (key.includes(normalizeText(f.name)) || normalizeText(f.name).includes(key))) : undefined;
  if (legacy?.value) return { value: legacy.value, varName: variableName(legacy.name, 'value'), secret: false, fixture: legacy.name, field: 'value', source: 'legacy_value' };
  return undefined;
}

export function hasDisposableState(session: Session): boolean {
  return session.fixtures.some((f) => f.disposable === true || f.environment === 'test');
}
