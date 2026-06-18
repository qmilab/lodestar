# ADR-0025: runtime-core gate server — implementation decisions + side-channel graduation

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Nandan, Claude
- **Related:** ADR-0024 (the LangGraph runtime-adapter seam this realises),
  ADR-0010 / ADR-0015 (signed approval side-channel), ADR-0002 / ADR-0003
  (proxy decision synthesis), ADR-0004 (TS-level boundary honesty), epic #75,
  #83, `packages/runtime-core/`, `runtimes/langgraph/`, `packages/guard/`,
  `packages/guard-mcp/`

## Context

ADR-0024 was accepted on the strength of the remoted-execute spike. Building the
real slice — `packages/runtime-core/` (the TS gate server + RPC protocol),
`runtimes/langgraph/` (the Python hook), and the two locking probes — surfaced a
handful of concrete decisions the ADR left open or implied. This ADR records them
so the next runtime adapter (CrewAI #84, AutoGen #85) inherits the rationale
rather than re-deriving it. None of them change ADR-0024's shape; they are how it
is realised.

## Decisions

### 1. The signed `.approvals/` side-channel graduates to `@qmilab/lodestar-guard`

The signed approval resolution format (ADR-0010 / ADR-0015) is split: the Ed25519
sign/verify primitives live in `@qmilab/lodestar-policy-kernel` (re-exported via
`guard`), but the `.approvals/<project>/<request>.json` *transport*
(`ApprovalResolutionSchema`, `read`/`write`/`deleteApprovalResolution`,
`resolutionToOutcome`) lived in `@qmilab/lodestar-guard-mcp`. The runtime gate is
a **second** consumer of that identical, security-critical format. Duplicating a
signed-format reader across two consumers is exactly the drift that opens a
forgery hole, so the transport module **moved to `@qmilab/lodestar-guard`** — the
governance meta-package, beside the primitives it pairs with — and `guard-mcp`
re-exports the same names unchanged (the proxy, the `lodestar approve` CLI, and
every approval probe are untouched; `approval-via-side-channel` and
`forged-approval-cannot-execute` still pass). This is the established
graduation-on-second-consumer pattern (gate primitives → core in #104, crypto →
core in ADR-0017). `runtime-core` therefore reaches the format through `guard`
and never depends on `guard-mcp` (so it pulls in **no** MCP SDK).

### 2. The gate namespaces runtime tool names (`runtime.<sanitised>`)

The action-kernel registry requires `namespace.action` tool names, but a native
LangGraph tool ("search_web", "writeFile") has none. The gate registers each
hook-declared tool under a deterministic `runtime.<sanitised>` name — the exact
analogue of the proxy's `mcp.<server>.<tool>` — keeping a map from the hook's
original name (used to remote `run_tool` back) to the registry name (used for
propose/execute and reconstructed from the durable log on restart). Deterministic
so a fresh gate instance derives the same name and resolves a reconstructed
action's tool.

### 3. The operator owns every tool contract; the hook only declares a name

`register_tool` carries only the tool's name. The action contract
(`required_trust_level`, reversibility, sandbox, permissions, blast radius) comes
from the operator's `RuntimeGateConfig.tool_defaults`, or a conservative default
(irreversible / external / L3 / controlled-shell) when unconfigured — never from
the untrusted hook. This is the runtime analogue of the proxy ignoring untrusted
downstream tool annotations: governance must survive a hostile hook, so the hook
cannot widen its own authority. An unregistered tool is **denied** (fail closed),
never proposed.

### 4. `govern` returns the hold immediately; `resume` resolves it; `approval_timeout_ms` is the deadline window

`govern` on a held action returns `pending_approval` immediately (the LangGraph
`interrupt()` idiom). `resume(action_id, request_id, wait_ms?)` resolves it —
single-check by default, or block-polling up to `wait_ms` (bounded by the
deadline) for a headless hook. `RuntimeGateConfig.approval_timeout_ms` is the
**hold deadline window**: `0` makes a hold a terminal soft denial (no out-of-band
resolution, no `.approvals/` read, no forgery surface); `> 0` parks with a
deadline of `requested_at + approval_timeout_ms` and enables signed out-of-band
resolution (so a pinned approver key or explicit `allow_unsigned` is required,
the same `hasUnauthenticatedApprovalGap` guard the proxy uses). Exactly-once is
keyed on the durable terminal event (`action.completed` / `action.failed` /
`action.rejected` / `approval.expired`); a fresh instance reconstructs both the
parked action (`action.pending_approval`) and the deadline
(`approval.requested@1`) from the log, so a restart cannot reset the deadline and
a duplicate resume never re-executes. The v0 Python hook drives the **block-poll**
path (the ADR-sanctioned headless default); the interrupt integration is exposed
via the `govern`/`resume` primitives for callers that manage the LangGraph
re-execution semantics.

**Review hardening (PR #125 Codex review).** Three follow-ups closed: (a) a
timeout-0 hold now emits a terminal `action.rejected` at `openHold` *and*
`resume` refuses to resolve under a timeout-0 config — so the documented "no
out-of-band resolution path" cannot be circumvented by reconstructing the parked
action and resuming it; (b) `resume` is **serialized per action id**, so two
concurrent resumes for the same held action cannot both pass the terminal-event
check and double-execute a side-effectful body (the second runs only after the
first settles and so sees its terminal event); (c) a **malformed `tool_result` /
`tool_error` callback** rejects its pending remoted-execute promise instead of
stranding it, so a buggy/hostile hook fails the action cleanly rather than hanging
it. A second review round closed two more: (d) `terminalOutcomeFromLog` tracks the
`approval.expired` / `approval.denied` events **separately** from the trailing
`action.rejected`, so a replayed timeout/denial keeps its `approval_timeout` /
`approval_denied` kind instead of being relabelled `policy_denied` (callers branch
on the kind to re-plan); and (e) the Python hook runs an **async-only** tool body
via `ainvoke` (sync `invoke` raises `NotImplementedError` for a coroutine-only
tool) on its loop-less worker thread. A third round closed three edge-case
hardenings: (f) a timeout-0 hold emits `approval.expired` (not just
`action.rejected`) so read-side approval tooling sees the request resolved rather
than stuck "pending"; (g) `dispatch` coalesces a non-object RPC value (`null`, a
primitive) to `{}` before reading fields, so a malformed input can't throw out of
the async dispatch; and (h) a bounded **remoted-execute timeout**
(`tool_exec_timeout_ms`, default 2 min) fails an action whose `tool_result` is
lost, never sent, or uncorrelatable (malformed + no id) instead of stranding the
kernel — the general liveness backstop for any callback the per-id rejection
cannot match. A fourth round closed one more — a **P1 governance bypass**: (i)
`defaultsFor` resolves a tool's contract via an **own-property** check, so a
hook-chosen tool name colliding with an `Object.prototype` member (`toString`,
`constructor`, …) no longer reads the prototype function as its "contract"
(making `required_trust_level` `undefined` and letting the gate mis-evaluate it) —
an unconfigured tool always falls through to `CONSERVATIVE_TOOL_DEFAULTS`. All
locked by scenarios in `runtime-gate-enforces-two-phase` and the LangGraph e2e.
A fifth round closed two Python-hook issues: (j) the `GateClient` per-request
reply wait defaults to **unbounded** (`request_timeout_s=None`) rather than a fixed
120s that could fire while the gate legitimately runs a slow tool (or one whose
`tool_exec_timeout_ms` the operator raised above the cap) and discard a valid
`govern_result` — the gate bounds execution itself and a gate *death* releases
every waiter via the stdout-close path, so a fixed client cap is unneeded for
liveness (it stays available as an explicit hard cap); and (k) the LangGraph e2e
imports the **installed** hook first (source tree only as a local fallback), so the
CI job actually exercises the packaged artifact + its `pyproject` exports rather
than the checkout.

### 5. The gate server is transport-agnostic; probe 1 drives it in-process

`RuntimeGate` consumes an `RpcChannel` abstraction. `stdioChannel` is the CLI's
wire (`lodestar runtime gate`); `createLoopbackPair` is an in-process, JSON-round-
tripping pair so the always-on `runtime-gate-enforces-two-phase` probe drives the
**real** gate over the **real** protocol with an in-TS stand-in for the hook — no
subprocess, no Python — exercising every TS invariant (durable/idempotent holds,
signed-approval verification, fail-closed unregistered tools, external_document
gating, decision synthesis, concurrent-RPC correlation) on every probe run. The
Python `langgraph-tool-calls-are-governed` probe adds the real-runtime cases
(compiled graph + prebuilt `ToolNode`, `governed_call`, `ainvoke`, batch, L4 hold,
fail-closed) and skips loudly when Python/LangGraph is absent.

## Consequences

- One audited implementation of the signed-approval transport, shared by the
  proxy and the gate. `runtime-core`'s dependency graph stays clean (guard, not
  guard-mcp; no MCP SDK).
- The engine and core schema are untouched — the gate is "just another
  downstream", exactly as ADR-0024 promised. The new code is the RPC protocol,
  the gate server (namespacing, durable holds, remoted execute, decision
  synthesis), and the Python hook.
- CrewAI and AutoGen now collapse to "another thin hook on the same gate +
  protocol"; decisions 2–4 are theirs for free.

## Alternatives considered

- **Keep the side-channel in `guard-mcp` and have `runtime-core` depend on it.**
  Rejected: pulls the MCP SDK into the runtime adapter's tree and inverts the
  dependency direction (a non-MCP adapter depending on the MCP proxy).
- **Duplicate the side-channel reader in `runtime-core`.** Rejected: two
  implementations of a signed-format parser is a forgery-hole generator.
- **Interrupt-only holds in the v0 hook.** Deferred: getting LangGraph's
  node-re-execution semantics right (so `govern` is not re-run on resume) is real
  work; the block-poll path is correct, testable, and the ADR's sanctioned
  headless default. The primitives are exposed for an interrupt integration.
- **Let the hook declare its own tool contract.** Rejected: an untrusted hook
  could widen its own authority — the operator owns the contract (decision 3).
