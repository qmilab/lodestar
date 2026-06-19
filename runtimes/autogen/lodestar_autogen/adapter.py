"""AutoGen integration for the Lodestar governance gate (ADR-0024 / ADR-0027).

AutoGen (the ``autogen-agentchat`` / ``autogen-core`` actor framework) runs
multi-agent conversations whose tools are native in-process
``autogen_core.tools.BaseTool`` objects; it does not speak MCP, so the MCP proxy
cannot wrap it. This adapter is the thin native hook (ADR-0027): it reuses the
**same** language-agnostic governance-gate sidecar the LangGraph and CrewAI
adapters do and governs AutoGen's **tool-invocation surface** and nothing
implicitly (ADR-0024 §3, one closed fail-closed surface):

* :func:`govern_tools` registers every tool with the gate and returns *wrapped*
  ``BaseTool``s to hand to the ``AssistantAgent`` (and any ``Workbench``) — a
  governed wrapper is the only object an agent ever holds for a governed
  capability. The wrapper routes each call through the gate (``propose →
  arbitrate``); only on an ``allow`` does the gate remote the body back to run.
  The wrapper overrides ``run_json`` — the exact point AutoGen executes a tool
  through (``AssistantAgent`` dispatches via ``StaticWorkbench.call_tool``, which
  calls ``tool.run_json``; a direct caller hits the same method).
* :func:`governed_call` is the helper a **custom step** (a callback / handler that
  invokes a tool directly) uses to call a governed tool — never a raw tool body.
* A call for a tool that was never registered is **denied by the gate** (fail
  closed). Raw I/O performed outside the tool abstraction is outside the governed
  surface, exactly as ``guard.wrap()`` and the MCP proxy only govern the tools
  they are given — pair with network/filesystem controls for defense in depth.

When a governed call is denied/held-then-timed-out, the default re-raises
:class:`LodestarDenied`; AutoGen's ``StaticWorkbench.call_tool`` catches it and
surfaces the reason to the agent as a re-plannable error ``ToolResult``. Pass
``on_denied`` to map a denial to a return value instead.

Holds (an L4 action the trust-ladder floor parks for approval) are resolved by
**block-polling** the gate up to the deadline for a *signed* approval
(``hold_wait_ms``) — the headless default the ADR sanctions.

AutoGen's tool surface is **fully async** (``run`` / ``run_json`` are coroutines).
The governed wrapper therefore offloads the blocking gate RPC onto a worker thread
(:func:`asyncio.to_thread`) so it never stalls the agent's event loop, and the
gate's remoted body runs the original tool's coroutine via ``asyncio.run`` on the
client's (loop-less) worker thread.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Callable, Iterable, Optional

from .client import GateClient

# Default block-poll budget for a held action, in ms. Keep comfortably under the
# gate/client timeout; 0 means "don't wait" (surface the hold immediately).
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
    unregistered tool — fail closed). This is the helper a custom AutoGen step
    calls; never invoke a raw tool body from a custom step.

    This call **blocks**; from inside an AutoGen coroutine, call it via
    ``await asyncio.to_thread(governed_call, ...)`` so it does not stall the loop
    (the governed-tool wrapper already does this for the agent's own tool calls).
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
    """Register and wrap an AutoGen toolset for governance.

    Returns governed ``BaseTool``s to assign to your ``AssistantAgent`` (and any
    ``Workbench``), so an agent never holds an ungoverned handle. Each wrapper runs
    the call through the gate; the gate remotes the *original* tool body back to
    run only inside its execute phase.

    ``on_denied`` maps a :class:`LodestarDenied` to a tool return value; the
    default re-raises, which AutoGen's ``StaticWorkbench.call_tool`` turns into a
    re-plannable error ``ToolResult`` for the agent.
    """
    # Imported lazily so `from lodestar_autogen import GateClient` works without
    # autogen installed (the client is pure stdlib). pydantic + CancellationToken
    # come in with autogen-core.
    from autogen_core import CancellationToken
    from autogen_core.tools import BaseTool, FunctionTool
    from pydantic import BaseModel

    cls = _governed_tool_cls()
    governed: list[Any] = []
    for tool in tools:
        # Accept the same toolset shapes AssistantAgent does — a BaseTool as-is, a
        # bare callable normalised to a FunctionTool — so `govern_tools(gate, tools)`
        # works on the exact `tools=[...]` list the agent would take, not only
        # pre-wrapped BaseTools.
        tool = _normalize_tool(tool, BaseTool, FunctionTool)
        # Bind the ORIGINAL tool body for the gate's remoted execute. Using the
        # original (not the wrapper) is what prevents recursion.
        client.register_tool(tool.name, _body_for(tool, CancellationToken, BaseModel))
        governed.append(_wrap_tool(cls, client, tool, hold_wait_ms, on_denied))
    return governed


def _normalize_tool(tool: Any, base_tool_cls: Any, function_tool_cls: Any) -> Any:
    """Mirror ``AssistantAgent``'s tool ingestion: a ``BaseTool`` is used as-is; a
    bare callable is wrapped in a ``FunctionTool`` (its ``__doc__`` as the
    description, exactly as the agent does). So ``govern_tools`` accepts the same
    ``tools=[...]`` shapes the framework does — passing a plain function no longer
    fails on a missing ``.name``."""
    if isinstance(tool, base_tool_cls):
        return tool
    if callable(tool):
        description = tool.__doc__ if getattr(tool, "__doc__", None) else ""
        return function_tool_cls(tool, description=description)
    raise TypeError(f"govern_tools: unsupported tool type {type(tool)!r}")


# A single persistent event loop on a dedicated daemon thread runs every remoted
# tool coroutine. AutoGen's tool surface is *fully* async, so a fresh `asyncio.run`
# per call would bind any loop-scoped state a tool caches (an `aiohttp.ClientSession`,
# an `asyncio.Event`/`Queue`, a pooled DB connection) to a loop that is then torn
# down — the next call on a new loop would fail cross-loop. One stable loop keeps
# that state valid across calls. Lazily created; never touched on the import path.
_tool_loop_lock = threading.Lock()
_tool_loop_holder: dict[str, Any] = {"loop": None}


def _tool_loop() -> Any:
    with _tool_loop_lock:
        loop = _tool_loop_holder["loop"]
        if loop is None:
            loop = asyncio.new_event_loop()
            threading.Thread(
                target=loop.run_forever, name="lodestar-autogen-tool-loop", daemon=True
            ).start()
            _tool_loop_holder["loop"] = loop
    return loop


def _body_for(tool: Any, cancellation_token_cls: Any, base_model_cls: Any) -> Callable[[dict], dict]:
    """A run_tool body that executes the real AutoGen tool and wraps its result
    into the gate's tool-result shape.

    AutoGen's tool surface is fully async — ``run_json`` validates the args against
    the tool's ``args_type`` and awaits ``run``. The gate remotes this body on a
    worker thread with no running event loop; we drive the coroutine on the shared
    persistent tool loop (so loop-scoped state a tool caches survives across calls,
    unlike a fresh ``asyncio.run`` per call) and block this worker thread on the
    result. A Pydantic-model result is dumped to a JSON-safe value for the wire; a
    non-finite float is rejected by the client before it can corrupt the JSON (→
    ``tool_error`` → failed action), never silently emitted as ``NaN``.
    """

    def body(args: dict) -> dict:
        loop = _tool_loop()
        future = asyncio.run_coroutine_threadsafe(tool.run_json(args, cancellation_token_cls()), loop)
        output = future.result()
        # Normalise a Pydantic-model return to a JSON-safe value for the wire.
        if isinstance(output, base_model_cls):
            output = output.model_dump(mode="json")
        documents: list[dict] = []
        # A tool may surface untrusted document content for external_document
        # evidence by returning {"output": ..., "_lodestar_documents": [...]}.
        if isinstance(output, dict) and "_lodestar_documents" in output:
            documents = list(output.get("_lodestar_documents") or [])
            output = output.get("output")
        return {"output": output, "documents": documents}

    return body


# The governed BaseTool subclass is built once, lazily — so importing
# `lodestar_autogen` (e.g. `from lodestar_autogen import GateClient`) does not require
# autogen installed (the client is pure stdlib). Cached module-wide.
_GOVERNED_TOOL_CLS: Optional[type] = None


def _governed_tool_cls() -> type:
    global _GOVERNED_TOOL_CLS
    if _GOVERNED_TOOL_CLS is not None:
        return _GOVERNED_TOOL_CLS
    # Imported lazily; see above.
    from autogen_core import CancellationToken
    from autogen_core.tools import BaseTool

    class _GovernedAutoGenTool(BaseTool):  # type: ignore[type-arg]
        """A governed ``BaseTool`` that presents the original's schema but routes
        every call through the gate. Not a Pydantic model (AutoGen's ``BaseTool``
        is a plain class), so the gate reference + per-tool config live in plain
        instance attributes — they are never part of the tool's serialised schema
        (the description the LLM sees) and are not validated as tool inputs.
        """

        def __init__(self, original: Any, gov: dict) -> None:
            super().__init__(
                args_type=original.args_type(),
                return_type=original.return_type(),
                name=original.name,
                description=original.description,
                strict=bool(getattr(original, "_strict", False)),
            )
            self._original = original
            self._gov = gov

        # Delegate the schema surface to the original so a custom override (or a
        # FunctionTool's generated schema) is preserved verbatim — the model sees
        # exactly the original's parameters, not one regenerated from the wrapper.
        @property
        def schema(self) -> Any:
            return self._original.schema

        def args_type(self) -> Any:
            return self._original.args_type()

        def return_type(self) -> Any:
            return self._original.return_type()

        def state_type(self) -> Any:
            return self._original.state_type()

        def return_value_as_string(self, value: Any) -> str:
            # The value has crossed the JSON wire, so it is a str / dict / list /
            # primitive (not the original Pydantic model). Stringify deterministically.
            if isinstance(value, str):
                return value
            try:
                return json.dumps(value)
            except (TypeError, ValueError):
                return str(value)

        async def run_json(self, args: Any, cancellation_token: Any = None, call_id: Optional[str] = None) -> Any:
            # The choke point the workbench / agent dispatches through.
            return await self._governed(dict(args or {}), cancellation_token)

        async def run(self, args: Any, cancellation_token: Any = None) -> Any:
            # The abstract method; also governs a direct programmatic caller that
            # already validated its args into the model. run_json does NOT delegate
            # here, so there is no double-governing.
            payload = args.model_dump() if hasattr(args, "model_dump") else dict(args or {})
            return await self._governed(payload, cancellation_token)

        async def _governed(self, payload: dict, cancellation_token: Any = None) -> Any:
            gov = self._gov
            # Honour an already-cancelled run: don't even propose the action, so a
            # cancelled agent run starts no new governed work (no body, no event).
            if cancellation_token is not None and cancellation_token.is_cancelled():
                raise asyncio.CancelledError()
            # Offload the blocking gate RPC onto a worker thread so the agent's event
            # loop is never stalled by govern/resume; link the agent's cancellation
            # token so cancelling the run promptly unblocks this await. NOTE: once the
            # gate reaches its execute phase the remoted body runs server-side and
            # cannot be force-cancelled across the RPC boundary — a documented boundary
            # of the remoted-execute model (ADR-0027 §2). The early-cancel check above
            # is what prevents a *new* call from starting on an already-cancelled run.
            task = asyncio.ensure_future(
                asyncio.to_thread(governed_call, gov["client"], gov["name"], payload, hold_wait_ms=gov["hold_wait_ms"])
            )
            if cancellation_token is not None:
                cancellation_token.link_future(task)
            try:
                return await task
            except LodestarDenied as denied:
                on_denied = gov["on_denied"]
                if on_denied is not None:
                    return on_denied(denied)
                # Re-raise: AutoGen's StaticWorkbench.call_tool catches it and
                # surfaces the reason as a re-plannable error ToolResult.
                raise

    _GOVERNED_TOOL_CLS = _GovernedAutoGenTool
    return _GOVERNED_TOOL_CLS


def _wrap_tool(
    cls: type,
    client: GateClient,
    tool: Any,
    hold_wait_ms: int,
    on_denied: Optional[Callable[[LodestarDenied], Any]],
) -> Any:
    return cls(
        tool,
        {
            "client": client,
            "name": tool.name,
            "hold_wait_ms": hold_wait_ms,
            "on_denied": on_denied,
        },
    )
