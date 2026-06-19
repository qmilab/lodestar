"""lodestar-crewai — govern a CrewAI crew's native tool calls with Lodestar.

The thin native hook of the runtime-adapter epic (ADR-0024 / ADR-0026). It spawns
the TypeScript governance-gate sidecar (``lodestar runtime gate``) and remotes
each native CrewAI tool call through the Action Kernel over NDJSON-RPC — so the
same two-phase execution, policy gate, cognitive-core ingestion, sentinel
arbitration, and signed-approval hold path the MCP proxy and the LangGraph
adapter run now apply to CrewAI, a framework that does not speak MCP. The gate
sidecar is shared, unchanged; only this hook is new.

Quick start::

    from crewai import Agent, Crew, Task
    from lodestar_crewai import GateClient, govern_tools, governed_call

    with GateClient("runtime-gate.config.json") as gate:
        governed = govern_tools(gate, my_tools)   # register + wrap the toolset
        agent = Agent(role="researcher", goal="...", backstory="...", tools=governed)
        # ... build and run your crew as usual; every tool call is now governed.
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
