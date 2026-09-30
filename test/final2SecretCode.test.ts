// Item 4: one shared secret-variable-name rule. `code` (e.g. SWIPIUM_VERIFICATION_CODE) is secret
// for qa_act placeholder expansion exactly as for flows and qa_continue_from_blocker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dump, FakeDriver, harness, structured } from './actFixFake.js';
import { expandInputPlaceholders } from '../src/tools/act.js';
import { parseFlow, SECRET_VAR_NAME } from '../src/flows/schema.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness('final2-secret-code');
});
afterAll(async () => {
  delete process.env.SWIPIUM_VERIFICATION_CODE;
  await h.close();
});

describe('shared SECRET_VAR_NAME', () => {
  it('covers code-named vars', () => {
    expect(SECRET_VAR_NAME.test('SWIPIUM_VERIFICATION_CODE')).toBe(true);
    expect(SECRET_VAR_NAME.test('SWIPIUM_TEST_EMAIL')).toBe(false);
  });

  it('expandInputPlaceholders treats an env ${SWIPIUM_VERIFICATION_CODE} as secret', () => {
    const r = expandInputPlaceholders(
      '${SWIPIUM_VERIFICATION_CODE}',
      { values: new Map(), secretVars: new Set() },
      {
        SWIPIUM_VERIFICATION_CODE: '482913',
      },
    );
    expect(r.text).toBe('482913');
    expect(r.secretValues).toEqual(['482913']);
  });

  it('flow inputText with ${SWIPIUM_VERIFICATION_CODE} is parsed as secret', () => {
    const p = parseFlow('name: otp\nsteps:\n  - inputText: "${SWIPIUM_VERIFICATION_CODE}"\n');
    expect(p.errors).toEqual([]);
    const step = p.flow!.steps[0] as { kind: string; secret?: boolean };
    expect(step.kind).toBe('inputText');
    expect(step.secret).toBe(true);
  });

  it('qa_act type ${SWIPIUM_VERIFICATION_CODE} registers the value as a session secret', async () => {
    process.env.SWIPIUM_VERIFICATION_CODE = '482913';
    const fake = new FakeDriver(
      dump([{ cls: 'android.widget.EditText', desc: 'Code', id: 'com.example.app:id/code', bounds: [40, 200, 1040, 280] }]),
    );
    const id = await h.start(fake);
    await h.call('qa_snapshot', { sessionId: id });
    const res = await h.call('qa_act', { sessionId: id, action: 'type', target: { id: 'code' }, text: '${SWIPIUM_VERIFICATION_CODE}' });
    expect(structured(res).ok).toBe(true);
    expect(fake.got('inputText')[0].a).toEqual(['482913']);
    expect(h.sessions.get(id)!.secrets.has('482913')).toBe(true);
    expect(JSON.stringify(res)).not.toContain('482913');
  }, 20_000);
});
