# lodestar-crewai

Govern a **CrewAI** crew's native tool calls with
[Lodestar](https://qmilab.com/lodestar) — the open epistemic-governance framework
for AI agents.

CrewAI runs role-based agents whose tools are native in-process Python objects and
does not speak MCP, so the MCP proxy cannot wrap it. This package is the **thin
native hook** (ADR-0026): it spawns the TypeScript **governance-gate sidecar**
(`lodestar runtime gate`) and remotes each native tool call through the Lodestar
Action Kernel over newline-delimited JSON-RPC. The same machinery the MCP proxy
and the LangGraph adapter run — two-phase `propose → arbitrate → execute`, the
signed policy gate, cognitive-core ingestion (external-document content can't
auto-promote), sentinel arbitration, and the signed-approval L4 hold path — now
applies to CrewAI, with no change to the engine. The gate sidecar is shared,
unchanged; only this hook is new.

The tool body runs **only** inside the gate's execute phase, reached only after
the gate (and any approval hold) clears: "tools that do work before approval are
bugs" — across the Python↔TS boundary.

## Install

```bash
pip install "lodestar-crewai[crewai]"
# and the Lodestar CLI (Bun/npm), which provides `lodestar runtime gate`:
npm install -g @qmilab/lodestar-cli   # or: bun add -g @qmilab/lodestar-cli
```

## Use

```python
from crewai import Agent, Crew, Task
from lodestar_crewai import GateClient, govern_tools, governed_call

with GateClient("runtime-gate.config.json") as gate:
    governed = govern_tools(gate, my_tools)        # register + wrap the toolset
    agent = Agent(role="researcher", goal="...", backstory="...", tools=governed)
    task = Task(description="...", agent=agent, expected_output="...")
    crew = Crew(agents=[agent], tasks=[task])
    crew.kickoff()                                  # every tool call is governed

    # A custom step invokes a governed tool through the helper, never raw:
    result = governed_call(gate, "search_web", {"q": "lodestar"})
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
`LodestarDenied` by default; CrewAI's `ToolUsage` catches it and surfaces the
reason to the agent as a re-plannable observation. Pass `on_denied` to
`govern_tools` to map a denial to a return value instead.

Apache-2.0. Part of the Lodestar monorepo (`runtimes/crewai/`).
