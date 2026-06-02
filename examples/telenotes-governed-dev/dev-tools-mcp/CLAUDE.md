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

1. **Fixed binary + argv, no shell.** Each tool runs a fixed binary (`bun` /
   `git`) with a fixed argument shape via `Bun.spawn` (an argv array, never a
   shell string), so tool inputs cannot inject extra commands or arguments.
   Inputs are Zod-validated. **What this does NOT claim:** `shell_test` runs the
   workspace's *own* test suite, so it executes whatever test code lives there —
   it is an audit/governance boundary, not an OS sandbox against the code under
   test. OS-level sandboxing of executed code is deferred (see
   `docs/roadmap.md`). `git_commit` runs with repo hooks disabled
   (`-c core.hooksPath=/dev/null --no-verify`) and host git config neutralised
   (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`), so the workspace cannot
   smuggle code execution through a git hook or a planted `~/.gitconfig`.
2. **No host-env passthrough.** Spawned commands inherit only `PATH`; `HOME` is
   a fresh empty temp directory (so git/bun read no host dotfiles), and git's
   global/system config are disabled. Git identity is pinned with `-c` flags.
   Mirrors the Action Kernel's "no host env to sandboxes" rule.
3. **stdout is the protocol channel.** This is a stdio MCP server. All logging
   goes to stderr; never write to stdout (the same rule guard-mcp follows).
4. **`git_push` never pushes here — and refuses loudly.** It exists purely to be
   the L4 action the policy gate blocks; it opens no network connection and
   mutates no remote. If its implementation is ever reached (called directly, or
   mis-declared below L4), it returns `isError: true` rather than a
   success-shaped no-op, so a trust-level misconfiguration cannot hide behind a
   friendly result.

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
