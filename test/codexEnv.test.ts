// Codex passes stdio MCP servers only a fixed env whitelist plus `env_vars` / `env` from
// [mcp_servers.swipium]. qa_doctor explains that (and flags a missing ANDROID_HOME/JAVA_HOME)
// when the connected client is Codex.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_ENV_VARS, codexEnvChecks, codexEnvVarsLine, isCodexClient } from '../src/lib/codexEnv.js';

// Every doctor probe goes through lib/spawn.run(): make all binaries "missing" so the test is hermetic.
vi.mock('../src/lib/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/spawn.js')>();
  return {
    ...actual,
    run: vi.fn(async (cmd: string) => {
      if (cmd === 'which' || cmd === 'where') return { code: 1, stdout: '', stderr: '', timedOut: false };
      throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    }),
  };
});

const { createServer } = await import('../src/server.js');

async function doctorAs(
  clientName: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; payload: Record<string, unknown> }> {
  const { server } = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '0.146.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name: 'qa_doctor', arguments: { platform: 'android', ...args } })) as CallToolResult;
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { text, payload: res.structuredContent as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

afterAll(() => {
  vi.restoreAllMocks();
});

describe('codex env whitelist', () => {
  it('detects the Codex client by its clientInfo name', () => {
    expect(isCodexClient('codex-mcp-client')).toBe(true);
    expect(isCodexClient('claude-code')).toBe(false);
    expect(isCodexClient(undefined)).toBe(false);
  });

  it('env_vars line is valid-looking TOML and lists the toolchain + test vars', () => {
    const line = codexEnvVarsLine();
    expect(line).toMatch(/^env_vars = \["[A-Z_]+"(, "[A-Z_]+")*\]$/);
    for (const n of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'SWIPIUM_TEST_EMAIL', 'SWIPIUM_REQUIRE_ELICITATION']) {
      expect(CODEX_ENV_VARS).toContain(n);
    }
    expect(new Set(CODEX_ENV_VARS).size).toBe(CODEX_ENV_VARS.length);
  });

  it('never forwards names that grant approval (operators set those literally in env = { ... })', () => {
    for (const n of CODEX_ENV_VARS) {
      expect(n.startsWith('SWIPIUM_CONSENT_PREAPPROVE'), n).toBe(false);
    }
    expect(CODEX_ENV_VARS).not.toContain('SWIPIUM_ALLOW_REMOTE_WDA');
  });

  it('flags ANDROID_HOME and JAVA_HOME only when the SDK/JDK is not found at the defaults', () => {
    const [env] = codexEnvChecks({ env: {}, androidSdkFound: false, javaFound: false });
    expect(env.ok).toBe(false);
    expect(env.optional).toBe(true);
    expect(env.detail).toContain('Android SDK / JDK not found');
    expect(env.detail).toContain(
      'If you installed the Android SDK / JDK in a custom location, forward ANDROID_HOME / JAVA_HOME via env_vars',
    );
    expect(env.detail).toContain('install them first');
    expect(env.fix).toContain('env_vars = [');
    expect(env.fix).toContain('never forwarded');

    expect(codexEnvChecks({ env: {}, androidSdkFound: true, javaFound: true })[0].ok).toBe(true);
    expect(codexEnvChecks({ env: {}, androidSdkFound: null, javaFound: null })[0].ok).toBe(true);
    expect(codexEnvChecks({ env: { ANDROID_SDK_ROOT: '/sdk', JAVA_HOME: '/jdk' }, androidSdkFound: false, javaFound: false })[0].ok).toBe(
      true,
    );
  });

  it('reports which forwarded names are visible and always advises tool_timeout_sec >= 600', () => {
    const checks = codexEnvChecks({ env: { SWIPIUM_TEST_EMAIL: 'a@b.c' }, androidSdkFound: true, javaFound: true });
    expect(checks[0].detail).toContain('Seen here: SWIPIUM_TEST_EMAIL');
    expect(checks[0].detail).not.toContain('a@b.c');
    const timeout = checks.find((c) => c.name === 'codex-tool-timeout');
    expect(timeout?.detail).toContain('tool_timeout_sec = 600');
  });
});

describe('qa_doctor under Codex', () => {
  it('adds the codex-env and codex-tool-timeout rows plus the env_vars line for codex-mcp-client', async () => {
    const { text, payload } = await doctorAs('codex-mcp-client');
    const names = (payload.checks as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('codex-env');
    expect(names).toContain('codex-tool-timeout');
    expect(text).toContain('env_vars = [');
    expect((payload.codex as { envVarsLine: string }).envVarsLine).toBe(codexEnvVarsLine());
  });

  it('stays quiet for other clients unless client:"codex" is passed', async () => {
    const other = await doctorAs('claude-code');
    expect((other.payload.checks as Array<{ name: string }>).map((c) => c.name)).not.toContain('codex-env');
    expect(other.payload.codex).toBeUndefined();
    const hinted = await doctorAs('claude-code', { client: 'codex' });
    expect((hinted.payload.checks as Array<{ name: string }>).map((c) => c.name)).toContain('codex-env');
  });
});

describe('docs stay in step with the env_vars list', () => {
  it('docs/mcp-server.md shows the exact env_vars line init writes', () => {
    expect(readFileSync(new URL('../docs/mcp-server.md', import.meta.url), 'utf8')).toContain(codexEnvVarsLine());
  });
});

// Every env name src/ reads must either be forwarded by default or be deliberately excluded here.
// Generated-code strings in src/automationGen (the emitted Appium/WebdriverIO suites read their
// own env) are not Swipium reads and are skipped.
describe('CODEX_ENV_VARS completeness', () => {
  const EXCLUDED: Record<string, string> = {
    // Granting: forwarding would let an inherited export or direnv in a cloned repo approve actions.
    SWIPIUM_CONSENT_PREAPPROVE: 'grants approval; set literally in env = { ... }',
    SWIPIUM_CONSENT_PREAPPROVE_RUN_CODE: 'grants approval; set literally in env = { ... }',
    SWIPIUM_ALLOW_REMOTE_WDA: 'grants remote WDA; set literally in env = { ... }',
    // Set by the client itself or only meaningful in-process/tests.
    CLAUDE_PROJECT_DIR: 'Claude Code sets it; Codex never does',
    SWIPIUM_DISABLE_DEVICE_DISCOVERY: 'test-only switch',
    CODEX_HOME: 'read by the `swipium init codex` CLI, not the server',
    // Already in Codex's own whitelist, or Windows-only defaults.
    HOME: 'Codex whitelist',
    PATH: 'Codex whitelist',
    USER: 'Codex whitelist',
    SHELL: 'Codex whitelist',
    TMPDIR: 'Codex whitelist',
    LANG: 'Codex whitelist',
    LOCALAPPDATA: 'Windows default SDK location',
    USERPROFILE: 'Windows home',
  };

  function envReads(): Set<string> {
    const names = new Set<string>();
    const re = /\b(?:process\.)?env(?:\.([A-Z][A-Z0-9_]+)|\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\])/g;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'automationGen') walk(p);
        } else if (name.endsWith('.ts')) {
          for (const m of readFileSync(p, 'utf8').matchAll(re)) names.add(m[1] ?? m[2]);
        }
      }
    };
    walk(fileURLToPath(new URL('../src', import.meta.url)));
    return names;
  }

  it('every env name read in src/ is forwarded or explicitly excluded', () => {
    const reads = envReads();
    expect(reads.size).toBeGreaterThan(10);
    const unaccounted = [...reads].filter((n) => !CODEX_ENV_VARS.includes(n) && !(n in EXCLUDED)).sort();
    expect(unaccounted, 'add to CODEX_ENV_VARS, or to EXCLUDED with a reason').toEqual([]);
  });

  it('the exclusions and the forwarded list do not overlap', () => {
    for (const n of Object.keys(EXCLUDED)) expect(CODEX_ENV_VARS, n).not.toContain(n);
  });
});
