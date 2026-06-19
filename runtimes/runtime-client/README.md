# lodestar-runtime-client

The shared **pure-stdlib Python RPC client** for the
[Lodestar](https://qmilab.com/lodestar) runtime hooks — the open
epistemic-governance framework for AI agents.

`GateClient` spawns the TypeScript **governance-gate sidecar**
(`lodestar runtime gate`) as a child process and speaks newline-delimited
JSON-RPC to it over stdin/stdout — the same framing MCP uses, with **zero runtime
dependencies**. Each native tool call is remoted through the Lodestar Action
Kernel: two-phase `propose → arbitrate → execute`, the signed policy gate,
cognitive-core ingestion, sentinel arbitration, and the signed-approval L4 hold
path (ADR-0024). The channel is bidirectional — the gate calls *back* to run a
tool body, so the body runs **only** inside the gate's execute phase, never before
approval.

This is the framework-agnostic **spine** the per-framework hooks build on. You
usually don't depend on it directly — install the hook for your framework instead:

- [`lodestar-langgraph`](https://pypi.org/project/lodestar-langgraph/) — LangGraph (ADR-0024)
- [`lodestar-crewai`](https://pypi.org/project/lodestar-crewai/) — CrewAI (ADR-0026)
- [`lodestar-autogen`](https://pypi.org/project/lodestar-autogen/) — AutoGen (ADR-0027)

It was extracted from those three hooks in #128 (ADR-0028); before that it was a
verbatim copy vendored inside each.

## Install

```bash
pip install lodestar-runtime-client
# and the Lodestar CLI (Bun/npm), which provides `lodestar runtime gate`:
npm install -g @qmilab/lodestar-cli   # or: bun add -g @qmilab/lodestar-cli
```

## Use (low-level)

```python
from lodestar_runtime_client import GateClient

with GateClient("runtime-gate.config.json") as gate:
    gate.register_tool("search_web", lambda args: {"output": do_search(args["q"])})
    result = gate.govern("search_web", {"q": "lodestar"})
    # result is the govern_result: completed | pending_approval | rejected | failed
```

For a real framework, reach for the matching hook above — it registers and wraps
the framework's toolset for you (`govern_tools`) and surfaces holds idiomatically.

## Scope (honest, ADR-0004 lineage)

This is **governance over declared actions, not OS containment of the process.** A
call for an unregistered tool is **denied** (fail closed). Pair with
network/filesystem controls for defense in depth.

Apache-2.0. Part of the Lodestar monorepo (`runtimes/runtime-client/`).
