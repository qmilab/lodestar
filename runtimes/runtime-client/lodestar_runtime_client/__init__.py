"""lodestar-runtime-client — the shared Python RPC client for Lodestar runtime hooks.

`GateClient` spawns the TypeScript governance-gate sidecar (`lodestar runtime
gate`) and speaks newline-delimited JSON-RPC to it, remoting each native tool call
through the Lodestar Action Kernel (two-phase execution, policy gate,
cognitive-core ingestion, sentinel arbitration, signed-approval hold path) over a
thin bidirectional channel — ADR-0024.

It is pure stdlib and framework-agnostic: the per-framework hooks
(`lodestar-langgraph`, `lodestar-crewai`, `lodestar-autogen`) depend on it and add
only the thin framework binding in their own `adapter` module. Extracted from the
three hooks in #128 (ADR-0028) — it was previously a verbatim copy in each.

Quick start::

    from lodestar_runtime_client import GateClient

    with GateClient("runtime-gate.config.json") as gate:
        gate.register_tool("my_tool", lambda args: {"output": ...})
        result = gate.govern("my_tool", {"x": 1})
"""

from .client import GateClient, GateError, ToolBody

__all__ = ["GateClient", "GateError", "ToolBody"]

__version__ = "0.3.0"
