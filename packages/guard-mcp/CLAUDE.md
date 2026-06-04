# @qmilab/lodestar-guard-mcp — CLAUDE.md

The MCP proxy mode of Lodestar Guard. Sits between any MCP-speaking
agent (Claude Code, Cursor, Aider, raw MCP clients) and one or more
downstream MCP servers. Every `tools/call` the agent makes is routed
through the Action Kernel; every result is routed through the
Cognitive Core. The resulting event log is renderable by
`lodestar report`.

## What lives here

- `src/config.ts` — Zod schema for the proxy config file
  (`ProxyConfig`). Describes downstream servers, per-tool action-
  contract defaults, the event log root, and the auto-approve policy
  ceiling. Every field is explicit; nothing in this package has a
  silent default for a security-relevant setting.
- `src/observation.ts` — registers the `mcp.tool_result@1` observation
  schema in `@qmilab/lodestar-core`'s registry, and the matching
  `MCPToolResultExtractor` for `@qmilab/lodestar-cognitive-core`. The
  extractor emits two distinct claim kinds per result:
  1. **tool_result** quality — "the call to `<tool>(args)` returned
     a CallToolResult with N content blocks of kinds [...]". This is
     trustworthy: it records what the tool said it did.
  2. **external_document** quality — one per text-content-block whose
     payload looks like document content rather than a structured
     status. Hostile content lives here, and the auto-observation
     gate (Round 5) downgrades these so they cannot promote to
     `truth_status: supported` automatically.
- `src/tool-adapter.ts` — at proxy startup, for each tool advertised
  by each downstream MCP server, register a Lodestar `Tool` whose
  `execute()` forwards to the downstream client. Tool names are
  namespaced `mcp.<server>.<tool>` to avoid collisions with built-in
  Lodestar tools.
- `src/downstream.ts` — `DownstreamConnection` wraps one
  `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`.
  Owns the child process's lifecycle.
- `src/upstream.ts` — `UpstreamServer` wraps one
  `@modelcontextprotocol/sdk` `Server` + `StdioServerTransport`.
  Sets `ListTools` and `CallTool` request handlers that delegate
  into the proxy.
- `src/proxy.ts` — `MCPProxy` composes everything: kernel, firewall,
  cognitive core, upstream server, downstream connections,
  event-log writer. Owns the proxy session_id.
- `src/policy-result.ts` — `buildPolicyDeniedResult(reason)`
  synthesises a `CallToolResult` with `isError: true` and a
  structured `_lodestar` payload describing why. Returning a result
  rather than an MCP-level error lets the wrapped agent reason
  about the denial and re-plan.
- `src/bin/spike.ts` — protocol verification spike. Spawns a real
  downstream MCP server, lists its tools, calls one. No Lodestar
  wiring. Run with `bun run --filter @qmilab/lodestar-guard-mcp
  spike`. Useful as a smoke test that the SDK + transport still
  work as expected; not part of the proxy's normal runtime path.

## Invariants

1. **No silent stubs for session/project (Round 5).** The proxy
   takes the real session_id/project_id from its host
   (`lodestar guard mcp-proxy --session-id ...` or generated once
   per proxy run and propagated). Every Observation and event-log
   envelope carries those values. There is no `session-stub` /
   `project-stub` fallback path — those exist only for test
   fixtures elsewhere in the workspace.

2. **The proxy does not think.** It routes tool calls and ingests
   results; it never issues its own LLM call. Cognitive Core does
   claim extraction (deterministically, schema-bound). Adding LLM
   calls inside the proxy would defeat the architectural separation
   between the agent runtime (which thinks) and the trust layer
   (which records).

3. **Two-phase execution survives the proxy.** Every inbound MCP
   `tools/call` becomes a Lodestar `Action`: `propose → arbitrate →
   execute`. Precondition revalidation, contract clamping, and the
   policy gate all run before the downstream tool is invoked. If
   arbitration denies, the downstream call is not made.

4. **Evidence quality is preserved across the MCP boundary.** A
   tool result is `tool_result` evidence. Document text inside
   that result (file contents, web page, anything the model would
   parse for facts) is `external_document` evidence. The
   `MCPToolResultExtractor` emits both claim kinds; the firewall's
   auto-observation gate prevents `external_document` claims from
   promoting to `truth_status: supported` without the appropriate
   higher-authority confirmation.

5. **Policy denials become synthetic tool results, not protocol
   errors.** When the kernel denies an action, the upstream agent
   receives a `CallToolResult` with `isError: true` and a
   structured payload. This is the contract: the agent can reason
   about denial and re-plan, instead of seeing a transport-level
   failure that most agents would treat as a fatal abort. The
   three-valued gate's **hold** (an L4 tool the trust-ladder floor
   always parks at `pending_approval`) reuses the same machinery: the
   proxy emits `approval.requested@1` and returns a synthetic result
   with `kind: "approval_required"`, which the agent reads as a normal
   tool response and re-plans around — never a transport error. v0 here
   surfaces the hold *immediately* (a soft denial to re-propose); the
   deadline + out-of-band resolution loop (poll for an
   `approval.granted@1` up to a timeout, else `approval_timeout`) is the
   next host-wiring slice. `auto_approve_ceiling` caps at L3 — auto-
   approving L4 is not expressible (the floor always holds it).

6. **Stdio only for v0.** HTTP/SSE transports for the proxy's
   upstream face are deferred. The downstream client side uses
   stdio (spawning the downstream MCP server as a child process).
   HTTP comes in a later batch when the deployment story needs it.

7. **One proxy, one wrapped agent, one event log.** The proxy is
   not multi-tenant. Multi-tenancy is out of scope here — it would be a
   separate layer above this, not part of this package.

8. **No `console.log`.** The event log is the observability
   channel. If you need debugging output during development, gate
   it behind an env-var-controlled debug helper that writes to
   `stderr` only — never to `stdout`, which the upstream MCP
   client owns.

9. **The proxy never opens a database connection.** Durable
   persistence is wired by *injecting* already-constructed stores
   (`MCPProxyOverrides.stores`), never by the proxy reaching for
   `bun:sql` itself. This keeps the Postgres dependency out of this
   package's import graph and leaves connection lifecycle with the
   host that owns the process (the CLI). A `persistence: postgres`
   config that reaches the proxy with no injected stores is a wiring
   bug and `start()` throws rather than silently running in-memory.

## Persistence

By default the proxy builds fresh in-memory firewall stores per
session — all a single-session audit needs. For cross-session state
(two proxy runs that see each other's beliefs), point it at Postgres.

There are two ways in, and they meet at the same seam:

- **Injected stores** (`MCPProxyOverrides.stores`): pass
  `{ claims, beliefs, evidence }` built from
  `createPostgresStores(...)` (`@qmilab/lodestar-memory-firewall/postgres`).
  The proxy uses them verbatim and treats them as caller-owned — it
  never calls `ensureSchema()` or `close()`. This is the seam the
  `tool-poisoning-cross-session` probe drives directly.
- **Config-driven** (`ProxyConfig.persistence`): set
  `{ backend: "postgres", connection_string_env: "LODESTAR_DATABASE_URL" }`.
  The connection string is read from the *named environment variable*,
  never embedded in the config file (a DSN usually carries a password;
  secrets stay in the environment, off disk and out of VCS). The
  `lodestar guard mcp-proxy` CLI resolves the variable, constructs the
  Postgres stores, `ensureSchema()`s them, injects them via the seam
  above, and `close()`s the connection when the session ends (clean
  exit, error, or signal). The proxy itself only validates the field
  and refuses to run a `postgres` config without injected stores.

Omitting `persistence` (or `{ backend: "memory" }`) is the in-memory
default. The field is optional, so existing configs are unchanged.

## Tool registration model

Each downstream MCP tool is registered as a Lodestar `Tool` at proxy
startup. The mapping is:

| MCP tool field | Lodestar Tool field | Source |
| --- | --- | --- |
| `name` | `name` (as `mcp.<server>.<tool>`) | namespaced at registration |
| `inputSchema` | `inputs` (as `z.record(z.unknown())`) | passthrough; downstream re-validates |
| n/a | `output_schema_key` | always `mcp.tool_result@1` |
| `annotations.destructive_hint` (untrusted) | `reversibility` | config override or conservative default |
| `annotations.read_only_hint` (untrusted) | `effects`, `permissions`, `sandbox` | config override or conservative default |

Why we ignore MCP `annotations` by default: the MCP spec explicitly
marks them as untrusted unless the server is itself trusted. The
proxy's job is to enforce a policy that survives a hostile downstream
server, so it pulls action-contract values from the operator-controlled
config (`tool_defaults`) rather than from the wire.

If a downstream tool has no config override, the proxy applies the
**conservative defaults**:
- `reversibility: "irreversible"`
- `blast_radius: "host"`
- `permissions: ["fs.read", "fs.write", "shell.exec", "network.egress"]`
- `sandbox: "controlled-shell"`
- `required_trust_level: 3` (L3: write-locally)

These defaults force operators to explicitly opt-in for any tool they
want auto-approved at lower trust levels.

## What does not live here

- The `lodestar guard mcp-proxy` CLI entry point — lives in
  `@qmilab/lodestar-cli`.
- The `claude-code-wrapped` end-to-end example — lives in
  `examples/claude-code-wrapped/`.
- Probes — live in `packs/lodestar-core/probes/`.
- HTTP transport for the upstream face — Batch later.
- Sentinel hooks observing the proxy's event stream —
  `@qmilab/lodestar-harness`, Batch 4.

## When you change the proxy

- The `MCPProxy` constructor's expected `KernelContext` shape is
  part of the public API. Do not silently change which fields are
  required.
- Tool namespacing (`mcp.<server>.<tool>`) is event-log-visible. A
  rename here breaks downstream report rendering and any sentinel
  that pattern-matches on tool names.
- Adding new conservative defaults: bias toward stricter. A new
  default that lowers required trust without operator opt-in is a
  bug, not an improvement.
- The two new probes (`mcp-proxy-roundtrip`,
  `mcp-proxy-injection-defense`) must keep passing. The injection
  probe is the strategically important one: if a change to the
  proxy ever makes it pass without exercising the
  external_document downgrade path, that's a probe bug, not a
  proxy improvement.
