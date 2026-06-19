"""CrewAI integration for the Lodestar governance gate (ADR-0024 / ADR-0026).

CrewAI runs role-based agents whose tools are native in-process Python
``crewai.tools.BaseTool`` objects; it does not speak MCP, so the MCP proxy cannot
wrap it. This adapter is the thin native hook (ADR-0026): it reuses the **same**
language-agnostic governance-gate sidecar the LangGraph adapter does and governs
CrewAI's **tool-invocation surface** and nothing implicitly (ADR-0024 §3, one
closed fail-closed surface):

* :func:`govern_tools` registers every tool with the gate and returns *wrapped*
  ``BaseTool``s to hand to the ``Agent``/``Crew`` — a governed wrapper is the only
  object an agent ever holds for a governed capability. The wrapper routes each
  call through the gate (``propose → arbitrate``); only on an ``allow`` does the
  gate remote the body back to run. The wrapper overrides ``_run`` — the exact
  point CrewAI executes a tool through (``BaseTool.run`` and the framework's
  ``CrewStructuredTool`` both dispatch to ``_run``).
* :func:`governed_call` is the helper a **custom step** (a ``@task``/callback that
  invokes a tool directly) uses to call a governed tool — never a raw tool body.
* A call for a tool that was never registered is **denied by the gate** (fail
  closed). Raw I/O performed outside the tool abstraction is outside the governed
  surface, exactly as ``guard.wrap()`` and the MCP proxy only govern the tools
  they are given — pair with network/filesystem controls for defense in depth.

When a governed call is denied/held-then-timed-out, the default re-raises
:class:`LodestarDenied`; CrewAI's ``ToolUsage`` catches it and surfaces the reason
to the agent as a re-plannable observation. Pass ``on_denied`` to map a denial to
a return value instead.

Holds (an L4 action the trust-ladder floor parks for approval) are resolved by
**block-polling** the gate up to the deadline for a *signed* approval
(``hold_wait_ms``) — the headless default the ADR sanctions.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Iterable, Optional

from lodestar_runtime_client import GateClient

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
    unregistered tool — fail closed). This is the helper a custom CrewAI step
    calls; never invoke a raw tool body from a custom step.
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
    """Register and wrap a CrewAI toolset for governance.

    Returns governed ``BaseTool``s to assign to your ``Agent``/``Crew`` (and to a
    ``Task``'s ``tools``), so an agent never holds an ungoverned handle. Each
    wrapper runs the call through the gate; the gate remotes the *original* tool
    body back to run only inside its execute phase.

    ``on_denied`` maps a :class:`LodestarDenied` to a tool return value; the
    default re-raises, which CrewAI's ``ToolUsage`` turns into a re-plannable
    error observation for the agent.
    """
    cls = _governed_tool_cls()
    governed: list[Any] = []
    for tool in tools:
        # Bind the ORIGINAL tool body for the gate's remoted execute. Using the
        # original (not the wrapper) is what prevents recursion.
        client.register_tool(tool.name, _body_for(tool))
        governed.append(_wrap_tool(cls, client, tool, hold_wait_ms, on_denied))
    return governed


def _body_for(tool: Any) -> Callable[[dict], dict]:
    """A run_tool body that executes the real CrewAI tool and wraps its result
    into the gate's tool-result shape.

    The gate remotes the body on a worker thread with no running event loop, so we
    use the synchronous ``tool.run`` for a sync tool and fall back to running the
    coroutine for an **async-only** tool (one that overrides ``_arun`` and leaves
    the abstract ``_run`` raising ``NotImplementedError``): for such a tool
    ``run`` raises ``NotImplementedError``, so it must go through ``arun``. This
    serves both sync and async CrewAI tools.
    """

    def body(args: dict) -> dict:
        try:
            output = tool.run(**args)
        except NotImplementedError:
            # Async-only tool: run its coroutine in this (loop-less) worker thread.
            output = asyncio.run(tool.arun(**args))
        documents: list[dict] = []
        # A tool may surface untrusted document content for external_document
        # evidence by returning {"output": ..., "_lodestar_documents": [...]}.
        if isinstance(output, dict) and "_lodestar_documents" in output:
            documents = list(output.get("_lodestar_documents") or [])
            output = output.get("output")
        return {"output": output, "documents": documents}

    return body


# The governed BaseTool subclass is built once, lazily — so importing
# `lodestar_crewai` (e.g. `from lodestar_crewai import GateClient`) does not require
# crewai installed (the client is pure stdlib). Cached module-wide.
_GOVERNED_TOOL_CLS: Optional[type] = None


def _governed_tool_cls() -> type:
    global _GOVERNED_TOOL_CLS
    if _GOVERNED_TOOL_CLS is not None:
        return _GOVERNED_TOOL_CLS
    # Imported lazily; see above.
    from crewai.tools import BaseTool
    from pydantic import PrivateAttr

    class _GovernedCrewTool(BaseTool):  # type: ignore[misc]
        # The gate reference + per-tool config live in a PrivateAttr, never a
        # model field, so they are not part of the tool's serialised schema (the
        # description the LLM sees) and are not validated as tool inputs.
        _gov: dict = PrivateAttr()

        def _run(self, *args: Any, **kwargs: Any) -> Any:
            gov = self._gov
            merged = dict(kwargs)
            # CrewAI's structured-tool path calls _run(**kwargs); tolerate a
            # positional call by zipping against the schema's field order.
            if args and gov["arg_names"]:
                merged.update(dict(zip(gov["arg_names"], args)))
            try:
                return governed_call(gov["client"], gov["name"], merged, hold_wait_ms=gov["hold_wait_ms"])
            except LodestarDenied as denied:
                on_denied = gov["on_denied"]
                if on_denied is not None:
                    return on_denied(denied)
                # Re-raise: CrewAI's ToolUsage catches it and surfaces the reason
                # (str(exc)) to the agent as a re-plannable observation.
                raise

    _GOVERNED_TOOL_CLS = _GovernedCrewTool
    return _GOVERNED_TOOL_CLS


def _wrap_tool(
    cls: type,
    client: GateClient,
    tool: Any,
    hold_wait_ms: int,
    on_denied: Optional[Callable[[LodestarDenied], Any]],
) -> Any:
    schema = getattr(tool, "args_schema", None)
    init_kwargs: dict[str, Any] = {
        "name": tool.name,
        "description": getattr(tool, "description", "") or tool.name,
    }
    arg_names: list[str] = []
    if schema is not None and hasattr(schema, "model_fields"):
        # Pass the ORIGINAL schema so the model sees the right parameters (and so
        # CrewAI does not regenerate an empty one from the wrapper's *args/**kwargs
        # `_run` signature).
        init_kwargs["args_schema"] = schema
        arg_names = list(schema.model_fields.keys())
    # Preserve final-answer semantics; the original's own usage limit is enforced
    # in the body (which calls the original's `run`), so it is not forwarded here.
    if getattr(tool, "result_as_answer", False):
        init_kwargs["result_as_answer"] = True

    wrapper = cls(**init_kwargs)
    wrapper._gov = {
        "client": client,
        "name": tool.name,
        "hold_wait_ms": hold_wait_ms,
        "on_denied": on_denied,
        "arg_names": arg_names,
    }
    return wrapper
