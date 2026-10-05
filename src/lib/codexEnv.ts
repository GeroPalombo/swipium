// Codex does not hand its parent environment to stdio MCP servers. Verified with Codex 0.146:
// the server only gets a fixed whitelist (HOME, LANG, LC_ALL, LOGNAME, PATH, SHELL, TERM, TMPDIR,
// USER, __CF_USER_TEXT_ENCODING and the CA cert vars), plus the names listed in `env_vars = [...]`
// and the `env = {...}` table of [mcp_servers.<name>] in ~/.codex/config.toml. So SWIPIUM_TEST_*,
// SWIPIUM_* config, ANDROID_HOME and JAVA_HOME exported in the user's shell never reach Swipium
// unless they are forwarded explicitly. `swipium init codex` writes the env_vars line below and
// qa_doctor explains the whitelist when the connected client is Codex.
//
// Deliberately NOT forwarded: names that GRANT approval (SWIPIUM_CONSENT_PREAPPROVE*,
// SWIPIUM_ALLOW_REMOTE_WDA). Forwarding them would let an inherited shell export, or a
// per-directory env tool such as direnv in a cloned repo, pre-approve actions. Operators who want
// them set them literally in the `env = { ... }` table. test/codexEnv.test.ts keeps this list in
// step with every env name src/ reads.

/** The clientInfo.name Codex sends in `initialize`. */
export const CODEX_CLIENT_NAME = 'codex-mcp-client';

/** Env names Swipium reads that a Codex user would typically export in their shell. Forwarded via
 *  `env_vars`; names that are unset in the parent env are simply not passed. */
export const CODEX_ENV_VARS: readonly string[] = [
  // Test credentials / flow variables (flows read any SWIPIUM_* name; add custom ones yourself).
  'SWIPIUM_TEST_EMAIL',
  'SWIPIUM_TEST_USERNAME',
  'SWIPIUM_TEST_PASSWORD',
  'SWIPIUM_TEST_OTP',
  'SWIPIUM_TEST_PIN',
  'SWIPIUM_TEST_TOKEN',
  'SWIPIUM_TEST_DEEP_LINK',
  'SWIPIUM_VERIFICATION_CODE',
  // Server config.
  'SWIPIUM_PROJECT_ROOT',
  'SWIPIUM_REQUIRE_ELICITATION', // only restricts, so safe to inherit
  'SWIPIUM_LOG_LEVEL',
  'SWIPIUM_OCR_CMD',
  'SWIPIUM_VISUAL_MASK_CMD',
  'SWIPIUM_RETENTION_DAYS',
  'SWIPIUM_RETENTION_KEEP',
  // Toolchain.
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_SDK_HOME',
  'ANDROID_USER_HOME',
  'ANDROID_AVD_HOME',
  'ANDROID_EMULATOR_HOME',
  'JAVA_HOME',
  'JAVA_TOOL_OPTIONS',
  'GRADLE_USER_HOME',
  'GRADLE_OPTS',
  'BUNDLETOOL_JAR',
  'APPIUM_HOME',
  'DEVELOPER_DIR',
  'DEVELOPMENT_TEAM',
  'XCODE_DEVELOPMENT_TEAM',
  'WDA_PROJECT_PATH',
  'WEBDRIVERAGENT_PROJECT',
  // Network (Gradle/npx downloads behind a proxy).
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // CI detection + source revision for reports and the issue ledger.
  'CI',
  'GITHUB_SHA',
  'GITHUB_REF_NAME',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'CI_COMMIT_SHA',
  'CI_COMMIT_REF_NAME',
  'CI_PIPELINE_URL',
  'BITBUCKET_COMMIT',
  'BITBUCKET_BRANCH',
];

/** The TOML line for [mcp_servers.swipium]. */
export function codexEnvVarsLine(names: readonly string[] = CODEX_ENV_VARS): string {
  return `env_vars = [${names.map((n) => JSON.stringify(n)).join(', ')}]`;
}

export function isCodexClient(clientName: string | undefined): boolean {
  return clientName === CODEX_CLIENT_NAME;
}

export interface CodexEnvCheckInput {
  env: NodeJS.ProcessEnv;
  /** An Android SDK dir exists (env var or OS default), or adb resolved on PATH. null = not probed. */
  androidSdkFound: boolean | null;
  /** `java -version` worked. null = not probed. */
  javaFound: boolean | null;
}

export interface CodexEnvCheck {
  name: string;
  ok: boolean;
  optional: true;
  detail: string;
  fix?: string;
}

/** qa_doctor rows for a Codex client: the env whitelist and the tool timeout advice. */
export function codexEnvChecks(input: CodexEnvCheckInput): CodexEnvCheck[] {
  const { env } = input;
  const missing: string[] = [];
  if (input.androidSdkFound === false && !env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) missing.push('ANDROID_HOME');
  if (input.javaFound === false && !env.JAVA_HOME) missing.push('JAVA_HOME');
  const forwarded = CODEX_ENV_VARS.filter((n) => env[n] != null && env[n] !== '');
  const base =
    'Codex passes stdio MCP servers only a fixed env whitelist (HOME, PATH, SHELL, USER, TMPDIR, LANG...) plus the names in ' +
    '`env_vars` and the `env` table of [mcp_servers.swipium]; shell exports like SWIPIUM_TEST_*, ANDROID_HOME and JAVA_HOME do not reach Swipium otherwise.';
  const seen = forwarded.length ? ` Seen here: ${forwarded.join(', ')}.` : ' None of the Swipium env names are set in this server.';
  const what = missing.map((m) => (m === 'JAVA_HOME' ? 'JDK' : 'Android SDK')).join(' / ');
  const custom = missing.length
    ? `${what} not found by this server (${missing.join(' and ')} unset). If you installed the ${what} in a custom location, forward ${missing.join(' / ')} via env_vars; if ${missing.length > 1 ? 'they are' : 'it is'} not installed, install ${missing.length > 1 ? 'them' : 'it'} first. `
    : '';
  return [
    {
      name: 'codex-env',
      ok: missing.length === 0,
      optional: true,
      detail: `${custom}${base}${seen}`,
      fix:
        `Add under [mcp_servers.swipium] in ~/.codex/config.toml: ${codexEnvVarsLine()} (or set values in env = { ... }), then restart Codex. ` +
        'Approval grants (SWIPIUM_CONSENT_PREAPPROVE, SWIPIUM_ALLOW_REMOTE_WDA) are never forwarded: set them literally in env = { ... }.',
    },
    {
      name: 'codex-tool-timeout',
      ok: true,
      optional: true,
      detail:
        'Codex defaults to 60 s per tool call, too short for builds, boots and flows. The server cannot read it: make sure ' +
        '[mcp_servers.swipium] has tool_timeout_sec = 600 (or more) and startup_timeout_sec = 30 (`swipium init codex` writes both).',
    },
  ];
}
