#!/usr/bin/env bun
/**
 * Probe: approval_via_http_channel
 *
 * The pluggable approval transport (ADR-0015), HTTP variant. The MCP proxy's
 * hold loop reads an out-of-band resolution through an `ApprovalChannel`. The
 * default is the local signed `.approvals/` file channel (pinned by
 * `approval-via-side-channel`); this probe drives the **HTTP** channel — a remote
 * approval service — built by the proxy from `config.approvals.channel` and run
 * against an in-process `Bun.serve` stub.
 *
 * The forgery boundary does NOT move: an HTTP channel reads bytes from a remote
 * service that the consumer (`resolutionVerified`) signature-verifies AFTER
 * transport, so an unsigned HTTP channel is unrepresentable (a pinned approver key
 * is required). Every resolution the stub serves is therefore signed by the pinned
 * operator key.
 *
 * Cases:
 *
 * 1. GRANT — a signed `granted` resolution served over HTTP un-parks the action:
 *    the tool runs once, the proxy promotes a canonical `approval.granted@1`
 *    (authored by the proxy actor, carrying the verified signature), the proxy
 *    `announce`d the hold (POST /v1/approvals) and `consume`d the resolution
 *    (DELETE) after promoting. Sole-writer `seq` stays strictly monotonic.
 *
 * 2. CREDENTIAL — the operator bearer token reaches the service as an
 *    `Authorization: Bearer …` header but appears in NO event-log envelope. The
 *    proxy never reads `process.env`; the host injects the resolver.
 *
 * 3. DENY — a signed `denied` resolution is promoted to `approval.denied@1` /
 *    `action.rejected`; the tool never runs.
 *
 * 4. LATE — a signed `granted` whose approver `at` is after the deadline is NOT
 *    promoted (offset-safe numeric gate); the hold times out, the tool never runs.
 *
 * The companion `forged-approval-via-http-channel-cannot-execute` pins that a
 * hostile HTTP service cannot mint / tamper / replay a grant.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import { type EventEnvelope, type Signature, registry } from "@qmilab/lodestar-core"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import {
  type ApprovalChannel,
  type ApprovalResolution,
  DownstreamConnection,
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
  isPolicyDeniedResult,
} from "@qmilab/lodestar-guard-mcp"
import { generateApproverKeyPair, signApprovalResolution } from "@qmilab/lodestar-policy-kernel"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-project-http-approval"
const ACTOR_ID = "agent:probe-http-approval"
const APPROVER_ID = "human:operator"
const DOWNSTREAM_NAME = "test"
const DOWNSTREAM_TOOL_NAME = "push"
const LODESTAR_TOOL_NAME = `mcp.${DOWNSTREAM_NAME}.${DOWNSTREAM_TOOL_NAME}`
const BEARER_TOKEN = "probe-approval-bearer-token-must-not-leak"

const OPERATOR = generateApproverKeyPair()

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

// ── in-process signed-approval-service stub ─────────────────────────────────

interface StubRecord {
  method: string
  path: string
  authorization: string | null
  body: string
}

interface Stub {
  base: string
  recorded: StubRecord[]
  /** Set the resolution the GET route serves; until set, GET returns 404. */
  serve: (resolution: ApprovalResolution | undefined) => void
  /** Stall every GET response by `ms` (simulates a slow approval service). */
  setGetDelay: (ms: number) => void
  stop: () => void
}

function startStub(): Stub {
  const recorded: StubRecord[] = []
  let current: ApprovalResolution | undefined
  let getDelayMs = 0
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text()
      recorded.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body,
      })
      if (req.method === "GET") {
        if (getDelayMs > 0) await delay(getDelayMs)
        return current === undefined ? new Response(null, { status: 404 }) : Response.json(current)
      }
      if (req.method === "DELETE") {
        current = undefined
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 202 }) // POST announce
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    recorded,
    serve: (resolution) => {
      current = resolution
    },
    setGetDelay: (ms) => {
      getDelayMs = ms
    },
    stop: () => server.stop(true),
  }
}

/** Build a proxy whose single tool is L4 (always held), wired to read approvals
 * over the HTTP channel at `stubBase`, verifying against the pinned operator key.
 * `channelTimeoutMs` is the per-request wall-clock cap of the HTTP channel itself
 * (distinct from the approval budget). */
function makeProxy(
  logDir: string,
  sessionId: string,
  approvalTimeoutMs: number,
  stubBase: string,
  channelTimeoutMs = 5_000,
  channelOverride?: ApprovalChannel,
) {
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
    // An HTTP channel is signature-verified (the pinned key); allow_unsigned is
    // forbidden for it. The stub is loopback http, so allow_http is the explicit
    // local/dev escape.
    approvals: {
      authorized_keys: [{ actor_id: APPROVER_ID, public_key: OPERATOR.publicKeyPem }],
      allow_unsigned: false,
      channel: {
        kind: "http",
        endpoint: stubBase,
        token_env: "PROBE_APPROVAL_TOKEN",
        allow_http: true,
        timeout_ms: channelTimeoutMs,
        max_body_bytes: 64 * 1024,
      },
    },
    downstream_servers: [{ name: DOWNSTREAM_NAME, command: "not-spawned", args: [] }],
    tool_defaults: {
      [LODESTAR_TOOL_NAME]: {
        reversibility: "irreversible",
        permissions: [],
        sandbox: "controlled-shell",
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
    // The proxy never reads process.env: the host injects the bearer resolver.
    resolveApprovalToken: () => BEARER_TOKEN,
    // An injected channel (used by the rejecting-channel case) wins over config.
    ...(channelOverride !== undefined ? { approvalChannel: channelOverride } : {}),
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

/** Poll `predicate` until true or the deadline. The proxy fires `announce`
 * fire-and-forget (it must never block the hold), so an assertion on it waits
 * for the POST rather than assuming it already landed. */
async function waitFor(predicate: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(20)
  }
  return predicate()
}

function signedResolution(
  req: { request_id: string; action_id: string },
  kind: "granted" | "denied",
  at: string,
): ApprovalResolution {
  const doc = {
    request_id: req.request_id,
    action_id: req.action_id,
    kind,
    approver_id: APPROVER_ID,
    at,
  }
  return { ...doc, signature: signApprovalResolution(doc, OPERATOR.privateKeyPem) }
}

// ── Case 1+2: GRANT over HTTP + credential never in the log ──────────────────
async function caseGrant(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-http-approval-grant-"))
  const sessionId = "probe-session-http-grant"
  const stub = startStub()
  // Generous approval-timeout CEILING (not the actual wait): the resolution is
  // served promptly, so the case resolves in ~one poll. The large ceiling only
  // removes a deadline race — under heavy load (e.g. a concurrent build) a 3s
  // budget could elapse before the served resolution is fetched + promoted.
  const { proxy, calls } = makeProxy(logDir, sessionId, 15_000, stub.base)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 2000)
    if (request === undefined) return "[grant] approval.requested never appeared in the log."

    // The remote approval service now has a signed grant available for this request.
    stub.serve(signedResolution(request, "granted", new Date().toISOString()))

    const result = await callPromise
    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[grant] a signed HTTP grant returned an error result (kind '${String(kind)}'); expected the tool to run.`
    }
    if (calls.length !== 1) {
      return `[grant] downstream tool ran ${calls.length}x; expected exactly 1 after an HTTP grant.`
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

    const grant = events.find((e) => e.type === "approval.granted")
    if (grant === undefined) return "[grant] approval.granted@1 missing after promotion."
    if (grant.actor_id !== ACTOR_ID) {
      return `[grant] approval.granted@1 authored by '${grant.actor_id}', not the proxy actor '${ACTOR_ID}'.`
    }
    const sig = (grant.payload as { signature?: Signature }).signature
    if (sig === undefined || sig.algorithm !== "ed25519" || sig.signer_id !== APPROVER_ID) {
      return `[grant] promoted approval.granted@1 did not carry the verified signature (got ${JSON.stringify(sig)}).`
    }

    // Sole-writer seq integrity — nothing but the proxy ever appended to the log.
    const all = await new EventLogReader(logDir).readAll(PROJECT_ID)
    for (let i = 1; i < all.length; i++) {
      const cur = all[i]
      const prev = all[i - 1]
      if (!cur || !prev) return `[grant] sparse log at index ${i} (seq-integrity regression).`
      if (cur.seq <= prev.seq) {
        return `[grant] non-monotonic seq at index ${i}: ${prev.seq} then ${cur.seq}.`
      }
    }

    // The proxy announced the hold (POST, fire-and-forget) and consumed the
    // resolution (DELETE). The announce is not awaited by the hold, so wait for it.
    const announced = await waitFor(
      () => stub.recorded.some((r) => r.method === "POST" && r.path === "/v1/approvals"),
      1000,
    )
    if (!announced) {
      return "[grant] the proxy never POSTed the hold announcement to /v1/approvals."
    }
    // consume() is fire-and-forget too (cleanup must not delay execution), so wait.
    const consumed = await waitFor(() => stub.recorded.some((r) => r.method === "DELETE"), 1000)
    if (!consumed) {
      return "[grant] the proxy never DELETEd (consumed) the promoted resolution."
    }

    // CREDENTIAL: the bearer token reached the service but is in NO event envelope.
    if (!stub.recorded.some((r) => r.authorization === `Bearer ${BEARER_TOKEN}`)) {
      return "[grant] the operator bearer token never reached the service as an Authorization header."
    }
    const serialized = JSON.stringify(await new EventLogReader(logDir).readAll(PROJECT_ID))
    if (serialized.includes(BEARER_TOKEN)) {
      return "[grant] the operator bearer token leaked into the event log."
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    stub.stop()
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 3: DENY over HTTP → rejected, tool never runs ───────────────────────
async function caseDeny(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-http-approval-deny-"))
  const sessionId = "probe-session-http-deny"
  const stub = startStub()
  // Generous approval-timeout CEILING (not the actual wait): the resolution is
  // served promptly, so the case resolves in ~one poll. The large ceiling only
  // removes a deadline race — under heavy load (e.g. a concurrent build) a 3s
  // budget could elapse before the served resolution is fetched + promoted.
  const { proxy, calls } = makeProxy(logDir, sessionId, 15_000, stub.base)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 2000)
    if (request === undefined) return "[deny] approval.requested never appeared in the log."

    stub.serve(signedResolution(request, "denied", new Date().toISOString()))

    const result = await callPromise
    if (result.isError !== true || !isPolicyDeniedResult(result)) {
      return "[deny] expected a synthetic error result; got a non-error / non-Lodestar result."
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_denied") {
      return `[deny] expected _lodestar.kind 'approval_denied'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[deny] downstream tool ran ${calls.length}x; a denied hold must never execute.`
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
    await proxy.stop().catch(() => {})
    stub.stop()
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 4: LATE resolution (at after deadline) → not promoted, times out ────
async function caseLate(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-http-approval-late-"))
  const sessionId = "probe-session-http-late"
  const stub = startStub()
  const { proxy, calls } = makeProxy(logDir, sessionId, 700, stub.base)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 500)
    if (request === undefined) return "[late] approval.requested never appeared in the log."

    // A correctly-signed grant, but dated a minute past the hold deadline.
    stub.serve(signedResolution(request, "granted", new Date(Date.now() + 60_000).toISOString()))

    const result = await callPromise
    if (result.isError !== true) return "[late] a late grant was accepted; expected a timeout."
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[late] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[late] downstream tool ran ${calls.length}x; a late grant must not execute.`
    }

    await proxy.stop()
    const types = (await sessionEvents(logDir, sessionId)).map((e) => e.type)
    if (types.includes("approval.granted")) {
      return "[late] a post-deadline HTTP grant was promoted to approval.granted@1."
    }
    for (const required of ["approval.expired", "action.rejected"]) {
      if (!types.includes(required)) {
        return `[late] event log missing '${required}'. Got: ${types.join(", ")}`
      }
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    stub.stop()
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 5: a SLOW channel respects the approval budget, not its own timeout ──
// A held action must time out at `approval_timeout_ms`, even when the HTTP
// channel's own `timeout_ms` is much larger and the service stalls every poll.
// Without the per-fetch deadline cap, a single slow fetch would overshoot the
// budget (and the wrapped agent's tools/call timeout). (Codex review.)
async function caseSlowChannelRespectsBudget(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-http-approval-slow-"))
  const sessionId = "probe-session-http-slow"
  const stub = startStub()
  stub.setGetDelay(4_000) // each poll's GET stalls far past the approval budget
  // approval budget 500ms; channel timeout 10s (>> budget) — the cap must bite.
  const { proxy, calls } = makeProxy(logDir, sessionId, 500, stub.base, 10_000)
  try {
    await proxy.start()
    const started = Date.now()
    const result = await proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })
    const elapsed = Date.now() - started

    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (result.isError !== true || kind !== "approval_timeout") {
      return `[slow] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[slow] downstream tool ran ${calls.length}x; a timed-out hold must not execute.`
    }
    // The budget is 500ms; the channel timeout is 10s and each GET stalls 4s.
    // Bounded by the approval deadline, the hold must end well before the channel
    // timeout — a generous ceiling (3s) that the unbounded behaviour (≥4s) fails.
    if (elapsed >= 3_000) {
      return `[slow] the hold took ${elapsed}ms — it overshot the 500ms approval budget toward the 10s channel timeout (the per-fetch deadline cap is not applied).`
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    stub.stop()
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 6: a no-wait hold returns immediately and does NOT announce ─────────
// With `approval_timeout_ms === 0` the proxy returns `approval_required` at once;
// nobody will poll, so it must not block on (or even send) the advisory announce
// POST — a slow/down approval service can't delay the immediate denial. (Codex.)
async function caseNoWaitDoesNotAnnounce(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-http-approval-nowait-"))
  const sessionId = "probe-session-http-nowait"
  const stub = startStub()
  const { proxy, calls } = makeProxy(logDir, sessionId, 0, stub.base)
  try {
    await proxy.start()
    const started = Date.now()
    const result = await proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })
    const elapsed = Date.now() - started

    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (result.isError !== true || kind !== "approval_required") {
      return `[no-wait] expected _lodestar.kind 'approval_required'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[no-wait] downstream tool ran ${calls.length}x; a no-wait hold must not execute.`
    }
    if (elapsed >= 2_000) {
      return `[no-wait] the no-wait hold took ${elapsed}ms — it should return immediately.`
    }
    // The proxy must not have announced: nobody will poll, so the advisory POST is
    // skipped entirely (the file channel has no announce either). Give any stray
    // fire-and-forget POST a moment to land, then assert none did.
    await delay(100)
    if (stub.recorded.some((r) => r.method === "POST")) {
      return "[no-wait] the proxy announced (POSTed) on the no-wait path; it should not."
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    stub.stop()
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 7: a custom channel whose fetch REJECTS fails closed, not propagates ──
// The built-in channels never reject (every failure → undefined), but a custom
// `MCPProxyOverrides.approvalChannel` might reject on a transient error. The proxy
// must treat that as "no resolution yet" and route through the normal timeout, not
// let the rejection escape and break the held tool call. (Codex review.)
async function caseRejectingChannelFailsClosed(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-http-approval-reject-"))
  const sessionId = "probe-session-http-reject"
  const stub = startStub()
  const rejecting: ApprovalChannel = {
    fetch: async () => {
      throw new Error("transient channel failure")
    },
  }
  const { proxy, calls } = makeProxy(logDir, sessionId, 600, stub.base, 5_000, rejecting)
  try {
    await proxy.start()
    let result: Awaited<ReturnType<typeof proxy.handleCallTool>>
    try {
      result = await proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })
    } catch (err) {
      return `[reject] a rejecting channel propagated out of the hold instead of failing closed: ${String(err)}`
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (result.isError !== true || kind !== "approval_timeout") {
      return `[reject] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[reject] downstream tool ran ${calls.length}x; a rejecting channel must not execute.`
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    stub.stop()
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
  const slowFail = await caseSlowChannelRespectsBudget()
  if (slowFail) return { passed: false, details: slowFail }
  const noWaitFail = await caseNoWaitDoesNotAnnounce()
  if (noWaitFail) return { passed: false, details: noWaitFail }
  const rejectFail = await caseRejectingChannelFailsClosed()
  if (rejectFail) return { passed: false, details: rejectFail }
  return {
    passed: true,
    details:
      "A signed grant served over the HTTP approval channel un-parked the held L4 (tool ran once; the promoted approval.granted@1 was authored by the proxy actor and carried the verified signature; seq stayed strictly monotonic; the proxy announced the hold and consumed the resolution). The operator bearer token reached the service as a header but appeared in no event envelope. A signed HTTP deny rejected the action without running the tool, and a post-deadline signed grant was refused — the hold timed out. A slow channel (10s timeout, 4s-stalled polls) still timed the hold out at its 500ms approval budget, and a no-wait hold returned approval_required immediately without announcing.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: approval_via_http_channel")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
