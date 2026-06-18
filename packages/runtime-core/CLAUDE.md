# @qmilab/lodestar-runtime-core — CLAUDE.md

The language-agnostic **governance-gate sidecar** — the reusable TS spine of the
runtime-adapter epic (ADR-0024 / ADR-0025, #75 / #83). It governs an agent runtime
that does **not** speak MCP (LangGraph first; CrewAI #84, AutoGen #85 next) by
remoting each native tool call through the Action Kernel over a thin NDJSON-RPC
seam. Each framework contributes only a small native hook (in `runtimes/`); the
gate server here is shared.

This is **not** a new governance implementation. It wires the *same* engine the
MCP proxy runs — `ActionKernel` two-phase, the `CompiledPolicy` gate,
`CognitiveCore.ingest`, `SentinelArbiter` + `observedBeliefIds` decision
synthesis, and the signed-approval / Ed25519 hold path. The genuinely new code is
the RPC protocol + the gate server. No core schema change, no kernel change.

## What lives here

- `src/protocol.ts` — the NDJSON-RPC message types (ADR-0024 §6). Inbound
  (hook→gate) messages are Zod-validated (the hook is untrusted); outbound
  (gate→hook) are gate-authored typed objects. Two id spaces, never conflated:
  the hook's **request id** (echoed on `*_result`) and the gate's **correlation
  id** on `run_tool` (echoed on `tool_result`), matched independent of arrival
  order.
- `src/connection.ts` — the `RpcChannel` transport seam. `stdioChannel` is the
  CLI wire; `createLoopbackPair` is the in-process pair the always-on probe drives
  the real gate through (no subprocess). Loopback round-trips through JSON so it
  matches the wire path exactly.
- `src/config.ts` — `RuntimeGateConfig`, a near-twin of `guard-mcp`'s
  `ProxyConfig` minus the MCP `downstream_servers`. `tool_defaults` is the
  **operator's** action contract for each registered tool (the hook only declares
  a name — it cannot widen its own authority); `CONSERVATIVE_TOOL_DEFAULTS` is the
  fail-closed fallback. `hasUnauthenticatedApprovalGap` is the shared
  parse-time/construct-time guard (identical to the proxy's). `approval_timeout_ms`
  is the **hold deadline window**: `0` = terminal soft denial (no out-of-band
  resolution); `> 0` = park with a deadline + enable signed out-of-band resolution
  (so it requires a pinned approver key or explicit `allow_unsigned`).
- `src/observation.ts` — the single `lodestar.runtime_tool_result@1` observation
  schema + extractor + `RuntimeAwareEvidenceLinker` (the generic analogue of the
  MCP proxy's). The tool envelope is `tool_result` evidence; document content the
  tool surfaces is `external_document` evidence, so the auto-observation gate keeps
  hostile tool output from auto-promoting to `truth_status: supported`.
- `src/policy.ts` — `compileRuntimePolicy` / `compileRuntimePolicyWithSentinels`,
  the mirror of `compileProxyPolicy[WithSentinels]`. File I/O + signature
  verification live in the host (the CLI), never in the gate.
- `src/gate.ts` — `RuntimeGate`. Builds the firewall/cognitive/kernel stack
  (`init`), serves an `RpcChannel` (`serve`), and dispatches the protocol:
  `register_tool` (namespaced `runtime.<sanitised>`, fail-closed collision guard),
  `govern` (`synthesizeDecision` → `propose → arbitrate` → execute-or-hold),
  `resume` (durable + idempotent hold resolution), and the re-entrant remoted
  `run_tool` callback (the tool body runs back in the hook, only inside the kernel
  execute phase). Threads the action id into `tool.execute` via
  `AsyncLocalStorage` (the kernel does not pass it — ADR-0024 finding).

## Invariants

1. **The gate is just another downstream — no schema/kernel change.** It reuses
   the engine; do not reimplement governance here. New governance behaviour goes
   in the engine packages, not the gate.
2. **One closed enforcement surface; fail closed.** A `govern` for a tool with no
   registered contract is **denied**, never allowed (CLAUDE.md "no silent
   defaults"). The operator owns the contract (`tool_defaults`); the untrusted
   hook only declares a name.
3. **Two-phase preserved by remoting execution.** The tool body runs only inside
   the kernel's execute phase, reached only after the gate (and any hold) clears.
   The remoted execute is keyed by action id; the durable terminal event makes it
   exactly-once, so a duplicate resume / retried RPC never double-executes.
4. **Holds are durable and fail-closed.** Hold state lives in the durable log +
   the signed `.approvals/` side-channel, keyed by action/request id. Any gate
   instance reconstructs a hold (and its deadline) from the log; a late or
   post-deadline resolution can never un-park it; an out-of-band resolution must
   verify against the operator-pinned approver key before it promotes.
5. **Honest scope (ADR-0004).** Governance over declared actions, not OS
   containment. Raw I/O outside the tool abstraction is out of scope — state it,
   don't pretend to capture it. Pair with network/filesystem controls.
6. **stdout is the protocol stream.** Over `stdioChannel`, never write anything
   but protocol JSON to stdout; diagnostics go to stderr (`no console.log`).

## What does not live here

- The native hooks — `runtimes/langgraph/` (Python, PyPI), then CrewAI/AutoGen.
- The `lodestar runtime gate` CLI entry point — `@qmilab/lodestar-cli`
  (`src/commands/runtime.ts`), which loads/compiles the policy, resolves sentinel
  ids against `FIRST_PARTY_SENTINELS`, and opens the Postgres stores (the gate
  never reads policy off disk or opens a DB connection — same separation as the
  proxy).
- The signed `.approvals/` side-channel + the Ed25519 primitives —
  `@qmilab/lodestar-guard` (graduated there in ADR-0025; the gate consumes them).
- The probes — `packs/lodestar-core/probes/` (`runtime-gate-enforces-two-phase`
  always-on, `langgraph-tool-calls-are-governed` runtime-gated).

## When you change the gate

- The RPC protocol (`protocol.ts`) is the contract every hook depends on. Add
  fields additively; do not re-type or remove existing ones without a hook bump.
- The `runtime-gate-enforces-two-phase` probe is the spec for the TS spine; the
  `langgraph-tool-calls-are-governed` probe for the real runtime. Both must keep
  passing — do not edit a probe to match changed code.
- Keep the gate transport-agnostic: logic consumes an `RpcChannel`, never
  `process.stdin`/`stdout` directly (that lives in `connection.ts` + the CLI).
