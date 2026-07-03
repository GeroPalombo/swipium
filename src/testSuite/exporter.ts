// Exporters for the persistent suite (SWIPIUM-REQ-06 "qa_suite_export"). PURE: serialize the
// canonical suite to Markdown (review-ready), a per-functionality YAML directory, JSON, and a
// JUnit-like results doc. TestRail CSV / Jira-Xray are explicitly deferred (Non-Goals) — the shapes
// here are the v1 surface other tools can build on.

import { stringify } from 'yaml';
import { functionalitySlug, type CanonicalTestCase, type TestSuiteFile } from './schema.js';

export type ExportFormat = 'markdown' | 'yaml' | 'json' | 'junit';

export interface ExportedFile {
  path: string; // relative to .swipium/test-suite-export/
  content: string;
}

export interface ExportResult {
  format: ExportFormat;
  content?: string; // single-document formats (markdown/json/junit)
  files?: ExportedFile[]; // yaml directory
  summary: string;
}

function groupByFunctionality(cases: CanonicalTestCase[]): Map<string, CanonicalTestCase[]> {
  const groups = new Map<string, CanonicalTestCase[]>();
  for (const c of cases) {
    const key = c.functionality;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  return groups;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function exportMarkdown(suite: TestSuiteFile): string {
  const out: string[] = ['# QA Test Suite', '', `Updated: ${suite.updatedAt}`, `Cases: ${suite.cases.length}`, ''];
  for (const [functionality, cases] of groupByFunctionality(suite.cases)) {
    out.push(`## ${functionality}`, '');
    for (const c of cases) {
      out.push(
        `### ${c.id}: ${c.title}`,
        '',
        `- **Priority:** ${c.priority}  **Type:** ${c.type}  **Creativity:** ${c.creativityLevel}  **Status:** ${c.status}`,
        `- **Platforms:** ${c.platforms.join(', ')}  **Automation:** ${c.automation.status} (locators ${c.automation.locatorReadiness}, replay ${c.automation.replayStatus})`,
        `- **Objective:** ${c.objective}`,
        '',
        '**Preconditions:**',
        ...(c.preconditions.length ? c.preconditions.map((p) => `- ${p}`) : ['- _none_']),
        '',
        '**Steps:**',
        ...(c.steps.length
          ? c.steps.map((s) => `${s.index}. ${s.action}${s.target ? ` → ${s.target}` : ''}${s.data ? ` [${s.data}]` : ''}`)
          : ['- _none_']),
        '',
        '**Expected:**',
        ...c.expectedResult.map((e) => `- ${e}`),
        '',
        `**Actual:** ${c.actualResult.status} — ${c.actualResult.summary}`,
        ...(c.evidence.length ? ['', `**Evidence:** ${c.evidence.map((e) => e.uri).join(', ')}`] : []),
        ...(c.ticketRefs.length ? [`**Tickets:** ${c.ticketRefs.join(', ')}`] : []),
        ...(c.requirementRefs.length ? [`**Requirements:** ${c.requirementRefs.join(', ')}`] : []),
        ...(c.issueRefs?.length
          ? [`**Linked issues:** ${c.issueRefs.map((r) => `${r.issueId} (${r.relationship}, ${r.lastIssueState})`).join(', ')}`]
          : []),
        ...(c.risk.length ? ['', '**Risks:**', ...c.risk.map((r) => `- ${r}`)] : []),
        `- **History:** ${c.history.length} run(s)`,
        '',
      );
    }
  }
  return out.join('\n');
}

export function exportYamlFiles(suite: TestSuiteFile): ExportedFile[] {
  return suite.cases.map((c) => ({
    path: `${functionalitySlug(c.functionality)}/${c.id}.yaml`,
    content: stringify(c),
  }));
}

export function exportJunit(suite: TestSuiteFile): string {
  const groups = groupByFunctionality(suite.cases);
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites name="swipium-test-suite">'];
  for (const [functionality, cases] of groups) {
    const failures = cases.filter((c) => c.actualResult.status === 'fail').length;
    const skipped = cases.filter(
      (c) => c.actualResult.status === 'skipped' || c.actualResult.status === 'not_run' || c.actualResult.status === 'blocked',
    ).length;
    lines.push(`  <testsuite name="${xmlEscape(functionality)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`);
    for (const c of cases) {
      lines.push(`    <testcase classname="${xmlEscape(functionality)}" name="${xmlEscape(`${c.id}: ${c.title}`)}">`);
      if (c.actualResult.status === 'fail') {
        lines.push(
          `      <failure message="${xmlEscape(c.actualResult.summary)}"${c.actualResult.failureCode ? ` type="${xmlEscape(c.actualResult.failureCode)}"` : ''}/>`,
        );
      } else if (c.actualResult.status === 'skipped' || c.actualResult.status === 'not_run' || c.actualResult.status === 'blocked') {
        lines.push(`      <skipped message="${xmlEscape(c.actualResult.status)}: ${xmlEscape(c.actualResult.summary)}"/>`);
      }
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return lines.join('\n');
}

export function exportSuite(suite: TestSuiteFile, format: ExportFormat): ExportResult {
  switch (format) {
    case 'json':
      return { format, content: JSON.stringify(suite, null, 2), summary: `Exported ${suite.cases.length} case(s) as JSON.` };
    case 'markdown':
      return { format, content: exportMarkdown(suite), summary: `Exported ${suite.cases.length} case(s) as Markdown.` };
    case 'junit':
      return { format, content: exportJunit(suite), summary: `Exported ${suite.cases.length} case(s) as JUnit XML.` };
    case 'yaml': {
      const files = exportYamlFiles(suite);
      return { format, files, summary: `Exported ${files.length} case file(s) as YAML.` };
    }
  }
}
