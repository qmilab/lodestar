"""LangGraph / LangChain integration for the Lodestar governance gate (ADR-0024).

The adapter governs the framework's **tool-invocation surface** and nothing
implicitly (ADR-0024 §3, one closed fail-closed surface):

* :func:`govern_tools` registers every bound tool with the gate and returns
  *wrapped* tools to hand to ``bind_tools`` AND the prebuilt ``ToolNode`` — a
  governed wrapper is the only object the agent ever holds for a governed
  capability. The wrapper routes each call through the gate (``propose →
  arbitrate``); only on an ``allow`` does the gate remote the body back to run.
* :func:`governed_call` is the helper a **custom node** uses to invoke a governed
  tool — never a raw tool function.
* A call for a tool that was never registered is **denied by the gate** (fail
  closed). Raw I/O performed outside the tool abstraction is outside the governed
  surface, exactly as ``guard.wrap()`` and the MCP proxy only govern the tools
  they are given — pair with network/filesystem controls for defense in depth.

Holds (an L4 action the trust-ladder floor parks for approval) are resolved by
**block-polling** the gate up to the deadline for a *signed* approval
(``hold_wait_ms``) — the headless default the ADR sanctions. For the idiomatic
LangGraph ``interrupt()`` integration, call :func:`GateClient.govern` directly
and raise ``interrupt`` with the returned ``action_id`` / ``request_id``, then
:func:`GateClient.resume` on ``Command(resume=…)``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Iterable, Optional

from lodestar_runtime_client import GateClient

# Default block-poll budget for a held action, in ms. Keep comfortably under the
# graph/client timeout; 0 means "don't wait" (surface the hold immediately).
DEFAULT_HOLD_WAIT_MS = 60_000


class LodestarDenied(Exception):
    """A governed tool call was denied, held-then-timed-out, or failed.

    ``kind`` is the machine tag from the gate (``policy_denied``,
    ``approval_denied``, ``approval_timeout``, ``unregistered_tool``,
    ``precondition_failed``, ``execution_failed``).
    """

    def __init__(self, reason: str, kind: str, action_id: Optional[str] = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.kind = kind
        self.action_id = action_id


def governed_call(
    client: GateClient,
    tool: str,
    args: dict,
    *,
    hold_wait_ms: int = DEFAULT_HOLD_WAIT_MS,
) -> Any:
    """Invoke a governed tool through the gate and return its output.

    Drives the full two-phase flow: ``govern``; on a hold, block-poll ``resume``
    up to ``hold_wait_ms`` for a signed approval; on completion, return the tool
    output. Raises :class:`LodestarDenied` on any non-completion (including an
    unregistered tool — fail closed). This is the helper a custom LangGraph node
    calls; never invoke a raw tool function from a custom node.
    """
    result = client.govern(tool, args)
    if result.get("phase") == "pending_approval":
        result = client.resume(
            str(result.get("action_id")),
            str(result.get("request_id")),
            wait_ms=hold_wait_ms,
        )
    phase = result.get("phase")
    if phase == "completed":
        return result.get("output")
    raise LodestarDenied(
        str(result.get("reason") or "governed tool call was not allowed"),
        str(result.get("kind") or phase or "denied"),
        result.get("action_id"),
    )


def govern_tools(
    client: GateClient,
    tools: Iterable[Any],
    *,
    hold_wait_ms: int = DEFAULT_HOLD_WAIT_MS,
    on_denied: Optional[Callable[[LodestarDenied], Any]] = None,
) -> list[Any]:
    """Register and wrap a LangChain toolset for governance.

    Returns governed ``StructuredTool``s to pass to BOTH ``llm.bind_tools(...)``
    and the prebuilt ``ToolNode(...)``, so the agent never holds an ungoverned
    handle. Each wrapper runs the call through the gate; the gate remotes the
    *original* tool body back to run only inside its execute phase.

    ``on_denied`` maps a :class:`LodestarDenied` to a tool return value (so a
    ``ToolNode`` surfaces a re-plannable message rather than raising); the default
    re-raises as a ``ToolException`` so the framework's own error handling
    applies.
    """
    # Imported lazily so `from lodestar_langgraph import GateClient` works without
    # langchain installed (the client is pure stdlib).
    from langchain_core.tools import StructuredTool, ToolException

    governed: list[Any] = []
    for tool in tools:
        name = tool.name
        # Bind the ORIGINAL tool body for the gate's remoted execute. Using the
        # original (not the wrapper) is what prevents recursion.
        client.register_tool(name, _body_for(tool))
        governed.append(_wrap_tool(client, tool, hold_wait_ms, on_denied, StructuredTool, ToolException))
    return governed


def _body_for(tool: Any) -> Callable[[dict], dict]:
    """A run_tool body that executes the real LangChain tool and wraps its result
    into the gate's tool-result shape.

    The gate remotes the body on a worker thread with no running event loop, so we
    use the synchronous ``tool.invoke`` for a tool with a sync implementation, and
    fall back to running the coroutine for an **async-only** tool (one defined with
    a ``coroutine`` and no sync ``func``): for such a tool ``invoke`` raises
    ``NotImplementedError``, so it must go through ``ainvoke``. This serves both
    sync and async tools regardless of whether the graph drove ``invoke`` or
    ``ainvoke``.
    """

    def body(args: dict) -> dict:
        try:
            output = tool.invoke(args)
        except NotImplementedError:
            # Async-only tool: run its coroutine in this (loop-less) worker thread.
            output = asyncio.run(tool.ainvoke(args))
        documents: list[dict] = []
        # A tool may surface untrusted document content for external_document
        # evidence by returning {"output": ..., "_lodestar_documents": [...]}.
        if isinstance(output, dict) and "_lodestar_documents" in output:
            documents = list(output.get("_lodestar_documents") or [])
            output = output.get("output")
        return {"output": output, "documents": documents}

    return body


def _wrap_tool(
    client: GateClient,
    tool: Any,
    hold_wait_ms: int,
    on_denied: Optional[Callable[[LodestarDenied], Any]],
    structured_tool_cls: Any,
    tool_exception_cls: Any,
) -> Any:
    def governed_func(**kwargs: Any) -> Any:
        try:
            return governed_call(client, tool.name, kwargs, hold_wait_ms=hold_wait_ms)
        except LodestarDenied as denied:
            if on_denied is not None:
                return on_denied(denied)
            raise tool_exception_cls(f"[lodestar:{denied.kind}] {denied.reason}") from denied

    return structured_tool_cls.from_function(
        func=governed_func,
        name=tool.name,
        description=getattr(tool, "description", "") or tool.name,
        args_schema=getattr(tool, "args_schema", None),
    )
