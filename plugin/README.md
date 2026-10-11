# Swipium Claude Code plugin

A Claude Code plugin that bundles the Swipium MCP server and the `swipium-qa` agent skill. The
repository root has a plugin marketplace (`.claude-plugin/marketplace.json`), so in Claude Code:

```text
/plugin marketplace add GeroPalombo/swipium
/plugin install swipium@swipium
```

| File | What it does |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest. |
| `.mcp.json` | Registers the server as `npx -y swipium` with `SWIPIUM_MAX_WAIT_MS=110000`, so one `qa_test_this {waitForCompletion:true}` or `qa_job_status` call can wait up to 110 s. |
| `skills/swipium-qa/SKILL.md` | The agent skill: the `qa_test_this` loop, batching with `qa_flow_run {flowYaml}`, credentials via env, app-control shortcuts, and the CI CLI. |

The plugin never pre-approves consent: every build, boot and install still asks you. To pre-approve
the actions that run no project code on your own machine, use
`npx -y swipium init claude --trust-local` instead (local or user scope only).

The skill file is generated from `src/skills/content.ts`. Don't edit it here: change the source and
run `SWIPIUM_UPDATE_SKILL=1 npx vitest run test/guidanceSkill.test.ts`, which rewrites this copy and
`skills/swipium-qa/SKILL.md`.

Without the plugin, `swipium init claude --apply` registers the same server and installs the same
skill. See [docs/mcp-server.md](../docs/mcp-server.md#claude-code).
