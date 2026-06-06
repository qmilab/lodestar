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
  contract defaults, the event log root, the auto-approve policy
  ceiling (`auto_approve_ceiling`, 0..3), `approval_timeout_ms` (how
  long a held action waits for an out-of-band resolution before timing
  out; 0 = don't wait), and the optional `policy` field (`ProxyPolicyConfig`)
  pointing at a signed declarative `Policy` document that becomes the gate in
  place of the ceiling preset. Every field is explicit; nothing in this package
  has a silent default for a security-relevant setting.
- `src/policy.ts` — `compileProxyPolicy(policyConfig, baseDir)`: loads the
  `ProxyConfig.policy` document off disk, `PolicySchema`-parses it, derives the
  gate's `decider_id` from the signer, and `compile()`s it into the
  `CompiledPolicy` the CLI injects via `MCPProxyOverrides.policyGate`. The file
  I/O + signature verification live here (the host), never in the proxy — the
  same separation `persistence` uses. This is the path that lets a matched
  `require_approval` rule's richer `required_authority` reach proxy holds (the
  ceiling preset only ever holds at the L4 floor with empty authority).
  `compileProxyPolicyWithSentinels(policyConfig, baseDir, sentinels)` is the
  arbitrate-armed sibling: it compiles the same document *with* a
  `SentinelArbiter` (via guard's `compileWithSentinels`) and returns the matched
  `{ gate, arbiter }` pair the CLI injects (ADR-0003). It takes already-resolved
  `Sentinel` instances — the CLI resolves `config.sentinels` ids against the
  harness registry, keeping this package's runtime free of a harness dependency.
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
   always parks at `pending_approval`) reuses the same machinery. The
   proxy emits `action.pending_approval` + `approval.requested@1` (with a
   deadline), then waits up to `approval_timeout_ms` polling the event
   log for an out-of-band `approval.granted@1` / `approval.denied@1`
   (written by the `lodestar approve` CLI or an approval UI):
   - **grant** → un-park via `ActionKernel.resolve()` and run the tool;
   - **deny** → synthetic `approval_denied` result;
   - **deadline passes** → emit `approval.expired@1`, reject, return a
     synthetic `approval_timeout` result;
   - **`approval_timeout_ms` is 0** (don't wait) → return
     `approval_required` immediately (the conservative default).
   Each is a `CallToolResult` with `isError: true` and a `_lodestar`
   marker the agent reads as a normal tool response and re-plans around —
   never a transport error. A timed-out hold is a soft denial the agent
   re-proposes; durable resume of the same approved call is deferred.
   Acceptance is gated on the resolver's *decision time* (≤ the request
   deadline), so a grant dated after the deadline is a timeout, not a late
   approval; the payload is validated before it is trusted; and a torn read is
   tolerated (polling continues). `auto_approve_ceiling` caps at L3 —
   auto-approving L4 is not expressible (the floor always holds it).

   **The opened `ApprovalRequest` carries the matched rule's authority.** When
   the gate is a `CompiledPolicy` (the default ceiling preset, or an injected
   `ProxyConfig.policy`), `resolveProxyHold` re-runs its pure `evaluate()` on the
   parked action to recover a matched `require_approval` rule's
   `required_authority` (`min_trust_baseline` / `scope`) for the request — so a
   declarative policy's authority constraints reach the `lodestar approve`
   authorisation check, not just the action's mapped `sensitivity_clearance`. It
   re-runs only when the re-evaluation still agrees the verdict is a hold (an
   arbitration-escalated hold is invisible to a context-free re-run), otherwise
   it falls back to the parked action's audit (authority `{}`). A bare
   `PolicyGate` override cannot expose this, so a hold under one carries only the
   mapped `sensitivity_clearance`. Mirrors `guard.wrap()`'s `resolveHold`.

   **Two resolution sources, one writer.** `waitForResolution` polls both:
   - an `approval.granted@1` / `approval.denied@1` already **in the log** — the
     *in-process* resolver path (a second `EventLogWriter` in the proxy's own
     process shares the single-writer mutex + seq counter, so it is seq-safe and
     already canonical; the proxy does not re-emit);
   - a resolution file in the **side-channel** — the *separate-process* path the
     `lodestar approve` CLI uses (`approvals-channel.ts`,
     `<log_root>/.approvals/<project>/<request-id>.json`). The CLI never appends
     the log (cross-process `seq`/`logical_clock` would collide — the writer's
     counters are process-local), so the proxy **promotes** it: emits the
     canonical `approval.granted@1` / `approval.denied@1` into its *own* log,
     then consumes the file. The proxy stays the sole writer of its session's
     log; the event-log writer is untouched, the single-writer invariant intact.
     The channel deadline gate is numeric (offset-safe) on the resolver's `at`.
     This is what keeps the separate-process resolver safe without cross-process
     file locking — see the `approval-via-side-channel` probe (sole-writer seq
     integrity is one of its assertions).

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

10. **Sentinels gate via synthesized decisions — opt-in, opaque-agent
    (ADR-0003).** The wrapped MCP agent speaks `tools/call` only; it cannot
    declare which beliefs back its next action. So when a `SentinelArbiter` is
    wired (`MCPProxyOverrides.arbiter`, with `policyGate` compiled from the *same*
    arbiter via `compileProxyPolicyWithSentinels`), the proxy **synthesizes** a
    `decision.made` per action from the arbiter's conservative belief-dependency
    set (`observedBeliefIds()` — every belief observed this session). The set is
    cumulative and **never reduced by execution** (the proxy never removes from
    it): an opaque agent must not be able to drain a later action's obligations via
    a soft-denied retry (Codex round 2) or a low-trust filler call (Codex round 4)
    — every execution-driven shrink is an attacker-controlled drain. Temporal
    scoping still holds (a decision is a point-in-time snapshot, so an action
    proposed before a belief was observed does not depend on it); the cost is
    verbosity (over-linked decisions, repeated alerts), bounded only at session
    end. A bounded set is the deferred F4 item. That gives a belief-scoped sentinel alert
    the `decision.made` it fires on and the gate the `decision_id →
    belief_dependencies` thread it scopes by, so a poisoned-read-then-act sequence
    is held at `pending_approval` through the existing hold path. The synthesized
    decision is attributed to `PROXY_DECISION_SYNTHESIS_ACTOR`
    (`lodestar-proxy-synthesis`), never the agent — a synthesized link must not
    masquerade as an agent-declared one. The arbiter feed lives in `emit` (mirrors
    `guard.wrap()`: surface each landed alert as `sentinel.alerted@1` on the proxy's
    own writer with the sentinel actor + canonical schema version; best-effort, a
    faulty sentinel logs `guard.sentinel.failed` and never aborts the session).
    **Opt-in:** with no arbiter the proxy synthesizes nothing, feeds nothing, and
    its event stream is byte-for-byte unchanged — every existing proxy probe holds.
    **No silent non-enforcement:** a wired sentinel must never be quietly dropped.
    Three guards, each keyed on what it actually requires: the `ProxyConfigSchema`
    superRefine rejects a `sentinels`-without-`policy` config at parse; the
    constructor throws if (A) `config.sentinels` is set but no arbiter was injected,
    and if (B) **an arbiter is injected but the gate is not a `CompiledPolicy`** —
    the default `auto_approve_ceiling` preset and a bare `PolicyGate` have no
    arbitrate hook, so the arbiter's alerts could never hold an action. Guard (B)
    keys on the *arbiter*, not `config.sentinels`, so it also catches a library
    host that wires `MCPProxyOverrides.arbiter` directly. (C) the injected gate
    *is* a `CompiledPolicy` but was compiled from a **different** arbiter (or
    without arbitration): `compileWithSentinels` stamps a shared `bindingToken` on
    both, and the constructor throws on `gate.bindingToken !== arbiter.bindingToken`
    — closing the F6 footgun (a hand-wired mismatch that would observe-but-not-gate).
    And (C-mirror) a **sentinel-compiled gate** (`bindingToken` set) injected with
    no arbiter: the proxy would never feed the gate's arbiter or synthesize
    decisions, so its sentinels would be inert — throw. Same shape as the `policy`
    / `persistence` guards. The proxy never resolves sentinel ids itself; the CLI
    resolves them against `FIRST_PARTY_SENTINELS` and injects the matched
    `{ gate, arbiter }` pair.
    Because nothing is ever removed, there is no consume/drain race; the only
    concurrency effect is over-linking (the safe direction), the documented
    best-effort posture in ADR-0003. The `mcp-proxy-arbiter-gates-dependent-action`
    probe pins all of this end-to-end — including that a re-proposed held edit
    stays held and that an action proposed before the poison is not gated; it must
    keep passing.

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
- The `SentinelArbiter` itself — `@qmilab/lodestar-guard` (ADR-0001). This package
  *uses* it (wires the feed + synthesizes decisions, see invariant 10); the
  reusable bridge and the `observedBeliefIds()` belief-dependency set live in
  guard.
- Resolving sentinel **ids** (`config.sentinels`) against the
  `FIRST_PARTY_SENTINELS` registry — the CLI does that and passes resolved
  `Sentinel` instances to `compileProxyPolicyWithSentinels`, so this package never
  imports `@qmilab/lodestar-harness` at runtime.

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
