// Sensitive-mode redaction (DESIGN §9.7, M6). Two mechanisms:
//  1. isSecureNode → a field whose VALUE must never be shown (password/OTP/etc.).
//  2. makeRedactor → scrub known secret values (things typed into secure fields) from any
//     string we emit (snapshots, inspect, report, dump-xml artifacts, logs).

import type { RawNode } from '../snapshot/parse.js';

const SECRET_RE = /password|passwd|otp|one.?time|pin\b|cvv|card.?number|secret|token|security.?code/i;

export function isSecureNode(n: Pick<RawNode, 'id' | 'desc' | 'attrs'>): boolean {
  return n.attrs?.password === 'true' || SECRET_RE.test(n.id) || SECRET_RE.test(n.desc);
}

export type Redactor = (s?: string) => string | undefined;

export function makeRedactor(secrets: Iterable<string>): Redactor {
  const list = [...secrets].filter((x) => x && x.length >= 2).sort((a, b) => b.length - a.length);
  return (s?: string) => {
    if (!s || list.length === 0) return s;
    let out = s;
    for (const sec of list) if (out.includes(sec)) out = out.split(sec).join('«redacted»');
    return out;
  };
}
