// Generated-code validation. Pure: validates emitted files WITHOUT a device.
// Checks (formerly qa_automation_validate; now run via qa_generate + acceptance criteria):
//   - no inlined secrets (env-only),
//   - locator durability threshold (fails on brittle-only above threshold unless candidate-only),
//   - capability config presence,
//   - lightweight syntax sanity (brace balance for JS/TS),
//   - no empty essential files.

import type { GeneratedFile } from '../suite/pom.js';
import { findSecretLeaks } from '../suite/secretGuard.js';

export type Severity = 'error' | 'warning';

export interface ValidationFinding {
  code: string;
  severity: Severity;
  file?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: ValidationFinding[];
  secretsClean: boolean;
  brittlePct: number;
  brittleThreshold: number;
  candidateOnly: boolean;
  filesChecked: number;
}

export interface ValidateOptions {
  brittlePct?: number;
  brittleThreshold?: number;
  candidateOnly?: boolean;
  /** Secret env-var names the suite uses. Used to confirm they're never assigned a literal. */
  secrets?: string[];
  /** Registered secret VALUES (session.secrets). Any occurrence in any generated file (comments
   *  included) is a SECRET_IN_GENERATED_OUTPUT error: the heuristics above cannot see a password
   *  typed into a field the UI did not flag as secure. */
  secretValues?: Iterable<string>;
  /** Selector/screen strings of the recording (secretGuard.structuralLiterals): a weak secret equal
   *  to one of them is a locator in the output, not a leak. */
  structural?: Iterable<string>;
}

// password = "literal" / token: 'literal' etc., but NOT process.env / os.environ references.
const SECRET_ASSIGN_RE = /(password|passwd|secret|token|api[_-]?key|apikey|bearer|credential|pwd)\s*[:=]\s*(["'])(?!\s*\2)([^"']{3,})\2/i;
const ENV_REF_RE = /(process\.env|os\.environ|getenv|\$\{?env)/i;

function scanSecrets(files: GeneratedFile[], secrets: string[]): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    lines.forEach((line, i) => {
      // Skip comment lines and lines that read from the environment.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return;
      if (ENV_REF_RE.test(line)) return;
      const m = SECRET_ASSIGN_RE.exec(line);
      if (m) {
        findings.push({
          code: 'INLINED_SECRET',
          severity: 'error',
          file: f.path,
          message: `possible inlined secret at line ${i + 1}: ${m[1]} assigned a literal; read from the environment instead`,
        });
      }
      // Explicit: a known secret env-var name assigned a literal value.
      for (const s of secrets) {
        const re = new RegExp(`${s}\\s*[:=]\\s*["'][^"']+["']`);
        if (re.test(line) && !ENV_REF_RE.test(line)) {
          findings.push({
            code: 'INLINED_SECRET',
            severity: 'error',
            file: f.path,
            message: `secret var ${s} assigned a literal at line ${i + 1}`,
          });
        }
      }
    });
  }
  return findings;
}

function braceBalance(files: GeneratedFile[]): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const f of files) {
    if (!/\.(ts|js)$/.test(f.path)) continue;
    const pairs: Array<[string, string, string]> = [
      ['{', '}', 'braces'],
      ['(', ')', 'parens'],
      ['[', ']', 'brackets'],
    ];
    // Strip strings/comments crudely to avoid counting literals.
    const stripped = stripJs(f.content);
    for (const [open, close, name] of pairs) {
      const o = countChar(stripped, open);
      const c = countChar(stripped, close);
      if (o !== c)
        findings.push({
          code: 'UNBALANCED_SYNTAX',
          severity: 'error',
          file: f.path,
          message: `unbalanced ${name} (${o} ${open} vs ${c} ${close})`,
        });
    }
  }
  return findings;
}

function stripJs(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function capabilityPresence(files: GeneratedFile[]): ValidationFinding[] {
  const capFile = files.find((f) => /config\/capabilities\.(ts|js)$/.test(f.path) || /conftest\.py$/.test(f.path));
  if (!capFile) {
    return [{ code: 'NO_CAPABILITIES', severity: 'warning', message: 'no capabilities/conftest file found in the generated suite' }];
  }
  // JS/TS capabilities spell out `platformName`; Appium-Python-Client uses typed options objects
  // (UiAutomator2Options / XCUITestOptions set platformName + automationName themselves).
  const platformSet =
    /platformName|platform_name/i.test(capFile.content) || /\b(UiAutomator2Options|XCUITestOptions)\s*\(/.test(capFile.content);
  const ok = platformSet && /(UiAutomator2|XCUITest)/.test(capFile.content);
  return ok
    ? []
    : [
        {
          code: 'INVALID_CAPABILITIES',
          severity: 'error',
          file: capFile.path,
          message: 'capability config missing platformName/automationName',
        },
      ];
}

function emptyEssentials(files: GeneratedFile[]): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const f of files) {
    if (/__init__\.py$/.test(f.path)) continue; // intentionally empty
    if (f.content.trim() === '')
      findings.push({ code: 'EMPTY_FILE', severity: 'warning', file: f.path, message: 'generated file is empty' });
  }
  return findings;
}

export function validateGeneratedSuite(files: GeneratedFile[], opts: ValidateOptions = {}): ValidationResult {
  const brittlePct = opts.brittlePct ?? 0;
  const brittleThreshold = opts.brittleThreshold ?? 40;
  const candidateOnly = opts.candidateOnly ?? false;

  const findings: ValidationFinding[] = [];
  const secretFindings = [
    ...scanSecrets(files, opts.secrets ?? []),
    ...findSecretLeaks(files, opts.secretValues, { structural: opts.structural }).map((l): ValidationFinding => ({
      code: 'SECRET_IN_GENERATED_OUTPUT',
      severity: 'error',
      file: l.path,
      message: `registered secret value written in plaintext at line ${l.line}; must be an environment variable`,
    })),
  ];
  findings.push(...secretFindings);
  findings.push(...braceBalance(files));
  findings.push(...capabilityPresence(files));
  findings.push(...emptyEssentials(files));

  // Locator durability threshold: a brittle-heavy suite is not release-grade unless explicitly
  // labeled candidate-only.
  if (brittlePct > brittleThreshold && !candidateOnly) {
    findings.push({
      code: 'BRITTLE_OVER_THRESHOLD',
      severity: 'error',
      message: `brittle locators ${brittlePct}% exceed the ${brittleThreshold}% threshold; add durable locators or label the suite candidate-only`,
    });
  } else if (brittlePct > brittleThreshold && candidateOnly) {
    findings.push({
      code: 'BRITTLE_OVER_THRESHOLD',
      severity: 'warning',
      message: `brittle locators ${brittlePct}% exceed the ${brittleThreshold}% threshold; suite is labeled candidate-only`,
    });
  }

  const ok = !findings.some((f) => f.severity === 'error');
  return {
    ok,
    findings,
    secretsClean: secretFindings.length === 0,
    brittlePct,
    brittleThreshold,
    candidateOnly,
    filesChecked: files.length,
  };
}
