#!/usr/bin/env bun
/**
 * Probe: approval_via_side_channel
 *
 * The separate-process resolution path (Policy Kernel slice 3c). The
 * `lodestar approve` CLI runs in its own OS process, so it cannot safely append
 * to the proxy's event log — `EventLogWriter` keeps its `seq` / `logical_clock`
 * counters in process-local module state, and a second writer would collide
 * with the proxy's own post-resolution appends, breaking the monotonic-`seq`
 * invariant the `event_log_single_writer` probe pins.
 *
 * So the CLI writes a *side-channel* file
 * (`<log_root>/.approvals/<project>/<request-id>.json`) and the proxy — the sole
 * writer of its log — promotes it: emits the canonical `approval.granted@1` /
 * `approval.denied@1` into its own log, then runs (or rejects) the held action.
 * This probe drives that path through the real
 * `writeApprovalResolution` helper (exactly what the CLI calls) and pins:
 *
 * 1. GRANT — a side-channel `granted` resolution written before the deadline is
 *    promoted by the proxy: the action un-parks, the downstream tool runs once,
 *    the result round-trips, and the log carries action.pending_approval →
 *    approval.requested → approval.granted → action.approved → action.completed.
 *    The promoted `approval.granted@1` envelope is authored by the PROXY actor
 *    (the CLI never wrote the log), with the approver carried in the payload.
 *    The consumed side-channel file is gone afterward.
 *
 * 2. SOLE WRITER (the F2 guarantee) — across the whole project log, `seq` is
 *    strictly monotonic with no duplicates. The CLI wrote only the side-channel;
 *    nothing but the proxy ever appended to the log, so the counter is intact.
 *
 * 3. DENY — a side-channel `denied` resolution is promoted to approval.denied@1
 *    and action.rejected; the downstream tool NEVER runs.
 *
 * 4. LATE — a resolution whose approver `at` is after the deadline is NOT
 *    promoted (offset-safe numeric gate); the hold times out to approval_timeout,
 *    the tool never runs, and no approval.granted@1 is emitted.
 *
 * Why this matters: this is the seam that keeps the solo workflow ungated — a
 * developer hits a held L4 over `lodestar guard mcp-proxy` and clears it from
 * their own terminal with `lodestar approve grant` — without ever weakening the
 * single-writer event log.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import { type EventEnvelope, registry } from "@qmilab/lodestar-core"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import {
  DownstreamConnection,
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
  isPolicyDeniedResult,
  readApprovalResolution,
  writeApprovalResolution,
} from "@qmilab/lodestar-guard-mcp"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-project-approval-channel"
const ACTOR_ID = "agent:probe-approval-channel"
const APPROVER_ID = "human:reviewer"
const DOWNSTREAM_NAME = "test"
const DOWNSTREAM_TOOL_NAME = "push"
const LODESTAR_TOOL_NAME = `mcp.${DOWNSTREAM_NAME}.${DOWNSTREAM_TOOL_NAME}`

class FakeDownstreamConnection extends DownstreamConnection {
  constructor(
    cfg: ProxyConfig["downstream_servers"][number],
    private readonly fakeTools: MCPTool[],
    private readonly fakeCallTool: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<CallToolResult>,
  ) {
    super(cfg, { name: "probe-fake-client", version: "0.0.0" })
  }
  override async start(): Promise<void> {}
  override getTools(): readonly MCPTool[] {
    return this.fakeTools
  }
  override async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.fakeCallTool(name, args)
  }
  override async stop(): Promise<void> {}
}

class NoOpUpstreamServer extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

const pushTool: MCPTool = {
  name: DOWNSTREAM_TOOL_NAME,
  description: "Push to a remote",
  inputSchema: { type: "object", properties: {}, required: [] },
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build a proxy whose single tool is L4 (always held by the floor). */
function makeProxy(logDir: string, sessionId: string, approvalTimeoutMs: number) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const fakeCallTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    calls.push({ name, args })
    return { content: [{ type: "text", text: "pushed" }], isError: false }
  }
  const config: ProxyConfig = {
    project_id: PROJECT_ID,
    actor_id: ACTOR_ID,
    session_id: sessionId,
    log_root: logDir,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    approval_timeout_ms: approvalTimeoutMs,
    downstream_servers: [{ name: DOWNSTREAM_NAME, command: "not-spawned", args: [] }],
    tool_defaults: {
      [LODESTAR_TOOL_NAME]: {
        reversibility: "irreversible",
        permissions: [],
        sandbox: "controlled-shell",
        // L4: external/shared — the trust-ladder floor always holds it.
        required_trust_level: 4,
        blast_radius: "external",
      },
    },
  }
  const proxy = new MCPProxy(config, {
    downstreamFactory: (cfg) =>
      cfg.downstream_servers.map(
        (entry) => new FakeDownstreamConnection(entry, [pushTool], fakeCallTool),
      ),
    upstreamFactory: (tools, handler) =>
      new NoOpUpstreamServer(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  return { proxy, calls }
}

function resetState(): void {
  _resetToolsForTests()
  registry._resetForTests()
  _resetEventLogStateForTests()
}

async function sessionEvents(logDir: string, sessionId: string): Promise<EventEnvelope[]> {
  return new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)
}

/** Poll the log until the parked action's `approval.requested@1` lands. */
async function waitForRequest(
  logDir: string,
  sessionId: string,
  withinMs: number,
): Promise<{ request_id: string; action_id: string } | undefined> {
  const reader = new EventLogReader(logDir)
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    const events = await reader.readSession(PROJECT_ID, sessionId)
    const reqEvent = events.find((e) => e.type === "approval.requested")
    if (reqEvent) {
      const p = reqEvent.payload as { request_id: string; action_id: string }
      return { request_id: p.request_id, action_id: p.action_id }
    }
    await delay(20)
  }
  return undefined
}

// ── Case 1+2: GRANT via side-channel + sole-writer seq integrity ─────────────
async function caseGrant(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-approval-channel-grant-"))
  const sessionId = "probe-session-channel-grant"
  const { proxy, calls } = makeProxy(logDir, sessionId, 3000)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 2000)
    if (request === undefined) return "[grant] approval.requested never appeared in the log."

    // The resolver (separate-process `lodestar approve` does exactly this) drops
    // a side-channel file — it never touches the event log.
    await writeApprovalResolution(logDir, PROJECT_ID, {
      request_id: request.request_id,
      action_id: request.action_id,
      kind: "granted",
      approver_id: APPROVER_ID,
      at: new Date().toISOString(),
    })

    const result = await callPromise

    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[grant] a granted hold returned an error result (kind '${String(kind)}'); expected the tool to run.`
    }
    if (calls.length !== 1) {
      return `[grant] downstream tool ran ${calls.length}x; expected exactly 1 after a side-channel grant.`
    }
    const text = result.content[0]?.type === "text" ? result.content[0].text : undefined
    if (text !== "pushed") {
      return `[grant] result text round-trip mismatch: got '${text ?? "(undefined)"}', expected 'pushed'.`
    }

    await proxy.stop()
    const events = await sessionEvents(logDir, sessionId)
    const types = events.map((e) => e.type)
    for (const required of [
      "action.pending_approval",
      "approval.requested",
      "approval.granted",
      "action.approved",
      "action.completed",
    ]) {
      if (!types.includes(required)) {
        return `[grant] event log missing '${required}'. Got: ${types.join(", ")}`
      }
    }

    // The proxy — not the CLI — wrote the canonical approval.granted@1. The
    // envelope is authored by the proxy actor; the approver rides in the payload.
    const grant = events.find((e) => e.type === "approval.granted")
    if (grant === undefined) return "[grant] approval.granted@1 missing after promotion."
    if (grant.actor_id !== ACTOR_ID) {
      return `[grant] approval.granted@1 was authored by '${grant.actor_id}', not the proxy actor '${ACTOR_ID}' — the proxy must be the sole writer.`
    }
    const approver = (grant.payload as { approver_id?: unknown }).approver_id
    if (approver !== APPROVER_ID) {
      return `[grant] approval.granted@1 payload approver_id '${String(approver)}' != '${APPROVER_ID}'.`
    }

    // Sole-writer seq integrity (the F2 guarantee): across the whole project
    // log, seq is strictly monotonic with no duplicates. A second cross-process
    // writer to the log would have reused a seq.
    const all = await new EventLogReader(logDir).readAll(PROJECT_ID)
    for (let i = 1; i < all.length; i++) {
      const cur = all[i]
      const prev = all[i - 1]
      // Fail closed: within bounds these are always defined, but if a slot were
      // unexpectedly missing, surface it rather than skip the check (this also
      // satisfies noUncheckedIndexedAccess).
      if (!cur || !prev) {
        return `[grant] unexpected gap in the log at index ${i}: readAll returned a sparse array (F2 regression).`
      }
      if (cur.seq <= prev.seq) {
        return `[grant] non-monotonic seq at index ${i}: ${prev.seq} then ${cur.seq} — a second writer touched the log (F2 regression).`
      }
    }

    // The consumed side-channel file is gone (the proxy deletes it post-promotion).
    const leftover = await readApprovalResolution(logDir, PROJECT_ID, request.request_id)
    if (leftover !== undefined) {
      return "[grant] the side-channel resolution file was not consumed after promotion."
    }
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 3: DENY via side-channel → rejected, tool never runs ────────────────
async function caseDeny(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-approval-channel-deny-"))
  const sessionId = "probe-session-channel-deny"
  const { proxy, calls } = makeProxy(logDir, sessionId, 3000)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 2000)
    if (request === undefined) return "[deny] approval.requested never appeared in the log."

    await writeApprovalResolution(logDir, PROJECT_ID, {
      request_id: request.request_id,
      action_id: request.action_id,
      kind: "denied",
      approver_id: APPROVER_ID,
      reason: "not this time",
      at: new Date().toISOString(),
    })

    const result = await callPromise

    if (result.isError !== true || !isPolicyDeniedResult(result)) {
      return "[deny] expected a synthetic error result; got a non-error / non-Lodestar result."
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_denied") {
      return `[deny] expected _lodestar.kind 'approval_denied'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[deny] downstream tool ran ${calls.length}x; a denied hold must never execute the tool.`
    }

    await proxy.stop()
    const types = (await sessionEvents(logDir, sessionId)).map((e) => e.type)
    for (const required of ["approval.requested", "approval.denied", "action.rejected"]) {
      if (!types.includes(required)) {
        return `[deny] event log missing '${required}'. Got: ${types.join(", ")}`
      }
    }
    if (types.includes("action.completed") || types.includes("action.approved")) {
      return `[deny] a denied hold reached approved/completed. Got: ${types.join(", ")}`
    }
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 4: LATE resolution (at after deadline) → not promoted, times out ────
async function caseLate(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-approval-channel-late-"))
  const sessionId = "probe-session-channel-late"
  const { proxy, calls } = makeProxy(logDir, sessionId, 700)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 500)
    if (request === undefined) return "[late] approval.requested never appeared in the log."

    // Decision time a minute in the future — unambiguously after the hold
    // deadline. The proxy's offset-safe numeric gate must refuse to promote it.
    await writeApprovalResolution(logDir, PROJECT_ID, {
      request_id: request.request_id,
      action_id: request.action_id,
      kind: "granted",
      approver_id: APPROVER_ID,
      at: new Date(Date.now() + 60_000).toISOString(),
    })

    const result = await callPromise

    if (result.isError !== true) return "[late] a late grant was accepted; expected a timeout."
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[late] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[late] downstream tool ran ${calls.length}x; a late grant must not execute the tool.`
    }

    await proxy.stop()
    const types = (await sessionEvents(logDir, sessionId)).map((e) => e.type)
    if (types.includes("approval.granted")) {
      return "[late] a post-deadline side-channel grant was promoted to approval.granted@1."
    }
    for (const required of ["approval.expired", "action.rejected"]) {
      if (!types.includes(required)) {
        return `[late] event log missing '${required}'. Got: ${types.join(", ")}`
      }
    }
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

async function run(): Promise<ProbeResult> {
  const grantFail = await caseGrant()
  if (grantFail) return { passed: false, details: grantFail }
  const denyFail = await caseDeny()
  if (denyFail) return { passed: false, details: denyFail }
  const lateFail = await caseLate()
  if (lateFail) return { passed: false, details: lateFail }
  return {
    passed: true,
    details:
      "A separate-process side-channel grant was promoted by the proxy (canonical approval.granted@1 authored by the proxy actor, tool ran once, seq stayed strictly monotonic, file consumed); a side-channel deny rejected the action without running the tool; a post-deadline resolution was refused and the hold timed out.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: approval_via_side_channel")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
