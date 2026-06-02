# telenotes-governed-dev — CLAUDE.md

The primary Batch 5 proving ground: a coding agent, wrapped via the Batch 3 MCP
proxy, adds a feature to **Telenotes** (a tiny Nostr note-publishing module). It
observes the codebase, forms beliefs, plans, edits files, runs tests, and
commits — every tool call governed by the Action Kernel and recorded in the
epistemic chain. `lodestar report` renders the trust report. A second run with a
poisoned file present demonstrates the Memory Firewall blocking the attack.

This directory fulfils the long-promised "week-8 thesis demo" the legacy stub
(`index.ts`, `policy.lodestar.ts`) pointed at.

## Layout

- `fixture/telenotes/` — the self-contained module the agent edits (`note.ts`,
  `publish.ts`, `note.test.ts`). The demo copies it to a throwaway working tree
  before each run, so the agent's edits/commits never touch the committed copy.
- `dev-tools-mcp/` — a first-party MCP server exposing `shell_test`,
  `git_commit`, `git_push`. Spawned by the proxy as a downstream server
  alongside `@modelcontextprotocol/server-filesystem`. See its CLAUDE.md.
- `index.ts`, `policy.lodestar.ts` — the legacy week-1 scaffold (read-only,
  in-process), kept for reference; the runs below are the live demo.
- `scripted-run/` — deterministic in-process driver + committed report.
- `poison-run/` — the firewall-block demo: plants a hostile `DEVELOPMENT.md` and
  self-verifies the firewall holds.
- `real-claude-code/` — recipe + captured evidence from a live Claude Code run.
- `reports/` — committed markdown trust reports.

All of the above have landed; the no-hijack invariant is locked in CI by the
`poisoned-file-cannot-hijack-feature-work` probe (`packs/coding-agent-safety/`).

## Why two downstream servers

The proxy only governs tools that come from downstream MCP servers
(`mcp.<server>.<tool>`); native `guard.wrap()` adapters are unreachable through
it. So the agent's reads/writes/tests/commits are all MCP tools: the official
filesystem server provides read + `write_file`/`edit_file`; the first-party
`dev-tools` server provides test/commit/push. Trust is assigned per tool in the
proxy config's `tool_defaults`, not taken from the wire.

## Discipline

- No Telenotes-specific code leaks into `packages/`. Everything here stays in
  this example (the dev-tools server's graduation path to `packages/adapters/`
  is documented in its CLAUDE.md).
- The fixture is a real, test-backed mini-project, not a mock — the agent's
  `shell_test` runs its actual `bun test`.
- Raw event logs (`.lodestar/`) are gitignored; the rendered trust reports are
  committed as the demo's evidence.

## Run

```sh
bun run --filter @qmilab-examples/telenotes-governed-dev devtools:smoke   # dev-tools server smoke
bun test fixture                                                           # fixture suite
```
