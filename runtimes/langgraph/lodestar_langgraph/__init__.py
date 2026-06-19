"""lodestar-langgraph — govern a LangGraph agent's native tool calls with Lodestar.

The thin native hook of the runtime-adapter epic (ADR-0024). It spawns the
TypeScript governance-gate sidecar (``lodestar runtime gate``) and remotes each
native LangGraph tool call through the Action Kernel over NDJSON-RPC — so the
same two-phase execution, policy gate, cognitive-core ingestion, sentinel
arbitration, and signed-approval hold path the MCP proxy runs now apply to a
framework that does not speak MCP.

Quick start::

    from lodestar_langgraph import GateClient, govern_tools, governed_call

    with GateClient("runtime-gate.config.json") as gate:
        governed = govern_tools(gate, my_tools)
        llm = llm.bind_tools(governed)
        tool_node = ToolNode(governed)
        # ... build and run your graph as usual ...
"""

from .adapter import (
    DEFAULT_HOLD_WAIT_MS,
    LodestarDenied,
    govern_tools,
    governed_call,
)
from lodestar_runtime_client import GateClient, GateError

__all__ = [
    "GateClient",
    "GateError",
    "govern_tools",
    "governed_call",
    "LodestarDenied",
    "DEFAULT_HOLD_WAIT_MS",
]

__version__ = "0.3.0"
