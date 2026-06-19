# lodestar-autogen

Govern an **AutoGen** agent's native tool calls with
[Lodestar](https://qmilab.com/lodestar) — the open epistemic-governance framework
for AI agents.

AutoGen (the `autogen-agentchat` / `autogen-core` actor framework) runs
multi-agent conversations whose tools are native in-process Python objects and
does not speak MCP, so the MCP proxy cannot wrap it. This package is the **thin
native hook** (ADR-0027) — the third framework on the same shared gate, after
LangGraph and CrewAI: it spawns the TypeScript **governance-gate sidecar**
(`lodestar runtime gate`) and remotes each native tool call through the Lodestar
Action Kernel over newline-delimited JSON-RPC. The same machinery the MCP proxy
and the LangGraph / CrewAI adapters run — two-phase `propose → arbitrate →
execute`, the signed policy gate, cognitive-core ingestion (external-document
content can't auto-promote), sentinel arbitration, and the signed-approval L4 hold
path — now applies to AutoGen, with no change to the engine. The gate sidecar is
shared, unchanged; only this hook is new.

The tool body runs **only** inside the gate's execute phase, reached only after
the gate (and any approval hold) clears: "tools that do work before approval are
bugs" — across the Python↔TS boundary.

## Install

```bash
pip install "lodestar-autogen[autogen]"
# and the Lodestar CLI (Bun/npm), which provides `lodestar runtime gate`:
npm install -g @qmilab/lodestar-cli   # or: bun add -g @qmilab/lodestar-cli
```

## Use

```python
from autogen_agentchat.agents import AssistantAgent
from lodestar_autogen import GateClient, govern_tools, governed_call

with GateClient("runtime-gate.config.json") as gate:
    governed = govern_tools(gate, my_tools)        # register + wrap the toolset
    agent = AssistantAgent("assistant", model_client=model_client, tools=governed)
    # ... run your agent / team as usual; every tool call is governed.

    # A custom step invokes a governed tool through the helper, never raw.
    # It blocks, so off the event loop call it via a worker thread:
    import asyncio
    result = await asyncio.to_thread(governed_call, gate, "search_web", {"q": "lodestar"})
```

The gate's config (`runtime-gate.config.json`) is a `RuntimeGateConfig` — the
signed policy document, approver keys, sentinel ids, persistence, and durable log
root all live there. The hook never holds credentials or policy.

## Scope (honest, ADR-0004 lineage)

This is **governance over declared actions, not OS containment of the process.**
Raw I/O performed *outside* the tool abstraction — a custom step that calls
`requests.get()` directly instead of a registered tool — is outside the governed
surface, exactly as `guard.wrap()` and the MCP proxy only govern the tools they
are given. A call for an unregistered tool is **denied** (fail closed). Pair the
adapter with network/filesystem controls for defense in depth.

## Holds & denials

An L4 action the trust-ladder floor parks for approval is resolved by
block-polling the gate up to the deadline for a *signed* approval (`hold_wait_ms`)
— the headless default. A denied / held-then-timed-out call raises
`LodestarDenied` by default; AutoGen's `StaticWorkbench.call_tool` catches it and
surfaces the reason to the agent as a re-plannable error `ToolResult`. Pass
`on_denied` to `govern_tools` to map a denial to a return value instead.

## Async note

AutoGen's tool surface is fully async (`BaseTool.run_json` is a coroutine). The
governed wrapper offloads the blocking gate RPC onto a worker thread so it never
stalls the agent's event loop, and the gate's remoted body runs the original
tool's coroutine on the client's own worker thread — so both sync and async tools
work regardless of how the agent drives them.

Apache-2.0. Part of the Lodestar monorepo (`runtimes/autogen/`). The pure-stdlib
`client.py` is duplicated verbatim from `lodestar-langgraph` / `lodestar-crewai`;
it graduates to a shared `lodestar-runtime-client` package alongside PyPI
publishing (issue #128).
