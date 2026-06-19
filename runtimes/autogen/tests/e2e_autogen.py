#!/usr/bin/env python3
"""End-to-end driver for the AutoGen runtime adapter (ADR-0027 / ADR-0024 §8).

Drives REAL AutoGen tools through the `lodestar-autogen` hook and the TypeScript
governance-gate sidecar, exercising the real-runtime cases the in-TS
`runtime-gate-enforces-two-phase` probe cannot:

  1. govern_tools returns governed wrappers only; a governed L1 call executes
     through AutoGen's own execution path (`StaticWorkbench.call_tool`, the exact
     dispatch an `AssistantAgent` uses) — the body runs exactly once, remoted back;
  2. a custom step invokes a governed tool via ``governed_call``;
  3. an async-implemented AutoGen tool (an async ``FunctionTool``) runs through the
     gate's remoted execute (the hook drives its coroutine with ``asyncio.run`` on
     the loop-less worker thread); a custom ``BaseTool`` subclass works too;
  4. concurrent in-flight calls are correlated to the right result;
  5. an L4 tool is HELD (two-phase across the boundary): with no approver it
     times out and the body NEVER runs — both through ``governed_call`` (raises)
     and through the framework path (``call_tool`` surfaces an error ``ToolResult``);
  6. a tool that was never registered is DENIED — fail closed;
  7. the governed wrappers are valid AutoGen ``BaseTool``s the framework accepts —
     they attach to a real ``AssistantAgent`` (a stub model client, no LLM/key);
  8. a non-finite float in an argument or a result fails the call rather than
     hanging it (Python's json would otherwise emit invalid ``NaN``).

Spawns the gate via ``bun run <repo>/packages/cli/src/index.ts runtime gate``.
Invoked by the runtime-gated ``autogen-tool-calls-are-governed`` probe, which skips
loudly when Python / AutoGen is absent. Exit 0 = pass, 1 = fail.
"""

from __future__ import annotations

import asyncio
import json
import math
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI_INDEX = REPO_ROOT / "packages" / "cli" / "src" / "index.ts"

# Prefer the INSTALLED hook so CI (which pip-installs runtimes/autogen) actually
# exercises the packaged artifact and its pyproject exports. Only fall back to the
# source tree for a local run where the hook isn't installed.
try:
    from lodestar_autogen import (  # noqa: E402
        GateClient,
        GateError,
        LodestarDenied,
        govern_tools,
        governed_call,
    )
except ImportError:
    sys.path.insert(0, str(REPO_ROOT / "runtimes" / "autogen"))
    from lodestar_autogen import (  # noqa: E402
        GateClient,
        GateError,
        LodestarDenied,
        govern_tools,
        governed_call,
    )

try:
    from autogen_core import CancellationToken
    from autogen_core.models import ChatCompletionClient, RequestUsage
    from autogen_core.tools import BaseTool, FunctionTool, StaticWorkbench
    from autogen_agentchat.agents import AssistantAgent
    from pydantic import BaseModel, Field
except Exception as exc:  # pragma: no cover - the probe gates on import availability
    print(f"SKIP: AutoGen not importable: {exc}")
    sys.exit(0)

# ── tool bodies (the REAL functions the gate remotes back to run) ─────────────
runs: dict[str, int] = {"echo": 0, "read_doc": 0, "deploy": 0, "fetch": 0}


def echo(msg: str) -> dict:
    """echo a message back"""
    runs["echo"] += 1
    return {"echo": msg}


def deploy(target: str) -> dict:
    """deploy to a target (irreversible, L4)"""
    runs["deploy"] += 1  # must stay 0 for a held L4 with no approver
    return {"deployed": target}


async def fetch(url: str) -> dict:
    """fetch a url (async-implemented tool)"""
    runs["fetch"] += 1
    return {"fetched": url}


def nan_out(x: int) -> dict:
    """returns a non-finite float (invalid JSON for the gate)"""
    # The hook must reject this (→ tool_error → failed action), never emit `NaN`.
    return {"output": {"value": float("nan")}}


class ReadDocArgs(BaseModel):
    path: str = Field(..., description="path to read")


class ReadDoc(BaseTool):  # type: ignore[type-arg]
    """A custom BaseTool subclass (async run) that surfaces untrusted content."""

    def __init__(self) -> None:
        super().__init__(args_type=ReadDocArgs, return_type=dict, name="read_doc", description="read an (untrusted) document")

    async def run(self, args: ReadDocArgs, cancellation_token: CancellationToken) -> dict:
        runs["read_doc"] += 1
        # Surface untrusted document content for external_document evidence.
        return {"output": {"read": args.path}, "_lodestar_documents": [{"text": "untrusted file body", "source": args.path}]}


# A no-network stub model client so a real AssistantAgent can be constructed
# (construction validates the toolset); we never run inference.
class _StubModelClient(ChatCompletionClient):  # type: ignore[misc]
    @property
    def model_info(self) -> dict:
        return {
            "vision": False,
            "function_calling": True,
            "json_output": False,
            "family": "unknown",
            "structured_output": False,
            "multiple_system_messages": True,
        }

    @property
    def capabilities(self) -> dict:
        return self.model_info

    async def create(self, *a: Any, **k: Any) -> Any:
        raise NotImplementedError("stub model client: no inference in the e2e")

    def create_stream(self, *a: Any, **k: Any) -> Any:
        raise NotImplementedError("stub model client: no inference in the e2e")

    async def close(self) -> None:
        return None

    def actual_usage(self) -> RequestUsage:
        return RequestUsage(prompt_tokens=0, completion_tokens=0)

    def total_usage(self) -> RequestUsage:
        return RequestUsage(prompt_tokens=0, completion_tokens=0)

    def count_tokens(self, messages: Any, *, tools: Any = []) -> int:
        return 0

    def remaining_tokens(self, messages: Any, *, tools: Any = []) -> int:
        return 0


failures: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {label}" + (f" — {extra}" if extra else ""))
    if not cond:
        failures.append(label)


def call_tool_sync(workbench: Any, name: str, args: dict) -> Any:
    """Drive a tool through AutoGen's real dispatch path (the agent uses this)."""
    return asyncio.run(workbench.call_tool(name, args, CancellationToken()))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        log_root = str(Path(tmp) / "events")
        config = {
            "project_id": "autogen-e2e",
            "actor_id": "autogen-agent",
            "session_id": "auto",
            "log_root": log_root,
            "default_scope": {"level": "session", "identifier": "autogen-e2e"},
            "default_sensitivity": "internal",
            "auto_approve_ceiling": 3,
            # An L4 hold parks; with no approver it must time out fast here.
            "approval_timeout_ms": 300,
            "approvals": {"allow_unsigned": True},
            "tool_defaults": {
                "echo": {"required_trust_level": 1, "reversibility": "reversible", "sandbox": "read", "permissions": [], "blast_radius": "session"},
                "read_doc": {"required_trust_level": 1, "reversibility": "reversible", "sandbox": "read", "permissions": [], "blast_radius": "session"},
                "deploy": {"required_trust_level": 4, "reversibility": "irreversible", "sandbox": "controlled-shell", "permissions": [], "blast_radius": "external"},
                "fetch": {"required_trust_level": 1, "reversibility": "reversible", "sandbox": "read", "permissions": [], "blast_radius": "session"},
                "nan_out": {"required_trust_level": 1, "reversibility": "reversible", "sandbox": "read", "permissions": [], "blast_radius": "session"},
            },
        }
        config_path = Path(tmp) / "runtime-gate.config.json"
        config_path.write_text(json.dumps(config))

        # P3: a sidecar that exits before `ready` (here: an invalid config the CLI
        # rejects) must fail construction FAST with a useful message, not block the
        # full ready timeout.
        bad_config = Path(tmp) / "bad.config.json"
        bad_config.write_text("{}")  # missing required fields → the CLI exits 1
        t0 = time.monotonic()
        startup_err = None
        try:
            GateClient(str(bad_config), launcher=["bun", "run", str(CLI_INDEX)], ready_timeout_s=20)
        except GateError as exc:
            startup_err = str(exc)
        elapsed = time.monotonic() - t0
        check("P3: bad-config startup fails fast (not after the ready timeout)", startup_err is not None and elapsed < 10, f"{elapsed:.1f}s")
        check("P3: the failure reports the gate exited before ready", startup_err is not None and "before signalling ready" in startup_err, str(startup_err))

        with GateClient(str(config_path), launcher=["bun", "run", str(CLI_INDEX)]) as gate:
            print("─" * 72)
            print("autogen-tool-calls-are-governed (real AutoGen tools + hook + gate)")
            print("─" * 72)

            echo_t = FunctionTool(echo, description="echo a message back", name="echo")
            deploy_t = FunctionTool(deploy, description="deploy to a target (irreversible, L4)", name="deploy")
            fetch_t = FunctionTool(fetch, description="fetch a url (async-implemented tool)", name="fetch")
            nan_t = FunctionTool(nan_out, description="returns a non-finite float", name="nan_out")
            read_doc_t = ReadDoc()
            tools = [echo_t, read_doc_t, deploy_t, fetch_t, nan_t]

            governed = govern_tools(gate, tools, hold_wait_ms=2_000)
            governed_by_name = {t.name: t for t in governed}
            check("0: only governed wrappers are exposed", set(governed_by_name) == {"echo", "read_doc", "deploy", "fetch", "nan_out"}, str(set(governed_by_name)))
            # The wrappers are real AutoGen BaseTools (not the originals).
            check("0: wrappers are BaseTool instances, distinct from the originals", all(isinstance(t, BaseTool) for t in governed) and governed_by_name["echo"] is not echo_t, "")
            # The original schema is preserved (the model sees the right parameters).
            check("0: governed echo preserves the original schema", list(governed_by_name["echo"].schema["parameters"]["properties"]) == ["msg"], str(governed_by_name["echo"].schema["parameters"]["properties"]))

            # The governed wrappers dispatch through AutoGen's REAL execution path:
            # StaticWorkbench.call_tool → tool.run_json → the gate.
            wb = StaticWorkbench(governed)

            # 1. a governed L1 tool runs through the workbench; the body runs once,
            #    remoted back. call_tool returns a (stringified) ToolResult.
            r = call_tool_sync(wb, "echo", {"msg": "hi"})
            check("1: StaticWorkbench.call_tool ran the governed echo", (not r.is_error) and json.loads(r.result[0].content) == {"echo": "hi"}, str(r.result[0].content))
            check("1: echo body ran exactly once", runs["echo"] == 1, str(runs["echo"]))

            # 2. custom step via governed_call (returns the structured output).
            res = governed_call(gate, "echo", {"msg": "from-step"})
            check("2: governed_call returned the tool output", res == {"echo": "from-step"}, str(res))
            check("2: echo body ran again exactly once", runs["echo"] == 2, str(runs["echo"]))

            # 2b. a custom BaseTool subclass with an async run, surfacing untrusted
            #     document content, runs through the gate's remoted execute.
            doc = governed_call(gate, "read_doc", {"path": "/notes.md"})
            check("2b: custom BaseTool subclass ran via the gate", doc == {"read": "/notes.md"}, str(doc))
            check("2b: read_doc body ran once", runs["read_doc"] == 1, str(runs["read_doc"]))

            # 3. an async-implemented tool runs via the gate's remoted execute (the
            #    hook drives its coroutine with asyncio.run on the worker thread),
            #    through BOTH the framework path and a direct governed_call.
            afetch = call_tool_sync(wb, "fetch", {"url": "https://x"})
            check("3: async tool ran via StaticWorkbench.call_tool", (not afetch.is_error) and json.loads(afetch.result[0].content) == {"fetched": "https://x"}, str(afetch.result[0].content))
            res_async = governed_call(gate, "fetch", {"url": "https://y"})
            check("3: async tool ran via governed_call", res_async == {"fetched": "https://y"}, str(res_async))
            check("3: async tool body ran exactly twice", runs["fetch"] == 2, str(runs["fetch"]))

            # 4. concurrent in-flight calls are each correlated to their own result.
            before = runs["echo"]
            results: dict[str, object] = {}
            errors: list[str] = []

            def call(tag: str) -> None:
                try:
                    results[tag] = governed_call(gate, "echo", {"msg": tag})
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{tag}: {exc}")

            threads = [threading.Thread(target=call, args=(f"C{i}",)) for i in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            check("4: concurrent calls all returned", len(results) == 4 and not errors, f"{results} errs={errors}")
            check("4: each concurrent call correlated to its own arg", all(results.get(f"C{i}") == {"echo": f"C{i}"} for i in range(4)), str(results))
            check("4: all concurrent bodies ran", runs["echo"] - before == 4, str(runs["echo"] - before))

            # 5. L4 tool is HELD (two-phase across the boundary): with no approver
            #    it times out and the body NEVER runs.
            deploy_before = runs["deploy"]
            denied_kind = None
            try:
                governed_call(gate, "deploy", {"target": "prod"}, hold_wait_ms=2_000)
            except LodestarDenied as denied:
                denied_kind = denied.kind
            check("5: L4 deploy was held then denied", denied_kind == "approval_timeout", str(denied_kind))
            check("5: deploy body NEVER ran (no work before approval)", runs["deploy"] - deploy_before == 0, str(runs["deploy"] - deploy_before))
            # Through the framework path, the workbench catches the denial and
            # surfaces it as an error ToolResult (re-plannable for the agent).
            framework = call_tool_sync(wb, "deploy", {"target": "prod2"})
            check("5: held L4 surfaces as an error ToolResult via call_tool", framework.is_error and "approval" in framework.result[0].content.lower(), str(framework.result[0].content))
            check("5: deploy body STILL never ran", runs["deploy"] - deploy_before == 0, str(runs["deploy"] - deploy_before))

            # 6. a tool that was never registered is denied — fail closed.
            ghost_kind = None
            try:
                governed_call(gate, "never_registered", {})
            except LodestarDenied as denied:
                ghost_kind = denied.kind
            check("6: unregistered tool denied (fail closed)", ghost_kind == "unregistered_tool", str(ghost_kind))

            # 7. the governed wrappers are valid AutoGen tools the framework accepts:
            #    they attach to a real AssistantAgent (construction validates the
            #    toolset; a stub model client means no LLM call / API key needed).
            agent_ok = None
            try:
                agent = AssistantAgent("ops", model_client=_StubModelClient(), tools=governed)
                agent_ok = {t.name for t in agent._tools} == {"echo", "read_doc", "deploy", "fetch", "nan_out"}
            except Exception as exc:  # noqa: BLE001
                agent_ok = False
                print(f"      (AssistantAgent construction raised: {exc})")
            check("7: governed wrappers attach to a real AssistantAgent", agent_ok is True, str(agent_ok))

            # 8. Non-finite floats are rejected before they corrupt the JSON wire,
            #    so a NaN in args or a tool result fails the call rather than
            #    hanging it.
            arg_nan_err = None
            try:
                governed_call(gate, "echo", {"msg": math.nan})
            except GateError:
                arg_nan_err = "gate_error"
            except LodestarDenied as denied:
                arg_nan_err = denied.kind
            check("8: a NaN argument is rejected, not silently hung", arg_nan_err is not None, str(arg_nan_err))

            out_nan_err = None
            try:
                governed_call(gate, "nan_out", {"x": 1})
            except LodestarDenied as denied:
                out_nan_err = denied.kind
            except GateError:
                out_nan_err = "gate_error"
            check("8: a NaN tool result fails the action, not silently hung", out_nan_err is not None, str(out_nan_err))

            print("─" * 72)
            if failures:
                print(f"RESULT: FAIL ({len(failures)} check(s) failed)")
            else:
                print("RESULT: PASS — AutoGen native tool calls are governed end-to-end")
            print("─" * 72)
            return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
