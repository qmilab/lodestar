# dev-tools-mcp — CLAUDE.md

A first-party MCP server exposing the write-side developer actions the
Telenotes governed-dev demo needs: `shell_test`, `git_commit`, `git_push`.
The Lodestar MCP proxy spawns it as a downstream child process alongside the
official `@modelcontextprotocol/server-filesystem` (which supplies the read +
file-write tools). Together they give a wrapped coding agent the full
observe → edit → test → commit → push surface, every call governed.

## Why this exists

The proxy can only govern tools that come from **downstream MCP servers**
(namespaced `mcp.<server>.<tool>`). Native Lodestar `guard.wrap()` adapters are
not reachable through the proxy, so the demo's writes/tests/commits must be MCP
tools. The official filesystem server covers file writes; this server covers
test/commit/push.

Three **distinct** tools (not one generic `shell.run`) is deliberate: the
proxy's policy gate assigns trust per tool name. Distinct tools let the operator
auto-approve `shell_test`/`git_commit` at L3 while blocking `git_push` at L4 —
the demonstrable teeth of the policy gate. A single shell tool would collapse
all three into one trust level.

## Invariants

1. **Allowlisted only.** Each tool runs a fixed command shape. There is no
   arbitrary command execution — `shell_test` runs only `bun test`, the git
   tools run only the specific git subcommands. Inputs are Zod-validated.
2. **No host-env passthrough.** Spawned commands see a scoped environment
   (`PATH`, `HOME` only), mirroring the Action Kernel's "no host env to
   sandboxes" rule. Git identity is pinned with `-c` flags so commits do not
   depend on — or read — the host's global git config.
3. **stdout is the protocol channel.** This is a stdio MCP server. All logging
   goes to stderr; never write to stdout (the same rule guard-mcp follows).
4. **`git_push` never pushes here.** It is a no-op that exists purely to be the
   L4 action the policy gate blocks. Even if invoked directly it must not open a
   network connection or mutate a remote.

## Files

- `server.ts` — `buildDevToolsServer(workspace)`: the `Server` with the three
  tool handlers, bound to a workspace directory.
- `bin.ts` — stdio entry the proxy spawns: `bun run bin.ts <workspace>`.
- `smoke.ts` — protocol smoke check (spawn, list, exercise all three). Mirrors
  guard-mcp's `spike.ts`; no Lodestar wiring. `bun run smoke.ts`.

## Graduation path

This server lives under the example for now because its allowlist is
demo-shaped (only `bun test`; a throwaway local repo with no remote). It is the
natural seed for the roadmapped `packages/adapters/shell/` and
`packages/adapters/github/`. Graduating it means generalizing the sandbox /
reversibility story (configurable command allowlists, real remote handling,
scoped credentials) and moving it under `packages/` — at which point it is no
longer example-specific and the CLAUDE.md "no example code in packages/" rule
is satisfied. Until that generalization is done, keeping it here keeps the
demo honest about how narrowly scoped these tools are.
