# @qmilab/lodestar-runtime-core

The language-agnostic **governance-gate sidecar** for Lodestar — govern an agent
runtime that does **not** speak MCP (LangGraph, CrewAI, AutoGen) by remoting each
native tool call through the Action Kernel over a thin newline-delimited JSON-RPC
seam. This is the reusable spine of the runtime-adapter epic (ADR-0024): every
framework contributes only a small native hook; the gate server here is shared.

It is **not** a new governance implementation. It wires the *same* `ActionKernel`
two-phase (`propose → arbitrate → execute`), the `CompiledPolicy` gate, the
`CognitiveCore` ingestion, the `SentinelArbiter` decision synthesis, and the
signed-approval / Ed25519 hold path the MCP proxy (`@qmilab/lodestar-guard-mcp`)
already runs. The only genuinely new code is the RPC protocol + the gate server.

## How it works

```
  LangGraph (Python)              lodestar runtime gate (this package, TS)
  ┌────────────────┐   propose    ┌──────────────────────────────────────┐
  │  thin hook     │ ───────────▶ │ ActionKernel.propose → arbitrate      │
  │  wraps the     │              │   (CompiledPolicy gate, SentinelArbiter│
  │  bound toolset │ ◀─────────── │    decision synthesis, L4 hold)        │
  │                │  run_tool    │ ActionKernel.execute → CognitiveCore   │
  │  runs the real │ ───────────▶ │   ingest (external_document gated)     │
  │  tool body     │  tool_result └──────────────────────────────────────┘
  └────────────────┘
```

The hook **does not** run the real tool when it intercepts a call. It sends a
`propose` to the gate; the gate runs `propose → arbitrate`, and **only if
allowed** does `kernel.execute()` fire — whose tool `execute()` is an RPC call
**back** to the hook ("now run tool X"). The tool body therefore runs *only*
inside the TS execute phase, reached only after the gate (and any L4 hold)
clears. "Tools that do work before approval are bugs" — across the language
boundary.

## Load-bearing properties

- **One closed enforcement surface, fail closed.** A call for a tool with no
  compiled contract is **denied**, never allowed. The operator owns every tool
  contract (`RuntimeGateConfig.tool_defaults`); the untrusted hook cannot widen
  its own authority.
- **Two-phase preserved by remoting execution**, idempotent and exactly-once per
  action id (a duplicate resume / retried RPC never double-executes an
  irreversible tool — the gate checks the durable log for a terminal event
  first).
- **Durable, idempotent holds.** Hold/approval state lives in the durable event
  log + the signed `.approvals/` side-channel, keyed by action/request id. Any
  gate instance — a fresh one after a crash, or a different process resuming a
  LangGraph checkpoint later — reconstructs the hold from the log and checks for
  a *signed* resolution. The deadline is fail-closed; a late approval can never
  un-park an expired action.
- **Concurrent by construction.** Every RPC leg carries a correlation id and the
  action id; responses are matched by id, independent of arrival order. Each
  result is ingested exactly once.

## Honest scope (ADR-0004 lineage)

This is **governance over declared actions, not OS containment of the process.**
Raw I/O performed *outside* the tool abstraction (a custom node that calls
`requests.get()` directly instead of a registered tool) is outside the governed
surface, exactly as `guard.wrap()` and the MCP proxy only govern the tools they
are given. Pair it with network/filesystem controls for defense in depth.

## CLI

```
lodestar runtime gate --config <path>
```

The native hook spawns this as a child process and speaks NDJSON-RPC over stdio.
Operator-pinned configuration (the signed policy document, approver keys,
sentinel ids, persistence, durable log root) lives only in the config — the hook
never holds credentials or policy.

The Python hook lives in `runtimes/langgraph/` (published to PyPI, not npm).

Part of [Lodestar](https://qmilab.com/lodestar). Apache-2.0.
