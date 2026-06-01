# Telenotes dev-tools MCP server

A small MCP server that exposes the write-side developer actions a governed
coding agent needs: running tests, committing, and pushing. The Lodestar MCP
proxy spawns it as a downstream server, so every call flows through the Action
Kernel and the policy gate.

| Tool         | What it does                                  | Demo trust level |
| ------------ | --------------------------------------------- | ---------------- |
| `shell_test` | Runs `bun test` in the workspace              | L3 (auto-approve)|
| `git_commit` | `git add -A` + commit with the given message  | L3 (auto-approve)|
| `git_push`   | No-op stand-in; exists to be policy-blocked   | L4 (denied)      |

Paired with `@modelcontextprotocol/server-filesystem` (read + `write_file` /
`edit_file`), these give the agent the full observe → edit → test → commit
surface. See `../CLAUDE.md` for how the proxy maps these to action contracts.

## Run

Spawned by the proxy via config (see the demo's `proxy.config.json`). To run it
directly for a smoke check:

```sh
bun run smoke.ts
```

This spawns the server against a throwaway git workspace, lists its tools, and
exercises all three.
