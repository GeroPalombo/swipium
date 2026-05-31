// SWIPIUM Issue Log — stable fingerprinting (SWIPIUM-REQ-07 "Fingerprinting Rules").
//
// A fingerprint must be STABLE across sessions, timestamps, artifact paths, and random ids, but
// SPECIFIC enough not to merge unrelated defects. We build a normalized token list from the
// meaningful signals (failure code/category, platform, screen, route, exception type + top frame,
// HTTP route template + status, package, billing subsystem, normalized visible text) and hash it.
//
// Explicitly EXCLUDED (per spec): session id, screenshot/artifact paths, exact timestamps, random
// ids / emails / UUIDs / tokens / device ids / request ids, line numbers (unless disambiguating),
// and full stack traces. PURE — no clock, no fs.

import { createHash } from 'node:crypto';
import type { IssueCategory, IssueObservation, IssuePlatform } from './schema.js';

/** Replace volatile tokens (timestamps, uuids, emails, ids, tokens) with stable placeholders. */
export function scrubVolatile(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?)?/gi, ':ts') // ISO date/datetime
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, ':uuid') // UUID
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ':email') // email
    .replace(/\bBearer\s+[\w.\-]+/gi, ':token')
    // Any token containing a digit is treated as a volatile id (session id, request id, hash,
    // numeric id, hex). Status codes / version-like signals travel through structural fields, not
    // free text, so over-scrubbing free text here is safe and maximizes fingerprint stability.
    .replace(/\b[\w-]*\d[\w.-]*\b/gi, ':id')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a URL/endpoint to a route template: drop host, replace id-ish path segments. */
export function normalizeRoute(rawUrl: string): string {
  let path = rawUrl;
  // strip scheme + host
  path = path.replace(/^[a-z]+:\/\/[^/]+/i, '');
  // strip query/fragment
  path = path.replace(/[?#].*$/, '');
  const segs = path.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id'; // numeric id
    if (/[a-f0-9]{8}-[a-f0-9]{4}-/i.test(seg)) return ':id'; // uuid-ish
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id'; // hex id
    if (/\d/.test(seg) && /[a-z]/i.test(seg) && seg.length > 12) return ':id'; // mixed long token
    return seg.toLowerCase();
  });
  return segs.join('/') || '/';
}

/** Normalize an exception message: drop the "(reading 'x')" detail into a stable shape and scrub. */
export function normalizeException(type?: string, message?: string, topFrame?: string): string {
  const parts: string[] = [];
  if (type) parts.push(type);
  if (message) {
    let m = message.toLowerCase();
    // "Cannot read properties of undefined (reading 'map')" → "cannot_read_property map"
    const reading = m.match(/cannot read propert(?:y|ies) of \w+ \(reading '([^']+)'\)/);
    if (reading) {
      m = `cannot_read_property ${reading[1]}`;
    } else {
      m = scrubVolatile(m).replace(/[^a-z0-9 _]/g, ' ').replace(/\s+/g, ' ').trim();
      // keep it short — a few meaningful words
      m = m.split(' ').slice(0, 6).join(' ');
    }
    parts.push(m);
  }
  if (topFrame) {
    // keep the file/function name, strip line:col numbers
    const frame = topFrame.replace(/:\d+(:\d+)?$/, '').replace(/^at\s+/, '').trim();
    parts.push(frame.split(/[\\/]/).pop() ?? frame);
  }
  return parts.join(' ').trim();
}

export interface FingerprintInput {
  category?: IssueCategory;
  failureCode?: string;
  platform?: IssuePlatform;
  appId?: string;
  observation?: IssueObservation;
}

/** Build the ordered, normalized token list that defines an issue's identity. */
export function fingerprintTokens(input: FingerprintInput): string[] {
  const tokens: string[] = [];
  const obs: Partial<IssueObservation> = input.observation ?? {};
  if (input.failureCode) tokens.push(`code:${input.failureCode.toLowerCase()}`);
  else if (input.category) tokens.push(`cat:${input.category}`);
  if (input.platform && input.platform !== 'unknown') tokens.push(`plat:${input.platform}`);
  if (input.appId) tokens.push(`app:${input.appId}`);
  // Screen identity: prefer a stable app-map screen id / route, fall back to purpose.
  if (obs.screenId) tokens.push(`screen:${obs.screenId.toLowerCase()}`);
  else if (obs.route) tokens.push(`route:${normalizeRoute(obs.route)}`);
  else if (obs.screenPurpose) tokens.push(`purpose:${obs.screenPurpose.toLowerCase()}`);
  if (obs.workflow) tokens.push(`flow:${obs.workflow.toLowerCase().replace(/\s+/g, '_')}`);
  if (obs.exception && (obs.exception.type || obs.exception.message || obs.exception.topFrame)) {
    const ex = normalizeException(obs.exception.type, obs.exception.message, obs.exception.topFrame);
    if (ex) tokens.push(`exc:${ex}`);
  }
  if (obs.http && (obs.http.routeTemplate || obs.http.status != null)) {
    const method = (obs.http.method ?? 'GET').toUpperCase();
    const route = obs.http.routeTemplate ? normalizeRoute(obs.http.routeTemplate) : '';
    tokens.push(`http:${method} ${route} status=${obs.http.status ?? ''}`.trim());
  }
  if (obs.packageName) tokens.push(`pkg:${obs.packageName.toLowerCase()}`);
  if (obs.subsystem) tokens.push(`sub:${obs.subsystem.toLowerCase()}`);
  // Only include visible text when there's no stronger structural signal (exception/http).
  const hasStructural = Boolean(obs.exception || obs.http || obs.screenId || obs.route);
  if (obs.visibleText && !hasStructural) {
    const norm = scrubVolatile(obs.visibleText.toLowerCase()).split(' ').slice(0, 10).join(' ');
    if (norm) tokens.push(`text:${norm}`);
  }
  return tokens;
}

/** A short hex digest of the tokens, prefixed `sha256:` (matches the spec's example shape). */
export function fingerprint(input: FingerprintInput): string {
  const tokens = fingerprintTokens(input);
  const basis = tokens.join('|');
  const digest = createHash('sha256').update(basis).digest('hex');
  return `sha256:${digest.slice(0, 32)}`;
}

/** Derive a short, stable issue id from a fingerprint (iss_<8 hex>). */
export function issueIdFromFingerprint(fp: string): string {
  const hex = fp.replace(/^sha256:/, '');
  return `iss_${hex.slice(0, 8)}`;
}
