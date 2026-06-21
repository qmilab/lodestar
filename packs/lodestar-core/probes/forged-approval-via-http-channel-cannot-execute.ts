#!/usr/bin/env bun
/**
 * Probe: forged_approval_via_http_channel_cannot_execute
 *
 * The forgery boundary holds across the pluggable approval transport (ADR-0015):
 * routing the proxy's hold loop through an HTTP `ApprovalChannel` does NOT move
 * where signatures are verified. `ApprovalChannel.fetch` returns UNTRUSTED bytes;
 * the consumer (`MCPProxy.resolutionVerified`) verifies the Ed25519 signature
 * against the operator-pinned approver keys AFTER transport, before promoting. So
 * a fully hostile approval service can only *delay* an approval (a DoS that times
 * the hold out to the conservative outcome) — never mint, tamper, or replay one.
 *
 * This is the HTTP sibling of `forged-approval-cannot-execute` (the file path). A
 * hostile in-process `Bun.serve` stub serves each bad resolution; the real
 * `HttpApprovalChannel` fetches it through the real proxy, and each is refused:
 *
 * 1. FORGED KEY — signed by an ATTACKER keypair but claiming the pinned approver's
 *    id → signature verification fails: held to the deadline (`approval_timeout`),
 *    the tool never runs, no `approval.granted@1`, a `guard.approval.signature_rejected`
 *    diagnostic is recorded.
 *
 * 2. TAMPERED — validly signed, then the `reason` altered after signing →
 *    payload_hash mismatch → refused (diagnostic recorded), tool never runs.
 *
 * 3. REPLAYED — a resolution validly signed by the operator but bound to a
 *    DIFFERENT action is served for this hold → the action-id binding gate refuses
 *    it before it ever reaches the signature check; the hold times out, the tool
 *    never runs, no grant.
 *
 * 4. LATE — a correctly-signed grant dated after the deadline → the offset-safe
 *    numeric gate refuses it; the hold times out, the tool never runs.
 *
 * In every case the held L4 — the whole point of the trust-ladder floor — stays
 * parked. A remote channel is a transport, not a trust root.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import { type EventEnvelope, registry } from "@qmilab/lodestar-core"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import {
  type ApprovalResolution,
  DownstreamConnection,
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
} from "@qmilab/lodestar-guard-mcp"
import { generateApproverKeyPair, signApprovalResolution } from "@qmilab/lodestar-policy-kernel"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-project-forged-http-approval"
const ACTOR_ID = "agent:probe-forged-http-approval"
const APPROVER_ID = "human:operator"
const DOWNSTREAM_NAME = "test"
const DOWNSTREAM_TOOL_NAME = "push"
const LODESTAR_TOOL_NAME = `mcp.${DOWNSTREAM_NAME}.${DOWNSTREAM_TOOL_NAME}`

const OPERATOR = generateApproverKeyPair()
const ATTACKER = generateApproverKeyPair()

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

interface Stub {
  base: string
  serve: (resolution: ApprovalResolution | undefined) => void
  stop: () => void
}

function startStub(): Stub {
  let current: ApprovalResolution | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (req.method === "GET") {
        return current === undefined ? new Response(null, { status: 404 }) : Response.json(current)
      }
      if (req.method === "DELETE") {
        current = undefined
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 202 })
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    serve: (resolution) => {
      current = resolution
    },
    stop: () => server.stop(true),
  }
}

function makeProxy(logDir: string, sessionId: string, approvalTimeoutMs: number, stubBase: string) {
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
    approvals: {
      authorized_keys: [{ actor_id: APPROVER_ID, public_key: OPERATOR.publicKeyPem }],
      allow_unsigned: false,
      channel: {
        kind: "http",
        endpoint: stubBase,
        allow_http: true,
        timeout_ms: 5_000,
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

/**
 * Drive a single rejection case: serve a (bad) resolution over the HTTP channel
 * and assert the held action is NOT promoted — it times out, the tool never runs,
 * no `approval.granted@1` lands. `buildResolution` shapes the served bytes given
 * the matched request.
 */
async function expectNotPromoted(
  label: string,
  buildResolution: (
    req: { request_id: string; action_id: string },
    at: string,
  ) => ApprovalResolution,
  opts: { expectSignatureRejected: boolean },
): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), `lodestar-probe-forged-http-${label}-`))
  const sessionId = `probe-session-forged-http-${label}`
  const stub = startStub()
  const { proxy, calls } = makeProxy(logDir, sessionId, 800, stub.base)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 500)
    if (request === undefined) return `[${label}] approval.requested never appeared in the log.`

    stub.serve(buildResolution(request, new Date().toISOString()))

    const result = await callPromise
    if (result.isError !== true) {
      return `[${label}] the bad resolution was accepted; expected a timeout (it must not un-park the action).`
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[${label}] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[${label}] downstream tool ran ${calls.length}x; a rejected resolution must never execute.`
    }

    await proxy.stop()
    const events = await sessionEvents(logDir, sessionId)
    const types = events.map((e) => e.type)
    if (types.includes("approval.granted")) {
      return `[${label}] a rejected resolution was promoted to approval.granted@1.`
    }
    for (const required of ["approval.expired", "action.rejected"]) {
      if (!types.includes(required)) {
        return `[${label}] event log missing '${required}'. Got: ${types.join(", ")}`
      }
    }
    if (opts.expectSignatureRejected && !types.includes("guard.approval.signature_rejected")) {
      return `[${label}] expected a guard.approval.signature_rejected diagnostic; got: ${types.join(", ")}`
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    stub.stop()
    await rm(logDir, { recursive: true, force: true })
  }
}

function sign(
  doc: {
    request_id: string
    action_id: string
    kind: "granted" | "denied"
    approver_id: string
    reason?: string
    at: string
  },
  privateKeyPem: string,
): ApprovalResolution {
  return { ...doc, signature: signApprovalResolution(doc, privateKeyPem) }
}

async function run(): Promise<ProbeResult> {
  // 1. FORGED KEY — attacker keypair, claims the pinned approver's id.
  const forgedFail = await expectNotPromoted(
    "forged",
    (req, at) =>
      sign(
        {
          request_id: req.request_id,
          action_id: req.action_id,
          kind: "granted",
          approver_id: APPROVER_ID,
          at,
        },
        ATTACKER.privateKeyPem,
      ),
    { expectSignatureRejected: true },
  )
  if (forgedFail) return { passed: false, details: forgedFail }

  // 2. TAMPERED — sign with reason "ok", serve with reason "tampered".
  const tamperedFail = await expectNotPromoted(
    "tampered",
    (req, at) => {
      const signed = sign(
        {
          request_id: req.request_id,
          action_id: req.action_id,
          kind: "granted",
          approver_id: APPROVER_ID,
          reason: "ok",
          at,
        },
        OPERATOR.privateKeyPem,
      )
      return { ...signed, reason: "tampered" }
    },
    { expectSignatureRejected: true },
  )
  if (tamperedFail) return { passed: false, details: tamperedFail }

  // 3. REPLAYED — validly signed by the operator but bound to a DIFFERENT action.
  // The action-id binding gate refuses it before the signature check runs.
  const replayedFail = await expectNotPromoted(
    "replayed",
    (req, at) =>
      sign(
        {
          request_id: req.request_id,
          action_id: "some-other-action-id",
          kind: "granted",
          approver_id: APPROVER_ID,
          at,
        },
        OPERATOR.privateKeyPem,
      ),
    { expectSignatureRejected: false },
  )
  if (replayedFail) return { passed: false, details: replayedFail }

  // 4. MISMATCHED REQUEST — validly signed by the operator for the right action
  // but a DIFFERENT request_id. The request-id binding refuses it (the channel
  // rejects a response not bound to the fetched ref, and the proxy's
  // `channelOutcomeFor` enforces the same binding), so it never resolves THIS
  // request — which would otherwise leave the real approval.requested open.
  const mismatchedFail = await expectNotPromoted(
    "mismatched-request",
    (req, at) =>
      sign(
        {
          request_id: "some-other-request-id",
          action_id: req.action_id,
          kind: "granted",
          approver_id: APPROVER_ID,
          at,
        },
        OPERATOR.privateKeyPem,
      ),
    { expectSignatureRejected: false },
  )
  if (mismatchedFail) return { passed: false, details: mismatchedFail }

  // 5. LATE — correctly signed grant dated after the deadline.
  const lateFail = await expectNotPromoted(
    "late",
    (req) =>
      sign(
        {
          request_id: req.request_id,
          action_id: req.action_id,
          kind: "granted",
          approver_id: APPROVER_ID,
          at: new Date(Date.now() + 60_000).toISOString(),
        },
        OPERATOR.privateKeyPem,
      ),
    { expectSignatureRejected: false },
  )
  if (lateFail) return { passed: false, details: lateFail }

  return {
    passed: true,
    details:
      "Over the HTTP approval channel, a grant signed by an attacker key claiming the operator's id and a validly-signed-then-tampered grant were each refused with a guard.approval.signature_rejected diagnostic; a grant validly signed but bound to a different action, one bound to a different request_id, and a correctly-signed grant dated past the deadline were each refused by the binding / deadline gates. In every case the held L4 stayed parked, timed out, and never ran the tool — a hostile remote channel can delay an approval but never forge one.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: forged_approval_via_http_channel_cannot_execute")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
