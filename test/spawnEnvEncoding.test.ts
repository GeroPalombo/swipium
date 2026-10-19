// run() decodes child output as a UTF-8 stream (a character split across two chunks stays
// intact) and keeps the server's test credentials out of every child's environment unless the
// caller opts in (a project's seed script). Real spawns of `node`.

import { afterEach, describe, expect, it } from 'vitest';
import { childEnv, isSecretEnvName, run, runBinary } from '../src/lib/spawn.js';

const NODE = process.execPath;
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('run() output decoding', () => {
  it('keeps a multibyte character split across two stdout chunks', async () => {
    // "€" is e2 82 ac: write the first two bytes, then the last one in a later chunk.
    const script = 'process.stdout.write(Buffer.from([0xe2,0x82]));setTimeout(()=>process.stdout.write(Buffer.from([0xac,0x0a])),60)';
    const r = await run(NODE, ['-e', script], { timeoutMs: 10_000 });
    expect(r.stdout).toBe('€\n');
    expect(r.stdout).not.toContain('�');
  });

  it('decodes split stderr the same way (run and runBinary)', async () => {
    const script = 'process.stderr.write(Buffer.from([0xc3]));setTimeout(()=>process.stderr.write(Buffer.from([0xa9])),60)';
    expect((await run(NODE, ['-e', script], { timeoutMs: 10_000 })).stderr).toBe('é');
    expect((await runBinary(NODE, ['-e', script], { timeoutMs: 10_000 })).stderr).toBe('é');
  });
});

describe('child environment', () => {
  it('names the test credentials and secret-like Swipium vars, nothing else', () => {
    for (const k of [
      'SWIPIUM_TEST_EMAIL',
      'SWIPIUM_TEST_PASSWORD',
      'SWIPIUM_TEST_OTP',
      'SWIPIUM_SECRET_API',
      'SWIPIUM_VERIFICATION_CODE',
      'SWIPIUM_OTP_SECRET',
      'SWIPIUM_API_KEY',
    ])
      expect(isSecretEnvName(k)).toBe(true);
    for (const k of [
      'PATH',
      'HOME',
      'ANDROID_HOME',
      'SWIPIUM_LOG_LEVEL',
      'SWIPIUM_EMULATOR_GPU',
      'SWIPIUM_HOME',
      'MY_PASSWORD',
      'SWIPIUM_SHIPPING_ADDRESS',
      'SWIPIUM_BARCODE',
    ])
      expect(isSecretEnvName(k)).toBe(false);
    const env = childEnv({ PATH: '/bin', SWIPIUM_TEST_PASSWORD: 'p', SWIPIUM_LOG_LEVEL: 'debug' });
    expect(env).toEqual({ PATH: '/bin', SWIPIUM_LOG_LEVEL: 'debug' });
    expect(childEnv({ SWIPIUM_TEST_PASSWORD: 'p' }, true)).toEqual({ SWIPIUM_TEST_PASSWORD: 'p' });
  });

  it('a spawned command does not see SWIPIUM_TEST_* by default; inheritSecretEnv passes them', async () => {
    process.env.SWIPIUM_TEST_PASSWORD = 'hunter2';
    process.env.SWIPIUM_TEST_OTP = '123456';
    process.env.SWIPIUM_LOG_LEVEL = 'warn';
    const script =
      'process.stdout.write(JSON.stringify([process.env.SWIPIUM_TEST_PASSWORD ?? null, process.env.SWIPIUM_TEST_OTP ?? null, process.env.SWIPIUM_LOG_LEVEL ?? null]))';
    const plain = await run(NODE, ['-e', script], { timeoutMs: 10_000 });
    expect(JSON.parse(plain.stdout)).toEqual([null, null, 'warn']);
    const grouped = await run(NODE, ['-e', script], { timeoutMs: 10_000, processGroup: true });
    expect(JSON.parse(grouped.stdout)).toEqual([null, null, 'warn']);
    const bin = await runBinary(NODE, ['-e', script], { timeoutMs: 10_000 });
    expect(JSON.parse(bin.stdout.toString('utf8'))).toEqual([null, null, 'warn']);
    const seed = await run(NODE, ['-e', script], { timeoutMs: 10_000, inheritSecretEnv: true });
    expect(JSON.parse(seed.stdout)).toEqual(['hunter2', '123456', 'warn']);
  });
});
