# @qmilab/lodestar-guard-mcp

**MCP proxy mode for Lodestar Guard.** Wrap any MCP-speaking agent
(Claude Code, Cursor, Aider, raw MCP clients) so every tool call
passes through Lodestar's Action Kernel and every result through the
Cognitive Core. The resulting event log renders into a trust report
with `lodestar report`.

Part of [Lodestar](https://qmilab.com/lodestar), the trust layer for
AI agents.

> **Status (Batch 3):** stdio transport only. HTTP/SSE for the
> upstream face is deferred. Single-tenant: one proxy instance, one
> wrapped agent, one event log.

## What it does

```
┌──────────────┐ stdio MCP ┌─────────────────┐ stdio MCP ┌──────────────────┐
│ Wrapped      │──────────▶│ Lodestar        │──────────▶│ Downstream       │
│ MCP agent    │           │ guard-mcp proxy │           │ MCP server(s)    │
│ (Claude Code,│◀──────────│  • ActionKernel │◀──────────│ (filesystem, git,│
│  Cursor,     │           │  • CognitiveCore│           │  github, ...)    │
│  Aider, ...) │           │  • EventLog     │           │                  │
└──────────────┘           └─────────────────┘           └──────────────────┘
                                    │
                                    ▼
                          .lodestar/events/*.ndjson
                                    │
                                    ▼
                            lodestar report
```

For every `tools/call` the wrapped agent makes:

1. **Propose** — proxy builds a Lodestar `ActionContract` from
   operator-controlled `tool_defaults` (not from untrusted MCP
   annotations).
2. **Arbitrate** — `PolicyGate` decides approve / deny. If denied,
   the proxy returns a synthetic `CallToolResult` with `isError:
   true` and a structured `_lodestar` payload so the agent can
   reason about the denial and re-plan, rather than seeing a
   transport-level failure.
3. **Execute** — preconditions are re-validated, then the call is
   forwarded to the appropriate downstream MCP server.
4. **Ingest** — the downstream's `CallToolResult` becomes a Lodestar
   `Observation`. The Cognitive Core's `MCPToolResultExtractor`
   emits two claim kinds:
   - `tool_result` quality — what the tool said it did.
   - `external_document` quality — document text inside the result.
     The Memory Firewall's auto-observation gate (Round 5) prevents
     these from auto-promoting to `truth_status: supported`.

## Install

```bash
bun add @qmilab/lodestar-guard-mcp
```

This package has a runtime peer on `@modelcontextprotocol/sdk` ≥ 1.29.

## Quick start

```ts
import { MCPProxy, loadProxyConfig } from "@qmilab/lodestar-guard-mcp"

const config = await loadProxyConfig("./lodestar-mcp-proxy.config.json")
const proxy = new MCPProxy(config)
await proxy.start()  // blocks; receives MCP on stdin/stdout
```

The headline path is the CLI:

```bash
lodestar guard mcp-proxy --config ./lodestar-mcp-proxy.config.json
# then in another shell:
lodestar report latest
```

## Config file

```jsonc
{
  "project_id": "telenotes-dev",
  "actor_id": "agent:claude-code",
  "session_id": "auto",                    // or pin one
  "log_root": ".lodestar/events",
  "default_scope": { "level": "project", "identifier": "telenotes-dev" },
  "default_sensitivity": "internal",
  "auto_approve_ceiling": 2,
  "downstream_servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"]
    }
  ],
  "tool_defaults": {
    "mcp.filesystem.read_file": {
      "reversibility": "reversible",
      "blast_radius": "self",
      "permissions": ["fs.read"],
      "sandbox": "read",
      "required_trust_level": 0
    },
    "mcp.filesystem.write_file": {
      "reversibility": "irreversible",
      "blast_radius": "project",
      "permissions": ["fs.read", "fs.write"],
      "sandbox": "write-local",
      "required_trust_level": 3
    }
  },
  // Optional. Omit (or use { "backend": "memory" }) for the in-memory,
  // single-session default. Use "postgres" to share durable belief/claim/
  // evidence state across sessions — the connection string is read from
  // the named env var, never embedded here (it usually carries a password).
  "persistence": {
    "backend": "postgres",
    "connection_string_env": "LODESTAR_DATABASE_URL"
  }
}
```

Tools that the downstream server advertises but the config does not
mention fall through to a conservative default (`irreversible`,
`controlled-shell` sandbox, L3 trust). That biases the proxy toward
"refuse unless approved" rather than "approve unless caught."

When `persistence.backend` is `postgres`, the CLI resolves the named
environment variable, opens the Postgres-backed firewall stores
(`@qmilab/lodestar-memory-firewall/postgres`), ensures their schema,
and closes the connection when the session ends. Two proxy sessions
pointed at the same database see each other's beliefs — the substrate
the `tool-poisoning-cross-session` probe exercises.

## License

Apache-2.0. See `LICENSE`.
