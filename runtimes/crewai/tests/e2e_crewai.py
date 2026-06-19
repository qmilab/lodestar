#!/usr/bin/env python3
"""End-to-end driver for the CrewAI runtime adapter (ADR-0026 / ADR-0024 §8).

Drives REAL CrewAI tools through the `lodestar-crewai` hook and the TypeScript
governance-gate sidecar, exercising the real-runtime cases the in-TS
`runtime-gate-enforces-two-phase` probe cannot:

  1. govern_tools returns governed wrappers only; a governed L1 call executes
     through CrewAI's own execution path (`CrewStructuredTool.invoke`) — the body
     runs exactly once, remoted back from the gate;
  2. a custom step invokes a governed tool via ``governed_call``;
  3. an async-only CrewAI tool (overrides ``_arun``) runs through the gate's
     remoted execute (the hook must ``arun`` it on the loop-less worker thread);
  4. concurrent in-flight calls are correlated to the right result;
  5. an L4 tool is HELD (two-phase across the boundary): with no approver it
     times out and the body NEVER runs;
  6. a tool that was never registered is DENIED — fail closed;
  7. the governed wrappers are valid CrewAI ``BaseTool``s the framework accepts —
     they attach to a real ``Agent`` / ``Task`` / ``Crew`` (no LLM/key needed);
  8. a non-finite float in an argument or a result fails the call rather than
     hanging it (Python's json would otherwise emit invalid ``NaN``).

Spawns the gate via ``bun run <repo>/packages/cli/src/index.ts runtime gate``.
Invoked by the runtime-gated ``crewai-tool-calls-are-governed`` probe, which skips
loudly when Python / CrewAI is absent. Exit 0 = pass, 1 = fail.
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Type

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI_INDEX = REPO_ROOT / "packages" / "cli" / "src" / "index.ts"

# Prefer the INSTALLED hook so CI (which pip-installs runtimes/crewai) actually
# exercises the packaged artifact and its pyproject exports. Only fall back to the
# source tree for a local run where the hook isn't installed.
try:
    from lodestar_crewai import (  # noqa: E402
        GateClient,
        GateError,
        LodestarDenied,
        govern_tools,
        governed_call,
    )
except ImportError:
    sys.path.insert(0, str(REPO_ROOT / "runtimes" / "crewai"))
    from lodestar_crewai import (  # noqa: E402
        GateClient,
        GateError,
        LodestarDenied,
        govern_tools,
        governed_call,
    )

try:
    from crewai import Agent, Crew, Task
    from crewai.tools import BaseTool
    from pydantic import BaseModel, Field
except Exception as exc:  # pragma: no cover - the probe gates on import availability
    print(f"SKIP: CrewAI not importable: {exc}")
    sys.exit(0)

# ── tool bodies (the REAL functions the gate remotes back to run) ─────────────
runs: dict[str, int] = {"echo": 0, "read_doc": 0, "deploy": 0, "fetch": 0}


class EchoInput(BaseModel):
    msg: str = Field(..., description="the message to echo")


class Echo(BaseTool):
    name: str = "echo"
    description: str = "echo a message back"
    args_schema: Type[BaseModel] = EchoInput

    def _run(self, msg: str) -> dict:
        runs["echo"] += 1
        return {"echo": msg}


class ReadDocInput(BaseModel):
    path: str = Field(..., description="path to read")


class ReadDoc(BaseTool):
    name: str = "read_doc"
    description: str = "read an (untrusted) document"
    args_schema: Type[BaseModel] = ReadDocInput

    def _run(self, path: str) -> dict:
        runs["read_doc"] += 1
        # Surface untrusted document content for external_document evidence.
        return {"output": {"read": path}, "_lodestar_documents": [{"text": "untrusted file body", "source": path}]}


class DeployInput(BaseModel):
    target: str = Field(..., description="deploy target")


class Deploy(BaseTool):
    name: str = "deploy"
    description: str = "deploy to a target (irreversible, L4)"
    args_schema: Type[BaseModel] = DeployInput

    def _run(self, target: str) -> dict:
        runs["deploy"] += 1  # must stay 0 for a held L4 with no approver
        return {"deployed": target}


class FetchInput(BaseModel):
    url: str = Field(..., description="url to fetch")


class Fetch(BaseTool):
    name: str = "fetch"
    description: str = "fetch a url (async-only tool)"
    args_schema: Type[BaseModel] = FetchInput

    def _run(self, *args, **kwargs):
        # Async-only: the abstract sync path is not implemented, so the gate's
        # remoted execute must run the coroutine via arun on its worker thread.
        raise NotImplementedError("fetch is async-only")

    async def _arun(self, url: str) -> dict:
        runs["fetch"] += 1
        return {"fetched": url}


class NanInput(BaseModel):
    x: int = Field(..., description="ignored")


class NanOut(BaseTool):
    name: str = "nan_out"
    description: str = "returns a non-finite float (invalid JSON for the gate)"
    args_schema: Type[BaseModel] = NanInput

    def _run(self, x: int) -> dict:
        # The hook must reject this (→ tool_error → failed action), never emit `NaN`.
        return {"output": {"value": float("nan")}}


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
            "project_id": "crewai-e2e",
            "actor_id": "crewai-agent",
            "session_id": "auto",
            "log_root": log_root,
            "default_scope": {"level": "session", "identifier": "crewai-e2e"},
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
            print("crewai-tool-calls-are-governed (real CrewAI tools + hook + gate)")
            print("─" * 72)

            tools = [Echo(), ReadDoc(), Deploy(), Fetch(), NanOut()]
            governed = govern_tools(gate, tools, hold_wait_ms=2_000)
            governed_by_name = {t.name: t for t in governed}
            check("0: only governed wrappers are exposed", set(governed_by_name) == {"echo", "read_doc", "deploy", "fetch", "nan_out"}, str(set(governed_by_name)))
            # The wrappers are real CrewAI BaseTools (not the originals).
            check("0: wrappers are BaseTool instances, distinct from the originals", all(isinstance(t, BaseTool) for t in governed) and governed_by_name["echo"] is not tools[0], "")

            # 1. a governed L1 tool runs through CrewAI's OWN execution path
            #    (CrewStructuredTool.invoke → the wrapper's _run → the gate); the
            #    body runs exactly once, remoted back.
            st = governed_by_name["echo"].to_structured_tool()
            out = st.invoke({"msg": "hi"})
            check("1: CrewStructuredTool.invoke ran the governed echo", isinstance(out, dict) and out.get("echo") == "hi", str(out))
            check("1: echo body ran exactly once", runs["echo"] == 1, str(runs["echo"]))
            # Same through the JSON-string input path the LLM produces.
            out2 = st.invoke('{"msg": "json"}')
            check("1: invoke accepts a JSON-string arg too", isinstance(out2, dict) and out2.get("echo") == "json", str(out2))
            check("1: echo body ran exactly twice", runs["echo"] == 2, str(runs["echo"]))

            # 2. custom step via governed_call.
            res = governed_call(gate, "echo", {"msg": "from-step"})
            check("2: governed_call returned the tool output", res == {"echo": "from-step"}, str(res))
            check("2: echo body ran again exactly once", runs["echo"] == 3, str(runs["echo"]))

            # 3. an async-only tool runs via the gate's remoted execute (hook arun
            #    on the loop-less worker thread). Exercised via the framework path
            #    AND a direct governed_call.
            afetch = governed_by_name["fetch"].to_structured_tool().invoke({"url": "https://x"})
            check("3: async-only tool ran via CrewStructuredTool.invoke", afetch == {"fetched": "https://x"}, str(afetch))
            res_async = governed_call(gate, "fetch", {"url": "https://y"})
            check("3: async-only tool ran via governed_call", res_async == {"fetched": "https://y"}, str(res_async))
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
            # The held L4 also fails fast through the framework path (re-raises,
            # which CrewAI's ToolUsage would surface to the agent).
            framework_held = None
            try:
                governed_by_name["deploy"].to_structured_tool().invoke({"target": "prod2"})
            except LodestarDenied as denied:
                framework_held = denied.kind
            check("5: held L4 raises through CrewStructuredTool.invoke too", framework_held == "approval_timeout", str(framework_held))
            check("5: deploy body STILL never ran", runs["deploy"] - deploy_before == 0, str(runs["deploy"] - deploy_before))

            # 6. a tool that was never registered is denied — fail closed.
            ghost_kind = None
            try:
                governed_call(gate, "never_registered", {})
            except LodestarDenied as denied:
                ghost_kind = denied.kind
            check("6: unregistered tool denied (fail closed)", ghost_kind == "unregistered_tool", str(ghost_kind))

            # 7. the governed wrappers are valid CrewAI tools the framework accepts:
            #    they attach to a real Agent / Task / Crew (construction validates
            #    them; no LLM call / API key needed).
            crew_ok = None
            try:
                agent = Agent(role="ops", goal="ship safely", backstory="careful", tools=governed)
                task = Task(description="do the thing", expected_output="done", agent=agent)
                Crew(agents=[agent], tasks=[task])
                crew_ok = {t.name for t in agent.tools} == {"echo", "read_doc", "deploy", "fetch", "nan_out"}
            except Exception as exc:  # noqa: BLE001
                crew_ok = False
                print(f"      (crew construction raised: {exc})")
            check("7: governed wrappers attach to a real Agent/Task/Crew", crew_ok is True, str(crew_ok))

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
                print("RESULT: PASS — CrewAI native tool calls are governed end-to-end")
            print("─" * 72)
            return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
