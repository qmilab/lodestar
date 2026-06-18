# ADR-0026: CrewAI runtime adapter — second thin hook on the shared governance gate

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Nandan, Claude
- **Related:** ADR-0024 (the runtime-adapter seam this reuses), ADR-0025
  (runtime-core gate decisions 2–4, inherited here), ADR-0004 (TS-level boundary
  honesty), ADR-0005 (named the runtime-adapter backlog), epic #75, #84,
  `packages/runtime-core/`, `runtimes/crewai/`, `runtimes/langgraph/`

## Context

ADR-0024/0025 built the shared spine for epic #75: a language-agnostic TypeScript
governance-gate sidecar (`lodestar runtime gate`, `@qmilab/lodestar-runtime-core`)
that reuses the existing engine unchanged, with each framework contributing only a
thin native hook over NDJSON-RPC. ADR-0025 closed with the explicit promise:
"CrewAI (#84) and AutoGen (#85) now collapse to 'another thin hook on the same gate
+ protocol'; decisions 2–4 are theirs for free." This ADR is the cash-in for
CrewAI — the first proof that the spine actually generalises.

CrewAI is Python and runs role-based agents whose tools are native in-process
`crewai.tools.BaseTool` objects. Like LangGraph, it does not speak MCP, so the MCP
proxy cannot wrap it. The only genuinely framework-specific question is **where the
enforcement seam sits in CrewAI's tool-invocation surface** and how to wrap a
`BaseTool` faithfully. Everything else — the gate, the RPC protocol, the durable
hold path, the namespacing, the operator-owned contract, decision synthesis — is
reused verbatim.

Framework facts (verified against `crewai==1.14.7`):

- `BaseTool` is a Pydantic v2 model with `name` / `description` / `args_schema`
  fields and an abstract `_run(self, *args, **kwargs)`. Both the public
  `BaseTool.run()` **and** the framework's executor (`CrewStructuredTool`, built
  via `to_structured_tool()` with `func=self._run`) dispatch through `_run`. So
  `_run` is the single point every tool call passes through — the enforcement
  seam, exactly analogous to LangGraph's wrapped `StructuredTool`.
- `CrewStructuredTool.invoke(input)` validates `input` against `args_schema` and
  calls `func(**parsed_args)` — i.e. `_run` receives keyword args.
- Async tools override `_arun`; the abstract `_run` then raises
  `NotImplementedError`, so `run()` raises and the body must fall back to `arun`
  (mirrors the LangGraph `invoke`→`ainvoke` fallback).
- CrewAI's `ToolUsage` catches an exception raised by a tool and surfaces
  `str(exc)` to the agent as a re-plannable observation — so a raised denial is
  already idiomatic error handling, no framework-special exception type needed.

## Decision

**Ship `lodestar-crewai` (`runtimes/crewai/`) as a thin native hook on the
unchanged runtime-core gate. The only new code is the CrewAI tool wrapping; the
RPC client is the framework-agnostic one, and the gate/engine are untouched.**

### 1. The enforcement seam is a governed `BaseTool` subclass overriding `_run`

`govern_tools(client, tools)` registers each tool's body with the gate and returns
a governed `BaseTool` wrapper whose `_run` routes the call through
`governed_call` (`propose → arbitrate`; on a hold, block-poll `resume` up to the
deadline for a *signed* approval; on `allow`, the gate remotes the body back). A
governed wrapper is the only object an agent ever holds for a governed capability,
and it is a real `BaseTool` the framework accepts (it attaches to `Agent` / `Task`
/ `Crew` and converts to `CrewStructuredTool` like any other). This is the
one-closed-fail-closed-surface rule of ADR-0024 §3 realised for CrewAI; an
unregistered tool is **denied** by the gate (fail closed).

- **The gate reference + per-tool config live in a Pydantic `PrivateAttr`**, never
  a model field, so they are not part of the tool's serialised schema (the
  description the LLM sees) and are not validated as tool inputs.
- **The original `args_schema` is preserved on the wrapper**, so the model still
  sees the right parameters and CrewAI does not regenerate an empty schema from the
  wrapper's `*args/**kwargs` `_run` signature.
- **The body runs the original `tool.run(**args)`**, with a `NotImplementedError →
  asyncio.run(tool.arun(**args))` fallback for async-only tools — so the original's
  own validation, coroutine handling, and usage limit apply, and the original's
  `max_usage_count` is enforced in the body (not double-counted on the wrapper).
- **`governed_call(client, tool, args)`** is the helper a custom step (a callback
  that invokes a tool directly) uses — never a raw tool body, exactly as LangGraph.

### 2. Denial default re-raises; CrewAI turns it into a re-plannable observation

A denied / held-then-timed-out call raises `LodestarDenied` by default; CrewAI's
`ToolUsage` catches it and surfaces the reason to the agent. `on_denied` maps a
denial to a return value for callers that prefer that. This mirrors LangGraph's
"let the framework's own error handling apply" without inventing a CrewAI-specific
exception type.

### 3. The Python RPC client is duplicated verbatim, not shared (yet)

`runtimes/crewai/lodestar_crewai/client.py` is byte-identical to the
`lodestar-langgraph` client (the framework-agnostic, pure-stdlib `GateClient` that
spawns the gate and speaks NDJSON-RPC) apart from two docstring lines. Two PyPI
packages cannot share a module without a third published dependency; for two
consumers, duplication is cheaper and keeps each hook a single self-contained
install. **Deferred:** if a third Python hook lands (AutoGen #85), graduate the
client to a shared `lodestar-runtime-client` PyPI package — the
graduate-on-Nth-consumer pattern (gate primitives → core #104, side-channel →
`guard` ADR-0025). Two copies is the explicit, watched cost until then; a drift
test or the shared package closes it at three.

### 4. Decisions 2–4 of ADR-0025 are inherited unchanged

Tool-name namespacing (`runtime.<sanitised>`), the operator-owned `tool_defaults`
contract (the hook only declares a name; an unconfigured tool gets
`CONSERVATIVE_TOOL_DEFAULTS`; the untrusted hook cannot widen its own authority),
the `govern`/`resume`/`approval_timeout_ms` hold semantics (durable + idempotent,
exactly-once, fail-closed deadline), and the signed-approval Ed25519 hold path all
come from the shared gate with zero CrewAI-specific change.

### 5. Locking probe + CI

- **`crewai-tool-calls-are-governed`** (runtime-gated, end-to-end,
  `packs/lodestar-core/`): drives **real CrewAI tools** through the hook + gate and
  adds the real-runtime cases the always-on in-TS `runtime-gate-enforces-two-phase`
  probe cannot — CrewAI's own execution path (`CrewStructuredTool.invoke`, dict and
  JSON-string inputs), a custom step via `governed_call`, an async-only tool via
  the remoted execute, concurrent calls correlated correctly, an L4 hold across the
  boundary (the body never runs, through both `governed_call` and the framework
  path), a dynamically-unregistered tool rejected fail-closed, the wrappers
  attaching to a real `Agent`/`Task`/`Crew`, and NaN arg/result rejection. **No
  LLM/API key needed** — it drives the framework's tool-execution path directly,
  the faithful no-inference analogue of the LangGraph probe driving a compiled
  graph's `ToolNode` with hand-crafted tool-call messages. It **skips loudly**
  (exit 0, banner) when Python/CrewAI is absent, mirroring the DB-gated and
  sandbox-gated probes.
- CI gains a `crewai-runtime` job (Bun + Python 3.12 + `pip install
  ./runtimes/crewai[crewai]`) running the real path, a sibling of `langgraph-runtime`.
  **Python pin:** CrewAI pulls `chromadb`, whose `pydantic.v1 BaseSettings` is
  incompatible with Python 3.14, so the job pins 3.12 (the package itself supports
  3.10+).

## Consequences

- **The spine generalised on the first try.** CrewAI is ~one file of genuinely-new
  code (`adapter.py`) plus packaging, a probe, and a CI job — the expensive work
  (durable holds, closed enforcement, concurrent RPC, signed approvals) was done
  once in ADR-0024/0025 and reused untouched. This validates the epic's bet.
- **A second copy of the Python client now exists** — a watched, bounded cost with
  a named graduation trigger (decision 3). No engine or core schema change.
- **AutoGen #85 is now a near-mechanical third hook** on the same gate: wrap its
  tool surface, reuse the client, add a probe + CI job.
- **Honest boundary, unchanged (ADR-0004).** Process-level governance over declared
  tool actions, not OS containment; raw out-of-band I/O in a custom step is named as
  out of scope, not silently assumed covered.

## Alternatives considered

- **Wrap at `BaseTool.run` instead of `_run`.** Rejected: the framework's executor
  (`CrewStructuredTool`) calls `func=self._run` directly, bypassing `run` — so
  `run`-only wrapping would leak the real execution path. `_run` is the single
  choke point both paths share.
- **Subclass-free wrapping via the `@tool` decorator / a closure tool.** Rejected:
  the governed wrapper must carry the gate reference and per-tool config and present
  the original `args_schema`; a `BaseTool` subclass with a `PrivateAttr` does this
  cleanly and keeps the gate ref out of the LLM-visible schema. The decorator path
  offers no advantage and less control.
- **Point CrewAI at the MCP proxy.** Rejected for the same reason as LangGraph
  (ADR-0024): it governs only MCP-shaped tools, not the agent's native in-process
  tools — the entire point of epic #75.
- **Share the Python client now via a third PyPI package.** Deferred, not rejected:
  premature at two consumers; graduate at three (decision 3).
