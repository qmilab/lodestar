#!/usr/bin/env bun
/**
 * Probe: approval_timeout_denies
 *
 * The MCP proxy's out-of-band hold path. A `tools/call` is request/response, so
 * the proxy cannot hold one open forever — a held action (an L4 tool the
 * trust-ladder floor parks at `pending_approval`) carries a deadline. The proxy
 * polls the event log for an out-of-band `approval.granted@1` /
 * `approval.denied@1` up to `approval_timeout_ms`, then:
 *   - on a grant: un-parks and runs the downstream tool;
 *   - on the deadline passing: emits `approval.expired@1`, rejects the action,
 *     and returns a synthetic `approval_timeout` result the agent re-plans
 *     around. No durable resume — a timed-out hold is a soft denial.
 *
 * Assertions:
 * 1. TIMEOUT — with no resolution written, a held L4 call returns a synthetic
 *    `approval_timeout` (isError), the downstream tool NEVER runs, and the log
 *    carries action.proposed → action.pending_approval → approval.requested →
 *    approval.expired → action.rejected, with NO action.completed/approved.
 * 2. GRANT — an `approval.granted@1` written out-of-band before the deadline is
 *    picked up: the action un-parks, the downstream tool runs exactly once, the
 *    result round-trips (isError=false), and the log carries
 *    action.pending_approval → approval.requested → approval.granted →
 *    action.approved → action.completed.
 *
 * Why this matters: without the deadline the proxy would block a `tools/call`
 * until the client timed out the whole session; without the out-of-band grant
 * path the only way to clear a hold would be to re-propose. This is the seam the
 * `lodestar approve` CLI and the approval UI write into.
 */

import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import { type EventEnvelope, registry } from "@qmilab/lodestar-core"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import {
  DownstreamConnection,
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
  isPolicyDeniedResult,
} from "@qmilab/lodestar-guard-mcp"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-project-approval-timeout"
const ACTOR_ID = "agent:probe-approval-timeout"
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
    // This probe drives the in-process log resolver path (a grant written
    // directly to the log), not the cross-process side-channel that signature
    // verification guards. Opt into unsigned explicitly so the signed-approval
    // default does not refuse a wait-for-approval proxy with no pinned key.
    approvals: { authorized_keys: [], allow_unsigned: true },
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

async function sessionTypes(logDir: string, sessionId: string): Promise<string[]> {
  const events = await new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)
  return events.map((e) => e.type)
}

// ── Case 1: deadline passes with no resolution → approval_timeout ────────────
async function caseTimeout(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-approval-timeout-to-"))
  const sessionId = "probe-session-timeout"
  const { proxy, calls } = makeProxy(logDir, sessionId, 250)
  try {
    await proxy.start()
    const result = await proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    if (calls.length !== 0) {
      return `[timeout] downstream tool ran ${calls.length}x; a timed-out hold must never execute the tool.`
    }
    if (result.isError !== true || !isPolicyDeniedResult(result)) {
      return "[timeout] expected a synthetic error result; got a non-error / non-Lodestar result."
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[timeout] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }

    await proxy.stop()
    const types = await sessionTypes(logDir, sessionId)
    for (const required of [
      "action.proposed",
      "action.pending_approval",
      "approval.requested",
      "approval.expired",
      "action.rejected",
    ]) {
      if (!types.includes(required)) {
        return `[timeout] event log missing '${required}'. Got: ${types.join(", ")}`
      }
    }
    if (types.includes("action.completed") || types.includes("action.approved")) {
      return `[timeout] a timed-out hold reached approved/completed. Got: ${types.join(", ")}`
    }
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 2: out-of-band grant before the deadline → executes ─────────────────
async function caseGrant(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-approval-timeout-grant-"))
  const sessionId = "probe-session-grant"
  const { proxy, calls } = makeProxy(logDir, sessionId, 3000)
  try {
    await proxy.start()
    // Start the held call; it blocks polling the log for a resolution.
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    // Out-of-band resolver: wait for the request to land, then append
    // approval.granted@1 to the SAME log. This is the *in-process* resolver
    // path — a second in-process writer shares the single-writer mutex + seq
    // counter, so the proxy finds the event already canonical in the log. (The
    // separate-process `lodestar approve` CLI cannot write the log safely
    // cross-process; it writes a side-channel the proxy promotes instead — see
    // the `approval-via-side-channel` probe.)
    const reader = new EventLogReader(logDir)
    let request: { request_id: string; action_id: string } | undefined
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const events = await reader.readSession(PROJECT_ID, sessionId)
      const reqEvent = events.find((e) => e.type === "approval.requested")
      if (reqEvent) {
        const p = reqEvent.payload as { request_id: string; action_id: string }
        request = { request_id: p.request_id, action_id: p.action_id }
        break
      }
      await delay(25)
    }
    if (request === undefined) {
      return "[grant] approval.requested never appeared in the log."
    }

    const writer = new EventLogWriter(logDir)
    const grantPayload = {
      request_id: request.request_id,
      action_id: request.action_id,
      approver_id: "human-approver",
      at: new Date().toISOString(),
    }
    await writer.append({
      id: randomUUID(),
      type: "approval.granted",
      schema_version: "0.1.0",
      project_id: PROJECT_ID,
      session_id: sessionId,
      actor_id: "human-approver",
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload: grantPayload,
      payload_hash: canonicalHash(grantPayload),
      versions: { schema_registry_version: "0.1.0" },
    })

    const result = await callPromise

    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[grant] a granted hold returned an error result (kind '${String(kind)}'); expected the tool to run.`
    }
    if (calls.length !== 1) {
      return `[grant] downstream tool ran ${calls.length}x; expected exactly 1 after a grant.`
    }
    const text = result.content[0]?.type === "text" ? result.content[0].text : undefined
    if (text !== "pushed") {
      return `[grant] result text round-trip mismatch: got '${text ?? "(undefined)"}', expected 'pushed'.`
    }

    await proxy.stop()
    const types = await sessionTypes(logDir, sessionId)
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
    return undefined
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

async function run(): Promise<ProbeResult> {
  const timeoutFail = await caseTimeout()
  if (timeoutFail) return { passed: false, details: timeoutFail }
  const grantFail = await caseGrant()
  if (grantFail) return { passed: false, details: grantFail }
  return {
    passed: true,
    details:
      "A held L4 call timed out to a synthetic approval_timeout (tool never ran; approval.expired + action.rejected logged); an out-of-band approval.granted@1 before the deadline un-parked the action and ran the tool exactly once.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: approval_timeout_denies")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
