"""lodestar-autogen — govern an AutoGen agent's native tool calls with Lodestar.

The thin native hook of the runtime-adapter epic (ADR-0024 / ADR-0027), and the
third framework on the same shared gate (after LangGraph and CrewAI). It spawns
the TypeScript governance-gate sidecar (``lodestar runtime gate``) and remotes
each native AutoGen tool call through the Action Kernel over NDJSON-RPC — so the
same two-phase execution, policy gate, cognitive-core ingestion, sentinel
arbitration, and signed-approval hold path the MCP proxy and the LangGraph /
CrewAI adapters run now apply to AutoGen, a framework that does not speak MCP. The
gate sidecar is shared, unchanged; only this hook is new.

Quick start::

    from autogen_agentchat.agents import AssistantAgent
    from lodestar_autogen import GateClient, govern_tools, governed_call

    with GateClient("runtime-gate.config.json") as gate:
        governed = govern_tools(gate, my_tools)   # register + wrap the toolset
        agent = AssistantAgent("assistant", model_client=..., tools=governed)
        # ... run your agent/team as usual; every tool call is now governed.
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
