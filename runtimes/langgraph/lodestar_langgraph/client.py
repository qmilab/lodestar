"""The runtime-hook side of the Lodestar runtime-adapter RPC (ADR-0024).

`GateClient` spawns the TypeScript governance-gate sidecar (`lodestar runtime
gate`) as a child process and speaks newline-delimited JSON-RPC to it over
stdin/stdout — the same framing MCP uses, zero extra dependencies. The channel is
**bidirectional**: the gate calls *back* with ``run_tool`` to run a real tool
body (the re-entrant remoted execute), so the tool body runs only inside the
gate's execute phase, never before approval.

A single reader thread dispatches every inbound line by id, so concurrent
``govern`` calls (LangGraph issues parallel tool calls) are correlated
correctly — no positional or ordering assumption. This module is pure stdlib; the
LangGraph/LangChain integration lives in ``adapter``.
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
from typing import Any, Callable, Optional

# A tool body the gate remotes back: takes the validated args, returns
# ``{"output": <any>, "documents": [{"text": str, "source"?: str}, ...]}``.
ToolBody = Callable[[dict], dict]


class GateError(RuntimeError):
    """A protocol-level error returned by the gate (e.g. a bad message)."""


class GateClient:
    """Spawn and drive the Lodestar governance-gate sidecar.

    Parameters
    ----------
    config_path:
        Path to the ``RuntimeGateConfig`` JSON the gate loads.
    launcher:
        The argv prefix that runs the CLI. Defaults to ``["lodestar"]`` (the
        published binary). Tests / monorepo callers pass e.g.
        ``["bun", "run", "<repo>/packages/cli/src/index.ts"]``.
    ready_timeout_s:
        How long to wait for the gate's ``ready`` handshake.
    request_timeout_s:
        Optional hard cap (seconds) on waiting for any single request's reply.
        Defaults to ``None`` (wait until the gate replies or dies) — the gate
        bounds tool execution itself, so a fixed cap is not needed for liveness and
        a too-short one would drop a valid reply for a slow tool. If set, keep it
        ≥ the gate's ``tool_exec_timeout_ms`` (plus any ``resume`` wait).
    """

    def __init__(
        self,
        config_path: str,
        *,
        launcher: Optional[list[str]] = None,
        ready_timeout_s: float = 30.0,
        request_timeout_s: Optional[float] = None,
    ) -> None:
        argv = list(launcher or ["lodestar"]) + ["runtime", "gate", "--config", config_path]
        self._proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # inherit: the gate's [runtime-gate] diagnostics show through
            text=True,
            bufsize=1,
        )
        # Per-request reply cap. None (the default) waits indefinitely: the gate
        # bounds tool execution itself (RuntimeGateConfig.tool_exec_timeout_ms) and
        # always replies, and a gate that *dies* releases every waiter when its
        # stdout closes (see _read_loop). A fixed client-side cap is therefore not
        # needed for liveness — and a too-short one would wrongly drop a valid
        # govern_result for a legitimately slow tool (or one whose exec timeout the
        # operator raised above the cap). Set a number only as an extra hard cap,
        # and keep it ≥ the gate's tool_exec_timeout_ms (+ any resume wait).
        self._request_timeout_s = request_timeout_s
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._next = 0
        self._futures: dict[int, "queue.Queue[dict]"] = {}
        self._bodies: dict[str, ToolBody] = {}
        self._ready = threading.Event()
        # Set (with `_ready`) when the gate's stdout closes before the handshake —
        # e.g. an invalid config/policy makes the CLI exit. Lets construction fail
        # fast with a useful message instead of blocking the full ready timeout.
        self._startup_error: Optional[str] = None
        self._closed = False
        self.session_id: Optional[str] = None
        self.project_id: Optional[str] = None
        self._reader = threading.Thread(target=self._read_loop, name="lodestar-gate-reader", daemon=True)
        self._reader.start()
        if not self._ready.wait(timeout=ready_timeout_s):
            self.close()
            raise GateError("gate did not signal ready in time")
        if self._startup_error is not None:
            self.close()
            raise GateError(self._startup_error)

    # ── public API ──────────────────────────────────────────────────────────

    def register_tool(self, name: str, body: ToolBody) -> dict:
        """Register a governed tool. The gate compiles the operator's contract
        for ``name``; this only declares the tool exists and binds its body."""
        with self._state_lock:
            self._bodies[name] = body
        return self._request({"type": "register_tool", "name": name})

    def govern(self, tool: str, args: dict) -> dict:
        """Propose a tool call. Returns the ``govern_result``: ``completed``
        (with ``output``), ``pending_approval`` (with ``action_id`` /
        ``request_id`` / ``deadline``), ``rejected``, or ``failed``."""
        return self._request({"type": "govern", "tool": tool, "args": args})

    def resume(self, action_id: str, request_id: str, *, wait_ms: Optional[int] = None) -> dict:
        """Re-present a held action. With ``wait_ms`` the gate block-polls up to
        that long (bounded by the deadline) for a signed resolution; without it,
        a single check. Idempotent — a duplicate resume returns the recorded
        outcome and never re-executes."""
        msg: dict[str, Any] = {"type": "resume", "action_id": action_id, "request_id": request_id}
        if wait_ms is not None:
            msg["wait_ms"] = wait_ms
        return self._request(msg)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send({"type": "shutdown"})
            self._proc.wait(timeout=5)
        except Exception:
            self._proc.kill()

    def __enter__(self) -> "GateClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── internals ────────────────────────────────────────────────────────────

    def _send(self, obj: dict) -> None:
        assert self._proc.stdin is not None
        # `allow_nan=False` rejects NaN/Infinity: Python's default emits the
        # literals `NaN`/`Infinity`, which are NOT valid JSON, so the TS gate's
        # `JSON.parse` drops the line — and with unbounded request waits the caller
        # would hang. Fail loudly here instead (the callers turn this into a
        # GateError for a request, or a tool_error for a tool body).
        try:
            line = json.dumps(obj, allow_nan=False)
        except ValueError as exc:
            raise GateError(f"cannot serialise RPC message (non-finite number?): {exc}") from exc
        with self._write_lock:
            self._proc.stdin.write(line + "\n")
            self._proc.stdin.flush()

    def _request(self, obj: dict) -> dict:
        with self._state_lock:
            self._next += 1
            rid = self._next
            box: "queue.Queue[dict]" = queue.Queue(maxsize=1)
            self._futures[rid] = box
        try:
            self._send({**obj, "id": rid})
        except Exception:
            # Serialisation/transport failed — don't leave an orphaned waiter.
            with self._state_lock:
                self._futures.pop(rid, None)
            raise
        try:
            # timeout=None waits until the gate replies or (on gate death) the
            # reader injects a closed-connection error into the box.
            reply = box.get(timeout=self._request_timeout_s)
        except queue.Empty as exc:
            with self._state_lock:
                self._futures.pop(rid, None)
            raise GateError(f"gate did not reply to {obj.get('type')} in time") from exc
        if reply.get("type") == "error":
            raise GateError(str(reply.get("message")))
        return reply

    def _read_loop(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "ready":
                self.session_id = msg.get("session_id")
                self.project_id = msg.get("project_id")
                self._ready.set()
            elif kind == "run_tool":
                # Run the real tool body off the reader thread so a slow body
                # does not stall correlation of other in-flight replies.
                threading.Thread(target=self._handle_run_tool, args=(msg,), daemon=True).start()
            else:
                rid = msg.get("id")
                if isinstance(rid, int):
                    with self._state_lock:
                        box = self._futures.pop(rid, None)
                    if box is not None:
                        box.put(msg)
        # stdout closed. If it closed BEFORE the ready handshake, the gate exited
        # at startup (bad config/policy, etc.) — record a fail-fast startup error
        # and unblock construction's ready wait so it raises immediately with a
        # useful message instead of blocking the full ready timeout.
        if not self._ready.is_set():
            code = self._proc.poll()
            if code is None:
                try:
                    code = self._proc.wait(timeout=2)
                except Exception:
                    code = None
            self._startup_error = (
                f"gate exited before signalling ready (exit code {code}); "
                "check the config/policy — see the gate's stderr above"
            )
            self._ready.set()
        # Fail any waiters so callers don't hang.
        with self._state_lock:
            waiters = list(self._futures.values())
            self._futures.clear()
        for box in waiters:
            try:
                box.put({"type": "error", "message": "gate closed the connection"})
            except Exception:
                pass

    def _handle_run_tool(self, msg: dict) -> None:
        name = msg.get("tool")
        corr = msg.get("id")
        with self._state_lock:
            body = self._bodies.get(name)
        try:
            if body is None:
                raise GateError(f"no body registered for tool '{name}'")
            out = body(msg.get("args") or {})
            self._send(
                {
                    "type": "tool_result",
                    "id": corr,
                    "output": out.get("output"),
                    "documents": out.get("documents", []),
                }
            )
        except Exception as exc:  # noqa: BLE001 — surface any body failure to the gate
            self._send({"type": "tool_error", "id": corr, "message": str(exc)})
