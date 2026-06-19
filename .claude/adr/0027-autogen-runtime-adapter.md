# ADR-0027: AutoGen runtime adapter — third thin hook on the shared governance gate

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Nandan, Claude
- **Related:** ADR-0024 (the runtime-adapter seam this reuses), ADR-0025
  (runtime-core gate decisions 2–4, inherited here), ADR-0026 (the CrewAI hook
  this mirrors, and which named AutoGen the third), ADR-0004 (TS-level boundary
  honesty), epic #75, #85, #128 (the PyPI-publishing + `client.py` graduation
  follow-up), `packages/runtime-core/`, `runtimes/autogen/`, `runtimes/crewai/`,
  `runtimes/langgraph/`

## Context

ADR-0024/0025 built the shared spine for epic #75: a language-agnostic TypeScript
governance-gate sidecar (`lodestar runtime gate`, `@qmilab/lodestar-runtime-core`)
that reuses the existing engine unchanged, with each framework contributing only a
thin native hook over NDJSON-RPC. ADR-0026 cashed that in for CrewAI and closed
predicting "AutoGen #85 is now a near-mechanical third hook on the same gate: wrap
its tool surface, reuse the client, add a probe + CI job." This ADR is that third
hook — the second confirmation that the spine generalises, and the trigger point
named in ADR-0026 §3 / issue #128 for the `client.py` graduation question.

AutoGen here is the **actor framework** (`autogen-agentchat` / `autogen-core`, the
0.4+ rewrite), not the legacy `pyautogen`/`ConversableAgent` line. It runs
role-based / multi-agent conversations whose tools are native in-process
`autogen_core.tools.BaseTool` objects. Like LangGraph and CrewAI, it does not speak
MCP, so the MCP proxy cannot wrap it. The only genuinely framework-specific
question is **where the enforcement seam sits in AutoGen's tool-invocation
surface** and how to wrap a `BaseTool` faithfully. Everything else — the gate, the
RPC protocol, the durable hold path, the namespacing, the operator-owned contract,
decision synthesis — is reused verbatim.

Framework facts (verified against `autogen-core` / `autogen-agentchat` 0.7.5):

- `BaseTool[ArgsT, ReturnT]` is a plain (non-Pydantic) class with
  `__init__(args_type, return_type, name, description, strict)`, properties
  `name` / `description` / `schema`, methods `args_type()` / `return_type()` /
  `state_type()` / `return_value_as_string()`, an abstract async
  `run(args: ArgsT_model, cancellation_token)`, and a concrete async
  `run_json(args: Mapping, cancellation_token, call_id=None)` that validates `args`
  into the args model and awaits `run`.
- `AssistantAgent` normalises its `tools=[...]` (a `BaseTool` is appended as-is; a
  bare callable is wrapped in a `FunctionTool`) and executes them through a
  `StaticWorkbench`, whose `call_tool(name, args, cancellation_token, call_id)`
  resolves the tool by name and calls **`tool.run_json`**. So `run_json` is the
  single point every tool call passes through — the enforcement seam, exactly
  analogous to CrewAI's `_run` and LangGraph's wrapped `StructuredTool`.
- `StaticWorkbench.call_tool` **catches** any exception a tool raises and returns an
  error `ToolResult` (`is_error=True`) carrying the message — so a raised denial is
  already idiomatic, surfaced to the agent as a re-plannable observation, no
  AutoGen-special exception type needed (mirrors CrewAI's `ToolUsage`).
- The tool surface is **fully async** (`run` / `run_json` are coroutines) — unlike
  CrewAI's sync `_run`. This is the one mechanical difference from ADR-0026 and the
  only place the hook diverges (below).

## Decision

**Ship `lodestar-autogen` (`runtimes/autogen/`) as a thin native hook on the
unchanged runtime-core gate. The only new code is the AutoGen tool wrapping; the
RPC client is the framework-agnostic one, and the gate/engine are untouched.**

### 1. The enforcement seam is a governed `BaseTool` subclass overriding `run_json`

`govern_tools(client, tools)` registers each tool's body with the gate and returns
a governed `BaseTool` wrapper whose `run_json` routes the call through
`governed_call` (`propose → arbitrate`; on a hold, block-poll `resume` up to the
deadline for a *signed* approval; on `allow`, the gate remotes the body back). A
governed wrapper is the only object an agent ever holds for a governed capability,
and it is a real `BaseTool` the framework accepts (it attaches to `AssistantAgent`
and any `Workbench`). This is the one-closed-fail-closed-surface rule of ADR-0024
§3 realised for AutoGen; an unregistered tool is **denied** by the gate (fail
closed).

- **`govern_tools` accepts the same toolset shapes `AssistantAgent` does** — a
  `BaseTool` as-is, and a **bare callable normalised to a `FunctionTool`** (its
  `__doc__` as the description, exactly as the agent's own ingestion does). So
  `govern_tools(gate, tools)` works on the literal `tools=[my_func, ...]` list a
  user would otherwise hand the agent; passing a plain function does not fail on a
  missing `.name`.
- **AutoGen's `BaseTool` is not a Pydantic model**, so — unlike the CrewAI hook's
  `PrivateAttr` — the gate reference + per-tool config live in plain instance
  attributes (`self._original` / `self._gov`); they are still never part of the
  tool's serialised schema (the description the LLM sees) and are not validated as
  tool inputs.
- **The original schema surface is preserved on the wrapper** — `schema` /
  `args_type` / `return_type` / `state_type` delegate to the original — so the
  model sees exactly the original's parameters, not one regenerated from the
  wrapper. `super().__init__` is fed the original's `args_type()` / `return_type()`
  / `name` / `description` / `strict`.
- **The body runs the original `tool.run_json(args, CancellationToken())`** on the
  client's loop-less worker thread via `asyncio.run` — so the original's own arg
  validation, coroutine handling, and `run` logic apply in the execute phase. A
  Pydantic-model return is `model_dump(mode="json")`-ed for the wire; a non-finite
  float is rejected by the client before it corrupts the JSON (→ failed action).
- **`governed_call(client, tool, args)`** is the helper a custom step uses — never a
  raw tool body, exactly as LangGraph / CrewAI.

### 2. The one mechanical divergence: a fully-async tool surface

AutoGen's `run` / `run_json` are coroutines, so the governed wrapper's `run_json`
**offloads the blocking gate RPC onto a worker thread** (`asyncio.to_thread`) — it
never stalls the agent's event loop on `govern`/`resume`. The remoted body in turn
runs the original's coroutine on a **single persistent event loop** (a dedicated
daemon thread, lazily created): because *every* AutoGen tool is async, a fresh
`asyncio.run` per call would bind any loop-scoped state a tool caches (an
`aiohttp.ClientSession`, an `asyncio.Event`/`Queue`, a pooled connection) to a loop
that is then torn down — breaking the next call cross-loop. One stable loop keeps
that state valid. This is the LangGraph `invoke`→`ainvoke` / CrewAI `run`→`arun`
fallback's analogue, simpler in that there is one path (no sync path with an async
fallback) and more robust in that the loop is reused, not recreated per call.

**Cancellation.** The wrapper threads AutoGen's `CancellationToken` through: an
already-cancelled token **short-circuits** (no action is proposed → a cancelled
agent run starts no *new* governed work, and no event is written), and the
in-flight `to_thread` future is **linked** to the token so cancelling the run
promptly unblocks the await. The honest boundary (ADR-0004 lineage): once the gate
reaches its **execute phase**, the remoted body runs server-side across the RPC
boundary and **cannot be force-cancelled** mid-flight — the same property as the
LangGraph / CrewAI remoted-execute model, and an unavoidable consequence of the
two-phase "no work before approval" guarantee that *requires* the body to run
server-side. `governed_call` itself stays blocking (a custom step calls it via
`await asyncio.to_thread(...)`).

### 3. Denial default re-raises; AutoGen turns it into a re-plannable observation

A denied / held-then-timed-out call raises `LodestarDenied` by default;
`StaticWorkbench.call_tool` catches it and surfaces the reason as an error
`ToolResult`. `on_denied` maps a denial to a return value for callers that prefer
that. Mirrors ADR-0026 §2 without inventing an AutoGen-specific exception type.

### 4. The Python RPC client is duplicated verbatim (graduation deferred to #128)

`runtimes/autogen/lodestar_autogen/client.py` is byte-identical to the
`lodestar-langgraph` / `lodestar-crewai` clients apart from one docstring sentence.
ADR-0026 §3 named the **third** hook (this one) as the graduation trigger for a
shared `lodestar-runtime-client` PyPI package. **We deliberately keep the verbatim
copy in this PR and graduate in #128**, because the graduation is coupled to the
PyPI-publishing workflow's shape (publish-ordering: a shared client must publish
before its three dependents) — issue #128 explicitly designs that workflow "once
against the settled package set." Graduating here would change two already-shipped
hooks for no benefit until publishing lands. So #85 stays a clean "third hook, same
shape" PR (mirroring how CrewAI shipped); #128 — the slice that lands immediately
after and carries the publish workflow — extracts the shared client and refactors
all three hooks to depend on it. Three verbatim copies is the bounded, watched cost
for that short window; the drift is mechanically checkable (`diff`).

### 5. Decisions 2–4 of ADR-0025 are inherited unchanged

Tool-name namespacing (`runtime.<sanitised>`), the operator-owned `tool_defaults`
contract (the hook only declares a name; an unconfigured tool gets
`CONSERVATIVE_TOOL_DEFAULTS`; the untrusted hook cannot widen its own authority),
the `govern`/`resume`/`approval_timeout_ms` hold semantics (durable + idempotent,
exactly-once, fail-closed deadline), and the signed-approval Ed25519 hold path all
come from the shared gate with zero AutoGen-specific change.

### 6. Locking probe + CI

- **`autogen-tool-calls-are-governed`** (runtime-gated, end-to-end,
  `packs/lodestar-core/`): drives **real AutoGen tools** through the hook + gate and
  adds the real-runtime cases the always-on in-TS `runtime-gate-enforces-two-phase`
  probe cannot — AutoGen's own execution path (`StaticWorkbench.call_tool`, the
  exact dispatch `AssistantAgent` uses), a custom step via `governed_call`, an
  async-implemented `FunctionTool` and a custom `BaseTool` subclass via the remoted
  execute, concurrent calls correlated correctly, an L4 hold across the boundary
  (the body never runs, through both `governed_call` which raises and the framework
  path which surfaces an error `ToolResult`), a dynamically-unregistered tool
  rejected fail-closed, the wrappers attaching to a real `AssistantAgent` (a stub
  model client, no LLM/API key), and NaN arg/result rejection. **No LLM/API key
  needed** — it drives the framework's tool-execution path directly, the faithful
  no-inference analogue of the LangGraph / CrewAI probes. It **skips loudly** (exit
  0, banner) when Python/AutoGen is absent, mirroring the DB-gated and sandbox-gated
  probes.
- CI gains an `autogen-runtime` job (Bun + Python 3.12 + `pip install
  ./runtimes/autogen[autogen]`) running the real path, a sibling of
  `langgraph-runtime` / `crewai-runtime`. **Python pin:** AutoGen (unlike CrewAI)
  pulls no `chromadb`, so it has no 3.14 constraint; 3.12 is pinned only to match
  the sibling jobs.

## Consequences

- **The spine generalised a second time, even more cheaply.** AutoGen is ~one file
  of genuinely-new code (`adapter.py`) plus packaging, a probe, and a CI job; the
  one divergence (the async seam) is a few lines. The expensive work (durable
  holds, closed enforcement, concurrent RPC, signed approvals) was done once in
  ADR-0024/0025 and reused untouched across three frameworks now.
- **A third copy of the Python client now exists** — a deliberate, short-lived,
  `diff`-checkable cost with a named, scheduled close (#128, decision 4).
- **#128 is now unblocked and fully specified.** The package set is settled at
  three hooks; the publish workflow + the `client.py` graduation can be designed
  once against it, as #128 planned.
- **Honest boundary, unchanged (ADR-0004).** Process-level governance over declared
  tool actions, not OS containment; raw out-of-band I/O in a custom step is named as
  out of scope, not silently assumed covered.

## Alternatives considered

- **Wrap at `BaseTool.run` instead of `run_json`.** Rejected: the workbench calls
  `run_json` (which validates args, then calls `run`); a `run`-only wrapper would
  miss the workbench/agent path. `run_json` is the single choke point both the agent
  and direct callers share. (We still implement `run` so a direct programmatic
  caller that pre-validates its args is governed too, but `run_json` does not
  delegate to it — no double-governing.)
- **Target the legacy `pyautogen` / `ConversableAgent` (`register_function`).**
  Rejected: the actor framework (`autogen-agentchat` / `autogen-core`) is the
  current, maintained AutoGen and the one the issue ("actor-style multi-agent
  conversation") names; the legacy line is now community-forked. The `BaseTool`
  surface is also the clean, typed seam.
- **Graduate the shared `client.py` now (in #85).** Deferred to #128, not rejected
  (decision 4): the graduation's shape is determined by the publish workflow, which
  #128 owns; doing it here would churn two shipped hooks ahead of any benefit.
- **Point AutoGen at the MCP proxy.** Rejected for the same reason as LangGraph /
  CrewAI (ADR-0024): it governs only MCP-shaped tools, not the agent's native
  in-process tools — the entire point of epic #75.
