# ADR-0024: LangGraph runtime adapter — the native-hook + governance-gate-sidecar seam

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Nandan, Claude
- **Related:** ADR-0002, ADR-0003 (proxy decision synthesis), ADR-0004 (TS-level
  boundary honesty), ADR-0005 (named the runtime-adapter backlog), ADR-0010 /
  ADR-0015 (signed approval side-channel), epic #75, #83, PR #124 (Codex
  adversarial review — drove the durability / enforcement-closure /
  concurrency-invariant clarifications below), `spikes/adr-0024-remoted-execute/`
  (the validation spike), `packages/guard-mcp/`, `packages/action-kernel/`,
  `packages/cognitive-core/`, `packages/guard/`

## Context

Epic #75 is "wrap agent runtimes that do **not** speak MCP so guard/proxy
governance applies." ADR-0005 named the targets (LangGraph, CrewAI, AutoGen, …)
and the shape — *wrap a whole agent loop, not one tool*. #83 is the first:
LangGraph.

The governance engine already exists and is proven. The MCP proxy (ADR-0002 /
ADR-0003) governs an **opaque** agent end to end: the Action Kernel's two-phase
`propose → arbitrate → execute`, the held-L4 approval-polling loop with Ed25519
verification against operator-pinned keys (ADR-0010 / ADR-0015),
`CognitiveCore.ingest()` turning each tool result into Observation → Claim →
EvidenceSet → Belief (with `external_document` evidence blocked from
auto-promotion), and `SentinelArbiter` + `observedBeliefIds()` synthesizing a
`decision.made` for an agent that cannot declare its own dependencies. All of it
is TypeScript and, per a structural survey of `guard-mcp` / `action-kernel` /
`cognitive-core` / `guard`, **reusable as-is**. The proxy's `handleCallTool`
treats each downstream as a tool whose `execute()` calls out to a child process.

So the engine is not the gap. The gap is the **seam**: LangGraph is a Python
stateful-graph loop whose tool calls are native in-process Python, and it does
not speak MCP. To govern it we must (a) intercept the framework's *native* tool
boundary with **no bypass paths**, (b) cross the language barrier to the TS
engine, (c) preserve the "no work before approval" invariant across that barrier
**including across a durable checkpoint/resume**, and (d) surface an L4 hold in
the framework's own idiom.

Framework facts constrain the seam:

- **Callbacks (`BaseCallbackHandler.on_tool_start` / `on_tool_end`) are
  observe-only.** They are the LangSmith/Langfuse tracing hook — they cannot
  block a call, deny it, or rewrite its result. Fine for instrumentation,
  useless for *enforcement*.
- **Enforcement must sit where it controls whether the tool body runs** — i.e.
  wrapping the tool-invocation surface, not observing it.
- **LangGraph is a durable, resumable runtime.** `interrupt()` pauses the graph
  at a checkpoint and `Command(resume=…)` continues it — possibly in a *different
  process, after a restart, days later*. A hold therefore cannot live in a live
  sidecar's memory; it must be durable and its resolution idempotent.
- **LangGraph issues parallel tool calls** (multiple tool calls in one model
  turn), so the RPC seam is genuinely concurrent, not sequential.

A strategic constraint also bears: CrewAI (#84) and AutoGen (#85) are **also
Python**. Whatever cross-language seam we build for LangGraph is the shared spine
for the rest of the epic — so we should build it once, properly, in Python, not
optimize the first slice for "cheap to probe" (e.g. LangGraph.js in-process),
which would prove a boundary the rest of the epic never uses.

## Decision

**Target LangGraph Python first, via a thin native Python hook talking to a
language-agnostic TypeScript "governance-gate sidecar" that reuses the existing
engine unchanged. The sidecar is the reusable spine for the whole runtime-adapter
epic; each framework contributes only its hook.**

### 1. Python-first

The first slice targets LangGraph **Python** — its dominant ecosystem and the
template for CrewAI/AutoGen (both Python). A JS in-process fast-path
(LangGraph.js, calling the engine directly with no sidecar) is a legitimate later
optimization but is **not** the first slice: it reaches a sliver of usage and
exercises none of the cross-language boundary the rest of the epic depends on.

### 2. Thin native hook + governance-gate sidecar (engine reused, not reimplemented)

A small pip-installable Python package (`lodestar-langgraph`) wraps the
framework's tool boundary and speaks a minimal local RPC to a TS sidecar
(`lodestar runtime gate`). The sidecar is **not** a new governance
implementation — it wires the *same* `ActionKernel` two-phase, `CompiledPolicy`
gate, `CognitiveCore.ingest`, `SentinelArbiter` + `observedBeliefIds` synthesis,
and the approval / Ed25519 hold path the MCP proxy already runs. The only
genuinely new code is the RPC protocol + gate server (TS) and the hook (Python).
Operator-pinned configuration (the signed policy document, approver keys,
sentinel ids, persistence, durable log root) lives **only** in the sidecar's
`RuntimeGateConfig` — a near-twin of `ProxyConfig`; the hook never holds
credentials or policy.

### 3. One closed enforcement surface — fail closed, no "and/or"

The adapter governs the framework's tool-invocation surface and **nothing
implicitly**. There is exactly one enforcement path, and it fails closed:

- The adapter wraps the **entire toolset bound to the graph** — both what the
  model is given (`bind_tools`) and what runs them (the prebuilt `ToolNode`) — at
  **every** invocation entry point the framework exposes: `invoke` / `ainvoke` /
  `batch` / `abatch` (sync, async, batched). A governed wrapper is the only
  object the agent ever holds for a governed capability.
- A **custom node** that needs to invoke a governed tool must call the adapter's
  `governed_call(tool, args)` helper — never a raw tool function. The adapter
  does not silently wrap arbitrary functions a custom node happens to call.
- **Fail closed on the unrecognized.** A call that reaches the sidecar for a tool
  with no compiled contract is **denied**, never allowed (no silent default —
  CLAUDE.md). At graph-construction time the adapter rejects an un-governed tool
  found in the bound set, so a tool cannot run ungoverned; a tool added
  dynamically must be registered through the adapter or it does not execute.
- **Honest scope (ADR-0004 lineage).** Raw I/O performed *outside* the tool
  abstraction — a custom node that calls `requests.get()` directly instead of a
  registered tool — is **outside the governed surface**, exactly as `guard.wrap()`
  and the MCP proxy only govern the tools they are given. The adapter states this
  boundary explicitly and recommends pairing with network/filesystem controls for
  defense in depth; it does **not** pretend to capture raw in-process I/O. This is
  governance over declared actions, not containment of the process.

### 4. Two-phase preserved by remoting execution — idempotent, exactly-once per action

The hook does **not** run the real tool when it intercepts the call. It sends a
`propose` to the sidecar; the sidecar runs `propose → arbitrate` (synthesizing a
decision from `observedBeliefIds()`), and on a hold drives the durable hold path
(§5). **Only if allowed** does `kernel.execute()` fire — and the governed tool
the kernel executes is registered so its `execute()` is an RPC call **back** to
the Python hook ("now run tool X with args Y"). The hook runs the real Python
tool, returns the result over the RPC, and the sidecar ingests it through
`CognitiveCore.ingest()` → beliefs before returning the result to the hook, which
hands it back to LangGraph.

From the kernel's perspective the Python hook is **just another downstream**, so
the kernel, the gate, the cognitive core, and the arbiter are untouched (no
schema change, no kernel change). It guarantees "tools that do work before
approval are bugs" *across the language boundary*: the tool body runs **only**
inside the TS execute phase, reached only after the gate (and any hold) clears.

**Execution is idempotent, keyed by action id.** Before the remoted execute
fires, the sidecar checks the durable event log for a terminal event on that
action id (`action.completed` / `action.failed` / `action.rejected` /
`approval.expired`); if one exists it returns the recorded outcome and does
**not** re-run the tool. So a duplicate resume, a retried RPC, or a re-proposed
call for an already-settled irreversible action never double-executes. This adds
a replay-idempotency layer over *existing* events — still no new schema.

### 5. Durable, idempotent holds — the sidecar is stateless across the hold boundary

Because LangGraph resumes across processes and time, hold/approval state must not
depend on the live sidecar:

- Before `interrupt()` is raised, the pending action (`action.proposed`,
  `action.pending_approval`) and `approval.requested@1` — carrying the **action
  id, request id, and deadline** — are **durably written to the event log**. The
  interrupt payload carries those stable ids, never in-memory handles.
- All hold/approval state lives in the durable event log + the signed
  `.approvals/` side-channel (ADR-0010 / ADR-0015), keyed by action/request id.
  **Any** sidecar instance — a freshly spawned one after a crash, or a different
  process resuming the checkpoint later — reconstructs the hold from the log and
  checks for a signed resolution. No reliance on the originating process.
- **Deadline is fail-closed.** The deadline recorded in `approval.requested@1` is
  authoritative: once it passes, `approval.expired@1` is the terminal outcome and
  the action is denied. A signed resolution arriving *after* the deadline is
  rejected (the proxy already deadline-bounds resolution validity). A late
  approval can never un-park an expired action.
- On `Command(resume=…)` the hook re-presents the action/request id; the sidecar
  reconstructs state and applies the exactly-once execute rule (§4) — duplicate
  resume is idempotent. For headless runs the hook may instead block-poll up to
  the deadline exactly as the proxy does (`approval_timeout_ms`); `interrupt` is
  the idiomatic default.

### 6. Transport and concurrency invariants

The hook spawns the sidecar as a child process (`lodestar runtime gate
--config …`) and speaks newline-delimited JSON-RPC over stdio — zero new
dependencies, the same framing MCP itself uses, and bidirectional (the
remoted-execute callback in §4 needs it). Because tool calls run in parallel, the
protocol pins, in place of any hand-wave that "concurrency is safe":

- **Every message on every leg carries a unique correlation id and the action
  id** (propose, execute-callback, observe). Responses are matched by correlation
  id, **independent of arrival order** — the stdio channel is multiplexed by id;
  no positional or ordering assumption.
- **Each leg is deadline-bounded and fails closed.** A timed-out or cancelled leg
  records the action `failed` (terminal) and is **never** silently allowed or
  retried into duplicate execution; a cancelled graph branch's in-flight call is
  reconciled to a terminal state.
- **Exactly-once result ingestion**, keyed by invocation/action id (the proxy
  already keys captures by `invocation_id`) — a result is ingested through the
  cognitive core once, even under retry.

(Decision-dependency synthesis remains the over-linking, grow-only
`observedBeliefIds` set of ADR-0003 — concurrency-safe by construction — but that
is only the *belief-linking* half and is no longer offered as the whole
concurrency story.)

### 7. Repository layout: TS stays in `packages/`, Python is a clearly-marked sibling

- **`packages/runtime-core/` (`@qmilab/lodestar-runtime-core`)** — the new TS
  package: the RPC protocol types + the gate server that wraps the engine and
  owns the durability/idempotency/concurrency logic above. Reused by every
  runtime adapter. `lodestar runtime gate` is the CLI.
- **`runtimes/langgraph/`** — a new top-level directory (sibling of `packages/`,
  `examples/`, `packs/`) holding the Python `lodestar-langgraph` hook, published
  to **PyPI** (not npm). This keeps the monorepo invariant "every `packages/*`
  is a TS package with `package.json` + `tsconfig.json`" intact and marks the
  cross-language artifact unambiguously.
- CI gains a Python job (install Python + LangGraph + the hook) for the
  end-to-end probe; everything else stays Bun.

### 8. Locking probes

- **`runtime-gate-enforces-two-phase`** (always-on, `packs/lodestar-core/`):
  drives the **sidecar RPC directly** with a faithful in-TS stand-in for the hook
  and pins the contract the hook relies on — a held L4 touches nothing and stays
  held until a *signed* approval resolves it; **a duplicate resume is idempotent
  (no double-execute)**; **a resolution after the deadline is rejected**; **a hold
  reconstructed by a fresh sidecar instance still resolves** (restart durability,
  exercised by replaying the durable log into a new gate); an **unrecognized /
  unregistered tool is denied** (fail closed); `external_document` cannot
  self-promote a belief; a synthesized decision links the observed-belief set; and
  **parallel in-flight calls are correlated to the right action and ingested
  exactly once**. No Python needed, so the core invariants are enforced on every
  run.
- **`langgraph-tool-calls-are-governed`** (runtime-gated, end-to-end): drives a
  **real Python LangGraph loop** through the hook + sidecar and adds the
  real-runtime cases — prebuilt `ToolNode`, a custom node via `governed_call`,
  async tools (`ainvoke`), batch/parallel calls, and a dynamically-registered tool
  rejected fail-closed. It **skips loudly** (exit 0, banner) when Python/LangGraph
  is absent — mirroring the DB-gated `tool-poisoning-cross-session` and the
  sandbox-gated `runner-sandboxes-probe-filesystem-and-network`. CI installs the
  runtime so the real path is exercised there.

## Validation (remoted-execute spike)

A throwaway spike (`spikes/adr-0024-remoted-execute/`, run `python3 hook.py`,
needs `bun` on PATH) exercises the one mechanic this ADR was least sure of — the
re-entrant remoted execute — against the **real `ActionKernel`** (a stand-in
`PolicyGate` only; the kernel sees the gate as a plain function, so this is
architecturally identical to the compiled gate, which is not what the spike is
de-risking). A Python hook spawns the TS gate and drives it over bidirectional
stdio NDJSON-RPC. All checks pass:

- **A — remoted execute works.** An allowed call reaches `kernel.execute()`,
  whose tool `execute()` calls *back* into Python to run the body; the result
  flows into the chain via `observationSink`. "Hook as downstream" is realizable
  with **no kernel or schema change** (§4).
- **B — two-phase holds across the boundary.** An L4 call parks at
  `pending_approval` and the Python body **never runs** — "no work before
  approval" holds cross-language (the gate records the hold before any execute).
- **C / D — resume + exactly-once.** `resolve(granted)` runs the body once; a
  *duplicate* resolve is idempotent — no re-execution (§4/§5 exactly-once).
- **E — concurrency correlation.** Two in-flight calls are each correlated to the
  right action by RPC id and ingested once (§6).

**Findings folded back in:** (1) the kernel does **not** pass the action id to
`tool.execute(inputs, ctx)`, so the remoting layer threads it via
`AsyncLocalStorage` (async-context, concurrency-safe) — a concrete requirement
for `runtime-core`. (2) The spike holds its pending-action / idempotency state
**in memory**; that is the *mechanic*, not the durability — §5's reconstruction
from the durable log + signed side-channel (surviving a sidecar restart) is
specified but deliberately **out of the spike's scope** and is an obligation of
the `runtime-gate-enforces-two-phase` probe. With the mechanic proven, this ADR
moves to **Accepted**.

## Consequences

- **The epic gets a shared spine.** One TS sidecar + RPC protocol; CrewAI (#84)
  and AutoGen (#85) collapse to "another thin hook on the same sidecar." The
  expensive, risky work — durable holds, closed enforcement, concurrent RPC — is
  done once.
- **First non-TS code in the repo.** A Python package + a PyPI publish path + a
  Python CI job + new release bookkeeping (a non-npm artifact). Contained to
  `runtimes/` and one CI job, but real.
- **The engine and schema are untouched.** No new core schema, no kernel change —
  the hook is "just another downstream." The sidecar adds *logic* (durable-hold
  reconstruction, replay idempotency, RPC correlation/timeout) over **existing**
  events and the existing signed side-channel.
- **The enforcement boundary is closed and honest.** One governed surface that
  fails closed on the unrecognized; raw out-of-band I/O is named as out of scope
  rather than silently assumed covered (ADR-0004 honesty).
- **Holds are durable and exactly-once.** A sidecar crash, a checkpointed resume
  days later, a duplicate resume, an expired deadline, and a late-arriving
  approval all resolve deterministically and fail closed — no stranded approval,
  no double-executed irreversible tool.
- **The re-entrant remoted-execute RPC is the main new mechanic** and the thing
  most likely to surprise (bidirectional framing, correlation, timeout/cancel
  cleanup, async tools). It should be de-risked with a thin end-to-end spike
  before the full slice is built and before this ADR moves to Accepted.
- **Honest boundary.** Process-level governance over actions, not OS containment
  of the agent — stated up front, consistent with ADR-0004 and the adapters.

## Alternatives considered

- **Callbacks (`on_tool_start` / `on_tool_end`) for governance.** Rejected:
  observe-only — cannot hold, deny, or rewrite. Good for tracing
  (LangSmith/Langfuse), useless for enforcement.
- **Wrap only the prebuilt `ToolNode` (or only selected tools).** Rejected: leaky
  — custom nodes, direct invocation, async/batch paths, or dynamically-added
  tools run ungoverned. The boundary must be a single fail-closed surface (§3),
  not an "and/or".
- **Hold state in the sidecar's memory.** Rejected: LangGraph resumes across
  processes and time, so an in-memory hold is lost on restart and a resume could
  strand an approval or re-execute an irreversible tool. Holds live in the durable
  log + signed side-channel; the sidecar is stateless across the boundary (§5).
- **"Point LangGraph at the MCP proxy via `langchain-mcp-adapters`."** Rejected
  *as the adapter* but kept as a documented zero-adapter quick-win: it governs
  only MCP-shaped tools, not the agent's native in-process tools — which is the
  entire point of epic #75 — and reaches none of CrewAI/AutoGen's native tools.
- **JS-first (LangGraph.js, in-process).** Rejected: a sliver of real usage, and
  it exercises none of the cross-language boundary the Python-based remainder of
  the epic depends on, so it de-risks nothing for #84/#85.
- **Verdict-then-run (hook runs the tool locally after an `allow`, then reports
  the outcome).** Rejected for v0: it splits the kernel's two-phase across the
  boundary and needs a new "record external outcome" kernel path; remoted execute
  reuses the kernel unchanged and keeps the tool body strictly inside the execute
  phase. Reconsider only if the re-entrant RPC proves too costly.
- **Embed a TS runtime inside Python (PyO3 / WASM / Node-in-process).** Rejected:
  heavy and fragile, couples the release to a native build; the process boundary
  is cheap and keeps each language clean.
- **Make the sidecar speak MCP as its RPC.** Rejected: it would force every
  native Python tool into the MCP `tools/call` shape, lose rich tool typing, and
  re-import the "make it speak MCP" framing we are trying to move past. A
  purpose-built thin RPC is simpler and more faithful to "govern the native
  runtime."
