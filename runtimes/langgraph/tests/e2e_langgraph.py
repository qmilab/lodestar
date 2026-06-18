#!/usr/bin/env python3
"""End-to-end driver for the LangGraph runtime adapter (ADR-0024 §8).

Drives a REAL Python LangGraph loop through the `lodestar-langgraph` hook and the
TypeScript governance-gate sidecar, exercising the real-runtime cases the in-TS
`runtime-gate-enforces-two-phase` probe cannot:

  1. the prebuilt ``ToolNode`` runs only governed wrappers (a governed L1 call
     executes; the body runs exactly once, remoted back from the gate);
  2. a custom node invokes a governed tool via ``governed_call``;
  3. async invocation (``ToolNode.ainvoke``);
  4. batch / parallel invocation (``ToolNode.batch``) — correlated correctly;
  5. an L4 tool is HELD (two-phase across the boundary): with no approver it
     times out and the body NEVER runs;
  6. a tool that was never registered is DENIED — fail closed.

Spawns the gate via ``bun run <repo>/packages/cli/src/index.ts runtime gate``.
Invoked by the runtime-gated ``langgraph-tool-calls-are-governed`` probe, which
skips loudly when Python / LangGraph is absent. Exit 0 = pass, 1 = fail.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI_INDEX = REPO_ROOT / "packages" / "cli" / "src" / "index.ts"

sys.path.insert(0, str(REPO_ROOT / "runtimes" / "langgraph"))

from lodestar_langgraph import (  # noqa: E402
    GateClient,
    GateError,
    LodestarDenied,
    govern_tools,
    governed_call,
)

try:
    from langchain_core.messages import AIMessage
    from langchain_core.tools import StructuredTool
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode
except Exception as exc:  # pragma: no cover - the probe gates on import availability
    print(f"SKIP: LangGraph/LangChain not importable: {exc}")
    sys.exit(0)

# ── tool bodies (the REAL functions the gate remotes back to run) ─────────────
runs: dict[str, int] = {"echo": 0, "read_doc": 0, "deploy": 0, "fetch": 0}


def echo(msg: str) -> dict:
    runs["echo"] += 1
    return {"echo": msg}


def read_doc(path: str) -> dict:
    runs["read_doc"] += 1
    # Surface untrusted document content for external_document evidence.
    return {"output": {"read": path}, "_lodestar_documents": [{"text": "untrusted file body", "source": path}]}


def deploy(target: str) -> dict:
    runs["deploy"] += 1  # must stay 0 for a held L4 with no approver
    return {"deployed": target}


async def fetch(url: str) -> dict:
    # An ASYNC-ONLY tool body (coroutine, no sync impl): the gate remotes it on a
    # loop-less worker thread, so the hook must run it via ainvoke, not sync invoke.
    runs["fetch"] += 1
    return {"fetched": url}


def make_tool(fn) -> StructuredTool:
    return StructuredTool.from_function(func=fn, name=fn.__name__, description=fn.__name__)


def make_async_tool(coro) -> StructuredTool:
    return StructuredTool.from_function(coroutine=coro, name=coro.__name__, description=coro.__name__)


def tool_call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}])


failures: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {label}" + (f" — {extra}" if extra else ""))
    if not cond:
        failures.append(label)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        log_root = str(Path(tmp) / "events")
        config = {
            "project_id": "langgraph-e2e",
            "actor_id": "langgraph-agent",
            "session_id": "auto",
            "log_root": log_root,
            "default_scope": {"level": "session", "identifier": "langgraph-e2e"},
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
            print("langgraph-tool-calls-are-governed (real LangGraph ToolNode + hook + gate)")
            print("─" * 72)

            tools = [make_tool(echo), make_tool(read_doc), make_tool(deploy), make_async_tool(fetch)]
            governed = govern_tools(gate, tools, hold_wait_ms=2_000)
            governed_by_name = {t.name: t for t in governed}
            check("0: only governed wrappers are exposed", set(governed_by_name) == {"echo", "read_doc", "deploy", "fetch"}, str(set(governed_by_name)))

            # Build a real compiled LangGraph with the prebuilt ToolNode. Driving
            # the node through a compiled graph (rather than a bare ToolNode.invoke)
            # is the faithful "LangGraph loop" — it provides the runtime config the
            # node needs and is how an agent actually runs it.
            tool_node = ToolNode(governed)
            graph = StateGraph(MessagesState)
            graph.add_node("tools", tool_node)
            graph.add_edge(START, "tools")
            graph.add_edge("tools", END)
            app = graph.compile()

            def last_content(out: dict) -> str:
                return str(out["messages"][-1].content)

            # 1. the compiled graph's ToolNode runs a governed L1 tool; body once.
            out = app.invoke({"messages": [tool_call("echo", {"msg": "hi"}, "c1")]})
            check("1: ToolNode (compiled graph) ran the governed echo", "hi" in last_content(out), last_content(out))
            check("1: echo body ran exactly once", runs["echo"] == 1, str(runs["echo"]))

            # 2. custom node via governed_call.
            res = governed_call(gate, "echo", {"msg": "from-node"})
            check("2: governed_call returned the tool output", res == {"echo": "from-node"}, str(res))
            check("2: echo body ran again exactly once", runs["echo"] == 2, str(runs["echo"]))

            # 3. async invocation through the compiled graph (ainvoke).
            aout = asyncio.run(app.ainvoke({"messages": [tool_call("read_doc", {"path": "/x"}, "c2")]}))
            check("3: ainvoke ran the governed read_doc", "read" in last_content(aout), last_content(aout))
            check("3: read_doc body ran once (async)", runs["read_doc"] == 1, str(runs["read_doc"]))

            # 4. batch / parallel invocation — each correlated to its own result.
            before = runs["echo"]
            batch_out = app.batch(
                [
                    {"messages": [tool_call("echo", {"msg": "B1"}, "b1")]},
                    {"messages": [tool_call("echo", {"msg": "B2"}, "b2")]},
                ]
            )
            contents = [last_content(o) for o in batch_out]
            check("4: batch call B1 correlated", any("B1" in c for c in contents), str(contents))
            check("4: batch call B2 correlated", any("B2" in c for c in contents), str(contents))
            check("4: both batch bodies ran", runs["echo"] - before == 2, str(runs["echo"] - before))

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

            # 6. a tool that was never registered is denied — fail closed.
            ghost_kind = None
            try:
                governed_call(gate, "never_registered", {})
            except LodestarDenied as denied:
                ghost_kind = denied.kind
            check("6: unregistered tool denied (fail closed)", ghost_kind == "unregistered_tool", str(ghost_kind))

            # 7. an ASYNC-ONLY tool body runs through the gate's remoted execute
            #    (the hook must ainvoke it on the loop-less worker thread, not the
            #    failing sync invoke path). Exercised via the compiled graph's
            #    ainvoke AND a direct governed_call.
            afetch = asyncio.run(app.ainvoke({"messages": [tool_call("fetch", {"url": "https://x"}, "c3")]}))
            check("7: async-only tool ran via ToolNode ainvoke", "fetched" in last_content(afetch), last_content(afetch))
            res_async = governed_call(gate, "fetch", {"url": "https://y"})
            check("7: async-only tool ran via governed_call", res_async == {"fetched": "https://y"}, str(res_async))
            check("7: async tool body ran exactly twice", runs["fetch"] == 2, str(runs["fetch"]))

            print("─" * 72)
            if failures:
                print(f"RESULT: FAIL ({len(failures)} check(s) failed)")
            else:
                print("RESULT: PASS — LangGraph native tool calls are governed end-to-end")
            print("─" * 72)
            return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
