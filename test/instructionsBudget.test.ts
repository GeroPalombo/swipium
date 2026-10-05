// F4: Claude Code truncates server instructions at 2048 chars and Codex advises the first 512
// chars stand alone. Keep SERVER_INSTRUCTIONS under budget with the essentials up front, and the
// recommended poll (R2) under a 60 s client tool timeout.
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS, orientation } from '../src/tools/agent.js';
import { MAX_JOB_WAIT_MS, RECOMMENDED_JOB_WAIT_MS } from '../src/tools/jobs.js';

describe('SERVER_INSTRUCTIONS budget', () => {
  it('fits the 2048-char client limit with headroom', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
  });

  it('the first 512 chars stand alone: what Swipium is, the first call, and polling', () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    expect(head).toMatch(/Swipium runs mobile QA/);
    expect(head).toContain('qa_test_this');
    expect(head).toContain('qa_job_status');
    expect(head).toContain(`waitMs:${RECOMMENDED_JOB_WAIT_MS}`);
  });

  it('keeps the essential guidance', () => {
    for (const s of [
      'needs_input',
      'qa_continue_from_blocker',
      'requiresConsent',
      'approve:true',
      'qa_explain_blocker',
      'SWIPIUM_PROJECT_ROOT',
      'PROJECT_ROOT_UNRESOLVED',
      'INVALID_ARGUMENT',
      'STALE_CLIENT',
      'qa_status',
      'qa_get_artifact',
    ])
      expect(SERVER_INSTRUCTIONS, s).toContain(s);
  });

  it('recommends a poll that ends before a 60 s client tool timeout, same as qa_status orientation', () => {
    expect(RECOMMENDED_JOB_WAIT_MS).toBeLessThanOrEqual(MAX_JOB_WAIT_MS);
    expect(MAX_JOB_WAIT_MS).toBeLessThan(60_000);
    expect(orientation().polling.args.waitMs).toBe(RECOMMENDED_JOB_WAIT_MS);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/waitMs:\s*60000/);
  });
});
