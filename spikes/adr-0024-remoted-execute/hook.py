#!/usr/bin/env python3
"""ADR-0024 spike — the LangGraph-side hook (Python).

Throwaway proof-of-concept (NOT production; not part of PR #124). It spawns the
TS governance-gate sidecar (`bun run gate.ts`, the REAL ActionKernel) and drives
it over bidirectional stdio NDJSON-RPC, asserting every load-bearing claim in
ADR-0024's hardened design:

  A. Re-entrant remoted execute works — an allowed call reaches the execute
     phase, which calls BACK into Python to run the real tool body, and the
     result flows back into the chain (observationSink).
  B. Two-phase holds across the boundary — an L4 call parks at pending_approval
     and the Python tool body NEVER runs (no work before approval).
  C. Resume executes — resolving the held action (granted) runs the body once.
  D. Exactly-once — a DUPLICATE resolve does not re-run the body (idempotent).
  E. Concurrency correlation — two in-flight calls are each correlated to the
     right action and ingested once (the RPC-leg id invariant from finding 3).

This stands in for LangGraph itself: LangGraph is only the *driver* that calls
tools, so the cross-language risk lives entirely in this hook<->gate RPC, which
is exactly what we exercise here. Run: `python3 hook.py` (needs `bun` on PATH).
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GATE = "spikes/adr-0024-remoted-execute/gate.ts"

# --- local "tool bodies", as a LangGraph tool would run them in-process -------
_seq = 0
callbacks: list[tuple[str, str]] = []  # (action_id, msg) every time a body runs


def run_body(action_id: str, msg: str) -> dict:
    global _seq
    _seq += 1
    callbacks.append((action_id, msg))
    return {"ran": True, "echo": msg, "seq": _seq}


# --- RPC plumbing -------------------------------------------------------------
class Gate:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            ["bun", "run", GATE],
            cwd=str(REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # inherit -> gate's [gate] logs show on our stderr
            text=True,
            bufsize=1,
        )
        self._id = 0

    def next_id(self) -> int:
        self._id += 1
        return self._id

    def send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> dict | None:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            return None
        return json.loads(line)

    def collect(self, target_ids: list[int]) -> dict[int, dict]:
        """Pump messages, handling re-entrant run_tool callbacks inline, until
        every govern_result in target_ids has arrived."""
        results: dict[int, dict] = {}
        pending = set(target_ids)
        while pending - set(results):
            msg = self._read()
            if msg is None:
                raise RuntimeError("gate closed the pipe unexpectedly")
            t = msg.get("type")
            if t == "run_tool":
                body = run_body(msg.get("action_id", "?"), msg["args"]["msg"])
                self.send({"type": "tool_result", "id": msg["id"], "output": body})
            elif t == "govern_result":
                results[msg["id"]] = msg
            elif t == "ready":
                pass
        return results

    def shutdown(self) -> None:
        try:
            self.send({"type": "shutdown"})
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# --- tiny assertion harness ---------------------------------------------------
failures: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    status = "PASS ✓" if cond else "FAIL ✗"
    print(f"  [{status}] {label}{(' — ' + extra) if extra else ''}")
    if not cond:
        failures.append(label)


def main() -> int:
    gate = Gate()

    # Watchdog: never hang the spike.
    watchdog = threading.Timer(30.0, lambda: gate.proc.kill())
    watchdog.daemon = True
    watchdog.start()

    try:
        print("─" * 72)
        print("ADR-0024 spike: remoted-execute / hook-as-downstream (real ActionKernel)")
        print("─" * 72)

        # A — re-entrant remoted execute (the core mechanic)
        print("A. allowed call -> reaches execute -> remotes body back to Python")
        a_start = len(callbacks)
        a_id = gate.next_id()
        gate.send({"type": "govern", "id": a_id, "tool": "remote.call",
                   "args": {"msg": "hello-A"}, "required_level": 1})
        a = gate.collect([a_id])[a_id]
        a_cbs = callbacks[a_start:]
        check("completed", a["phase"] == "completed", a["phase"])
        check("body ran exactly once", len(a_cbs) == 1, f"{len(a_cbs)} run(s)")
        check("result flowed back into the chain",
              isinstance(a.get("output"), dict) and a["output"].get("echo") == "hello-A")

        # B — two-phase hold across the boundary (no work before approval)
        print("B. L4 call -> held at pending_approval -> body must NOT run")
        b_start = len(callbacks)
        b_id = gate.next_id()
        gate.send({"type": "govern", "id": b_id, "tool": "remote.call",
                   "args": {"msg": "hello-B"}, "required_level": 4})
        b = gate.collect([b_id])[b_id]
        check("held at pending_approval", b["phase"] == "pending_approval", b["phase"])
        check("body NEVER ran (no work before approval)", len(callbacks) - b_start == 0,
              f"{len(callbacks) - b_start} run(s)")
        held_action = b["action_id"]

        # C — resume executes
        print("C. resolve(granted) -> now executes the body once")
        c_start = len(callbacks)
        c_id = gate.next_id()
        gate.send({"type": "resolve", "id": c_id, "action_id": held_action,
                   "kind": "granted", "approver_id": "spike-approver"})
        c = gate.collect([c_id])[c_id]
        check("completed after approval", c["phase"] == "completed", c["phase"])
        check("body ran exactly once on resume", len(callbacks) - c_start == 1,
              f"{len(callbacks) - c_start} run(s)")

        # D — exactly-once / idempotent duplicate resume
        print("D. duplicate resolve -> idempotent, body must NOT re-run")
        d_start = len(callbacks)
        d_id = gate.next_id()
        gate.send({"type": "resolve", "id": d_id, "action_id": held_action,
                   "kind": "granted", "approver_id": "spike-approver"})
        d = gate.collect([d_id])[d_id]
        check("still completed (cached)", d["phase"] == "completed", d["phase"])
        check("body did NOT re-execute (exactly-once)", len(callbacks) - d_start == 0,
              f"{len(callbacks) - d_start} run(s)")

        # E — concurrency correlation (two in-flight calls)
        print("E. two concurrent calls -> each correlated to the right action, once")
        e_start = len(callbacks)
        x_id, y_id = gate.next_id(), gate.next_id()
        gate.send({"type": "govern", "id": x_id, "tool": "remote.call",
                   "args": {"msg": "conc-X"}, "required_level": 1})
        gate.send({"type": "govern", "id": y_id, "tool": "remote.call",
                   "args": {"msg": "conc-Y"}, "required_level": 1})
        res = gate.collect([x_id, y_id])
        e_cbs = callbacks[e_start:]
        check("X correlated to its own result", res[x_id]["output"]["echo"] == "conc-X")
        check("Y correlated to its own result", res[y_id]["output"]["echo"] == "conc-Y")
        check("both bodies ran exactly once", len(e_cbs) == 2, f"{len(e_cbs)} run(s)")
        check("two distinct actions", len({a for a, _ in e_cbs}) == 2)

        print("─" * 72)
        if failures:
            print(f"RESULT: FAIL ✗  ({len(failures)} check(s) failed)")
        else:
            print("RESULT: PASS ✓  — every ADR-0024 hardened claim held over the real kernel")
        print("─" * 72)
        return 1 if failures else 0
    finally:
        watchdog.cancel()
        gate.shutdown()


if __name__ == "__main__":
    sys.exit(main())
