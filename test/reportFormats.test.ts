// CI report formats (Reporting V3): toJUnit / toSarif / toGithubSummary emitters and the
// release-gate policy seam (reportPolicyVerdicts → applyPolicy) that feeds their verdict.

import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GITHUB_SUMMARY_MAX_BYTES,
  escapeXml,
  redactReportData,
  reportPolicyVerdicts,
  toGithubSummary,
  toJUnit,
  toMarkdown,
  toPlaywrightJson,
  toSarif,
  type ReportData,
} from '../src/report/export.js';
import { applyPolicy, type Policy } from '../src/report/policy.js';
import { projectManifestUri, repositoryTopLevel, resolveSarifSources } from '../src/report/sarifSources.js';
import { makeRedactor } from '../src/lib/redact.js';

// A reason/detail that exercises XML/JSON escaping: <, &, ", and a newline.
const NASTY = 'Error <tag> & "quoted"\nsecond line';

function fixture(): ReportData {
  return {
    sessionId: 'sess-1',
    appId: 'com.example.demo',
    device: 'emulator-5554',
    coverage: 'smoke coverage of 2 workflows',
    executiveSummary: { risk: 'block', reasons: ['native crash observed'], nextAction: 'Fix the crash on login.' },
    nativeHealth: 'error',
    appHealth: 'degraded',
    findings: [
      { severity: 'high', layer: 'native', kind: 'crash', failureCode: 'NATIVE_CRASH', detail: NASTY },
      { severity: 'medium', layer: 'app', kind: 'anr', detail: 'main thread stalled 6s' },
      {
        severity: 'low',
        layer: 'app',
        kind: 'log_noise',
        detail: 'verbose warnings in logcat',
        screenshotUri: 'swipium://session/sess-1/screenshot/low.png',
      },
    ],
    highSeverityCount: 1,
    testOutcomes: [
      {
        workflow: 'login flow',
        outcome: 'fail',
        category: 'app_bug',
        reason: NASTY,
        artifactUris: ['swipium://session/sess-1/screenshot/fail.png'],
      },
      { workflow: 'signup flow', outcome: 'pass' },
    ],
    outcomeTally: { pass: 1, fail: 1 },
    environmentChanges: [],
    guardrailOverrides: [],
    finalNetwork: 'online',
    networkRestore: 'unchanged',
    authState: 'unknown (no auth signal observed)',
    phaseTimings: { totalMs: 60_000, setupMs: 10_000, activeMs: 50_000, timeToLoginMs: null },
    artifacts: [{ uri: 'swipium://session/sess-1/screenshot/fail.png', kind: 'screenshot' }],
  };
}

const gatePolicy: Policy = { blockOn: ['native_crash'], warnOn: ['app_bug'], ignoreKnown: [], ciAllowMutations: [] };

describe('reportPolicyVerdicts + applyPolicy', () => {
  it('maps outcomes and high findings to verdicts, and the policy shapes block vs warn', () => {
    const verdicts = reportPolicyVerdicts(fixture());
    // 2 workflow outcomes + 1 high finding (medium/low findings do not gate).
    expect(verdicts).toHaveLength(3);
    expect(verdicts.find((v) => v.flow === 'signup flow')?.passed).toBe(true);
    expect(verdicts.find((v) => v.flow === 'login flow')).toMatchObject({ passed: false, failureCode: 'app_bug' });
    expect(verdicts.find((v) => v.flow === 'finding:crash')).toMatchObject({ passed: false, failureCode: 'NATIVE_CRASH' });

    const decision = applyPolicy(verdicts, gatePolicy);
    expect(decision.block).toBe(true);
    expect(decision.blocked).toEqual(['finding:crash: NATIVE_CRASH']);
    expect(decision.warned).toEqual(['login flow: app_bug']);
    expect(decision.reason).toContain('release blocked');
  });

  it('with no policy any failure blocks; ignoreKnown suppresses a known code', () => {
    const verdicts = reportPolicyVerdicts(fixture());
    expect(applyPolicy(verdicts, null).blocked).toHaveLength(2);

    const suppressing: Policy = { ...gatePolicy, ignoreKnown: ['NATIVE_CRASH'] };
    const decision = applyPolicy(verdicts, suppressing);
    expect(decision.block).toBe(false);
    expect(decision.suppressed).toEqual(['finding:crash: NATIVE_CRASH']);
    expect(decision.warned).toEqual(['login flow: app_bug']);
  });
});

interface JunitTestcase {
  '@_name': string;
  failure?: { '#text': string; '@_message': string };
}
interface JunitSuite {
  '@_failures': string;
  testcase: JunitTestcase | JunitTestcase[];
  properties?: { property: Array<{ '@_name': string; '@_value': string }> };
}
interface JunitDoc {
  testsuites: { '@_tests': string; '@_failures': string; testsuite: JunitSuite[] };
}

describe('toJUnit', () => {
  // htmlEntities decodes the numeric char refs (&#10;) escapeXml uses for newlines.
  const parse = (xml: string) =>
    new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true }).parse(xml) as JunitDoc;

  it('emits parseable XML with matching failure counts', () => {
    const doc = parse(toJUnit(fixture()));
    const root = doc.testsuites;
    expect(root['@_tests']).toBe('5'); // 2 workflows + 3 findings
    expect(root['@_failures']).toBe('2'); // 1 failed workflow + 1 high finding
    const suites = root.testsuite;
    expect(suites).toHaveLength(2);
    expect(suites[0]['@_failures']).toBe('1');
    expect(suites[1]['@_failures']).toBe('1');
  });

  it('round-trips <, &, " and newlines through escaping', () => {
    const doc = parse(toJUnit(fixture()));
    const cases = doc.testsuites.testsuite[0].testcase;
    const failed = (Array.isArray(cases) ? cases : [cases]).find((c) => c['@_name'] === 'login flow');
    expect(failed?.failure?.['#text']).toBe(`app_bug: ${NASTY}`);
    expect(failed?.failure?.['@_message']).toBe(`app_bug: ${NASTY}`);
  });

  it('records the release-gate PolicyDecision as testsuite properties', () => {
    const decision = applyPolicy(reportPolicyVerdicts(fixture()), gatePolicy);
    const doc = parse(toJUnit(fixture(), decision));
    const props = doc.testsuites.testsuite[0].properties?.property ?? [];
    expect(props[0]['@_name']).toBe('swipium.releaseGate');
    expect(props[0]['@_value']).toBe('fail');
    expect(props[1]['@_value']).toContain('release blocked');
  });
});

interface SarifDoc {
  version: string;
  runs: Array<{
    results: Array<{
      ruleId: string;
      level: string;
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string; uriBaseId?: string };
          region: { startLine: number; startColumn: number; endLine: number; endColumn: number };
        };
      }>;
      partialFingerprints: Record<string, string>;
      relatedLocations?: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
    }>;
    tool: {
      driver: {
        rules: Array<{ id: string; shortDescription: { text: string }; fullDescription: { text: string }; help: { text: string } }>;
      };
    };
    invocations: Array<{ executionSuccessful: boolean }>;
    properties: { releaseGate?: { block: boolean }; releaseGateVerdict?: string };
  }>;
}

describe('toSarif', () => {
  it('emits valid SARIF with severity → level mapping and a policy-driven invocation', () => {
    const decision = applyPolicy(reportPolicyVerdicts(fixture()), gatePolicy);
    const sarif = JSON.parse(toSarif(fixture(), decision)) as SarifDoc;
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    // 3 findings + 1 failed workflow.
    expect(run.results).toHaveLength(4);
    const levelByRule = Object.fromEntries(run.results.map((r) => [r.ruleId, r.level]));
    expect(levelByRule.NATIVE_CRASH).toBe('error'); // high
    expect(levelByRule.anr).toBe('warning'); // medium
    expect(levelByRule.log_noise).toBe('note'); // low
    expect(levelByRule.app_bug).toBe('error'); // failed workflow
    expect(run.results[0].message.text).toContain(NASTY); // escaping survives JSON round-trip
    // B3: executionSuccessful means "the tool ran"; the gate verdict lives in run.properties.
    expect(run.invocations[0].executionSuccessful).toBe(true);
    expect(run.properties.releaseGate?.block).toBe(true);
    expect(run.properties.releaseGateVerdict).toBe('block');
  });

  it('falls back to release risk for the gate verdict when no policy is given', () => {
    const sarif = JSON.parse(toSarif(fixture())) as SarifDoc;
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(sarif.runs[0].properties.releaseGateVerdict).toBe('block'); // risk === 'block'
  });
});

describe('toGithubSummary', () => {
  it('contains the verdict, the policy gate, and the finding/workflow titles', () => {
    const decision = applyPolicy(reportPolicyVerdicts(fixture()), gatePolicy);
    const md = toGithubSummary(fixture(), decision);
    expect(md).toContain('🔴 BLOCK');
    expect(md).toContain('**Release gate (policy):** ❌ FAIL');
    expect(md).toContain('release blocked: finding:crash: NATIVE\\_CRASH'); // Markdown-escaped
    expect(md).toContain('NATIVE_CRASH');
    expect(md).toContain('login flow');
    expect(md).toContain('Next action:');
    // Newlines in table cells become <br> so the Markdown table stays intact; HTML is neutralized.
    expect(md).toContain('Error &lt;tag&gt; &amp; "quoted"<br>second line');
  });
});

// ---------------------------------------------------------------------------------------------
// 1.6.0-RC fixes: B2 (XML-illegal chars), B3 (SARIF locations), B9 (deep redaction), D5 (policy-
// aware JUnit + GitHub summary cap/escaping).

/** Strict XML 1.0 Char production check (https://www.w3.org/TR/xml/#charsets), applied to the raw
 *  document AND to every numeric character reference — fast-xml-parser happily accepts both. */
function assertStrictXmlChars(xml: string): void {
  for (const ch of xml) {
    const cp = ch.codePointAt(0)!;
    const ok =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    expect(ok, `illegal XML char U+${cp.toString(16).padStart(4, '0')}`).toBe(true);
  }
  for (const m of xml.matchAll(/&#(x[0-9a-f]+|\d+);/gi)) {
    const cp = m[1][0].toLowerCase() === 'x' ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10);
    expect(cp === 0x9 || cp === 0xa || cp === 0xd || cp >= 0x20, `illegal char ref ${m[0]}`).toBe(true);
  }
}

const hasXmllint = spawnSync('xmllint', ['--version']).status === 0;

describe('B2: JUnit is well-formed XML 1.0 even with control characters', () => {
  const dirty = (): ReportData => {
    const r = fixture();
    r.findings[0].detail = 'logcat: \x1b[31mFATAL\x1b[0m nul=\0 bell=\x07 ff=\x0c lone=\ud800 end=￿ ok=\u{1F600}';
    r.testOutcomes[0].reason = 'metro \x1b[2Kbundle failed\0';
    r.testOutcomes[0].workflow = 'login\x1b flow';
    return r;
  };

  it('escapeXml replaces C0 controls, lone surrogates and U+FFFE/FFFF but keeps tab/newline and astral chars', () => {
    const out = escapeXml('a\x1bb\0c\td\ne\ud800f￿g\u{1F600}');
    expect(out).toBe('a�b�c\td&#10;e�f�g\u{1F600}');
  });

  it('passes a strict XML 1.0 character check', () => {
    assertStrictXmlChars(toJUnit(dirty(), applyPolicy(reportPolicyVerdicts(dirty()), gatePolicy)));
  });

  it.skipIf(!hasXmllint)('passes xmllint --noout (strict libxml2 parser)', () => {
    const res = spawnSync('xmllint', ['--noout', '-'], { input: toJUnit(dirty()) });
    expect(res.stderr.toString()).toBe('');
    expect(res.status).toBe(0);
  });
});

describe('B3: SARIF results carry a real repo location GitHub will display', () => {
  it('anchors every result to a repo-relative file with a full region and fingerprints', () => {
    const sarif = JSON.parse(toSarif(fixture(), undefined, { sources: { defaultUri: 'app.json' } })) as SarifDoc;
    const run = sarif.runs[0];
    expect(run.results.length).toBeGreaterThan(0);
    const hashes = new Set<string>();
    for (const res of run.results) {
      const loc = res.locations[0].physicalLocation;
      expect(loc.artifactLocation.uri).toBe('app.json');
      expect(loc.artifactLocation.uriBaseId).toBe('%SRCROOT%');
      expect(loc.artifactLocation.uri).not.toMatch(/^swipium:/);
      expect(loc.region).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 });
      expect(res.partialFingerprints.primaryLocationLineHash).toMatch(/^[0-9a-f]{16}:\d+$/);
      hashes.add(res.partialFingerprints.primaryLocationLineHash);
    }
    // Distinct results on the same manifest line must not collapse into one alert.
    expect(hashes.size).toBe(run.results.length);
    // Evidence stays reachable, just not as the primary location.
    const withEvidence = run.results.find((r) => r.ruleId === 'app_bug');
    expect(withEvidence?.relatedLocations?.[0].physicalLocation.artifactLocation.uri).toMatch(/^swipium:\/\//);
    for (const rule of run.tool.driver.rules) {
      expect(rule.shortDescription.text).toBeTruthy();
      expect(rule.fullDescription.text).toBeTruthy();
      expect(rule.help.text).toBeTruthy();
    }
  });

  it('fingerprints are stable across runs (volatile ids scrubbed)', () => {
    const a = fixture();
    const b = fixture();
    a.findings[1].detail = 'main thread stalled 6s at 2026-09-01T10:00:00Z req=abc123';
    b.findings[1].detail = 'main thread stalled 6s at 2026-09-02T11:00:00Z req=def456';
    const fp = (r: ReportData) => (JSON.parse(toSarif(r)) as SarifDoc).runs[0].results.map((x) => x.partialFingerprints['swipium/v1']);
    expect(fp(a)).toEqual(fp(b));
  });

  it('resolves the project manifest and app-map screen/feature sources that exist on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'swipium-sarif-src-'));
    try {
      expect(projectManifestUri(root)).toBe('package.json'); // nothing exists → documented default
      mkdirSync(join(root, 'android', 'app'), { recursive: true });
      writeFileSync(join(root, 'android', 'app', 'build.gradle.kts'), '');
      expect(projectManifestUri(root)).toBe('android/app/build.gradle.kts');
      writeFileSync(join(root, 'app.json'), '{}');
      expect(projectManifestUri(root)).toBe('app.json');

      mkdirSync(join(root, 'src', 'screens'), { recursive: true });
      writeFileSync(join(root, 'src', 'screens', 'Login.tsx'), '');
      mkdirSync(join(root, '.swipium'), { recursive: true });
      writeFileSync(
        join(root, '.swipium', 'app-map.json'),
        JSON.stringify({
          staticTopology: {
            screens: [
              { id: 'login', name: 'Login', sourceFiles: ['src/screens/Login.tsx'] },
              { id: 'evil', name: 'Evil', sourceFiles: ['../../etc/passwd'] },
            ],
          },
          features: [{ id: 'auth', title: 'login flow', sourceFiles: ['src/screens/Login.tsx', 'missing.tsx'] }],
        }),
      );
      const r = fixture();
      r.findings[0].screen = 'Login';
      r.findings[1].screen = 'Evil';
      const sources = resolveSarifSources(root, r);
      expect(sources.defaultUri).toBe('app.json');
      expect(sources.byScreen).toEqual({ login: 'src/screens/Login.tsx' });
      expect(sources.byWorkflow).toEqual({ 'login flow': 'src/screens/Login.tsx' });
      const sarif = JSON.parse(toSarif(r, undefined, { sources })) as SarifDoc;
      const uris = sarif.runs[0].results.map((x) => x.locations[0].physicalLocation.artifactLocation.uri);
      expect(uris).toEqual(['src/screens/Login.tsx', 'app.json', 'app.json', 'src/screens/Login.tsx']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('review: SARIF URIs are repository-relative in a monorepo', () => {
  it('prefixes anchors with the path from the git top-level to the session root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swipium-sarif-mono-'));
    try {
      mkdirSync(join(repo, '.git'));
      const app = join(repo, 'apps', 'mobile');
      mkdirSync(join(app, 'src', 'screens'), { recursive: true });
      writeFileSync(join(app, 'app.json'), '{}');
      writeFileSync(join(app, 'src', 'screens', 'Login.tsx'), '');
      mkdirSync(join(app, '.swipium'), { recursive: true });
      writeFileSync(
        join(app, '.swipium', 'app-map.json'),
        JSON.stringify({ staticTopology: { screens: [{ id: 'login', name: 'Login', sourceFiles: ['src/screens/Login.tsx'] }] } }),
      );
      expect(repositoryTopLevel(app)).toBe(repo);
      const r = fixture();
      r.findings[0].screen = 'Login';
      const sources = resolveSarifSources(app, r);
      expect(sources.defaultUri).toBe('apps/mobile/app.json');
      expect(sources.byScreen).toEqual({ login: 'apps/mobile/src/screens/Login.tsx' });
      // At the repo root itself (or outside git) there is no prefix.
      writeFileSync(join(repo, 'package.json'), '{}');
      expect(resolveSarifSources(repo, fixture()).defaultUri).toBe('package.json');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('review: redactReportData key collisions', () => {
  it('disambiguates keys that collide after redaction instead of dropping one', () => {
    const out = redactReportData({ vars: { hunter22: 1, '«redacted»': 2, user_hunter22: 3 } }, makeRedactor(['hunter22']));
    expect(out.vars).toEqual({ '«redacted»': 1, '«redacted»#2': 2, 'user_«redacted»': 3 });
  });
});

describe('B9: every export is deep-redacted before escaping', () => {
  const SECRET = 'P@ss&w0rd"1';
  const leaky = (): ReportData => {
    const r = fixture();
    r.testOutcomes[0] = {
      ...r.testOutcomes[0],
      workflow: `login as qa with ${SECRET}`,
      missingPrecondition: `account password ${SECRET}`,
      steps: [{ index: 0, kind: 'type', summary: `typed ${SECRET}`, ok: false, failureCode: 'ASSERTION_FAILED' }],
    };
    r.findings[0].nextStep = `retry with ${SECRET}`;
    r.executiveSummary.nextAction = `log in with ${SECRET}`;
    r.artifacts.push({ uri: 'swipium://session/sess-1/report/x.json', kind: 'report', label: `pw=${SECRET}` });
    return r;
  };
  // Every escaped spelling the formats could produce.
  const spellings = [SECRET, 'P@ss&amp;w0rd', 'w0rd&quot;1', 'w0rd\\"1', 'P@ss\\&w0rd', 'P@ss&w0rd'];

  it('no raw or escaped form of the secret reaches junit/sarif/github-summary/markdown/json/playwright', () => {
    const data = redactReportData(leaky(), makeRedactor([SECRET]));
    const policy = applyPolicy(reportPolicyVerdicts(data), null);
    const outputs = {
      junit: toJUnit(data, policy),
      sarif: toSarif(data, policy),
      summary: toGithubSummary(data, policy),
      markdown: toMarkdown(data),
      json: JSON.stringify(data),
      playwright: toPlaywrightJson(data),
    };
    for (const [format, body] of Object.entries(outputs)) {
      for (const s of spellings) expect(body, `${format} leaked ${s}`).not.toContain(s);
      expect(body, format).toContain('«redacted»');
    }
  });

  it('control: unredacted exports really do carry the escaped spellings checked above', () => {
    expect(toJUnit(leaky())).toContain('P@ss&amp;w0rd&quot;1');
    expect(toSarif(leaky())).toContain('P@ss&w0rd\\"1');
  });

  it('redacts object keys too (outcomesByWorkflow is keyed by workflow name)', () => {
    const out = redactReportData({ outcomesByWorkflow: { [`login ${SECRET}`]: { outcome: 'fail' } } }, makeRedactor([SECRET]));
    expect(JSON.stringify(out)).not.toContain('w0rd');
  });

  it('does not mutate the input', () => {
    const r = leaky();
    redactReportData(r, makeRedactor([SECRET]));
    expect(r.executiveSummary.nextAction).toContain(SECRET);
  });
});

describe('D5: policy-aware JUnit and GitHub summary limits', () => {
  it('failures the policy only warns on / ignores are <skipped>, so a gate PASS has zero JUnit failures', () => {
    const r = fixture();
    const lenient: Policy = { blockOn: ['native_crash'], warnOn: ['app_bug'], ignoreKnown: ['NATIVE_CRASH'], ciAllowMutations: [] };
    const decision = applyPolicy(reportPolicyVerdicts(r), lenient);
    expect(decision.block).toBe(false);
    const xml = toJUnit(r, decision);
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true }).parse(xml) as JunitDoc;
    expect(doc.testsuites['@_failures']).toBe('0');
    expect(xml).not.toContain('<failure');
    expect(xml).toContain('policy warned (release gate not blocked): app_bug');
    expect(xml).toContain('policy suppressed (release gate not blocked): NATIVE_CRASH');
  });

  it('a blocking policy still emits <failure> for the blocking entries only', () => {
    const r = fixture();
    const decision = applyPolicy(reportPolicyVerdicts(r), gatePolicy); // crash blocks, app_bug warns
    const xml = toJUnit(r, decision);
    expect(xml.match(/<failure /g)).toHaveLength(1);
    expect(xml).toContain('<failure message="NATIVE_CRASH">');
  });

  it('caps the GitHub summary under 1 MiB with a truncation note', () => {
    const r = fixture();
    r.artifacts = [];
    r.testOutcomes = Array.from({ length: 4000 }, (_, i) => ({
      workflow: `flow ${i}`,
      outcome: 'fail' as const,
      reason: 'x'.repeat(1500),
    }));
    const md = toGithubSummary(r);
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(GITHUB_SUMMARY_MAX_BYTES);
    expect(md).toContain('Summary truncated');
    expect(md.startsWith('## Swipium QA')).toBe(true);
  });

  it('escapes appId, device, policy reason and next action', () => {
    const r = fixture();
    r.appId = 'com.x`<img src=x onerror=alert(1)>';
    r.device = 'pixel\n## injected';
    r.executiveSummary.nextAction = '<script>alert(1)</script> [click](javascript:alert(1))';
    const decision = { ...applyPolicy(reportPolicyVerdicts(r), gatePolicy), reason: 'blocked: <b>x</b> | y' };
    const md = toGithubSummary(r, decision);
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<b>');
    expect(md).not.toContain('\n## injected');
    expect(md).toContain('\\[click\\]');
    expect(md).toContain('``'); // backtick in appId → double-backtick code span
  });
});
