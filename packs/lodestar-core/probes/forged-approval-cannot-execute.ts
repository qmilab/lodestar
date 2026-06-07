#!/usr/bin/env bun
/**
 * Probe: forged_approval_cannot_execute
 *
 * The cryptographic boundary on the separate-process approval path (P3). The
 * MCP proxy promotes a side-channel resolution
 * (`<log_root>/.approvals/<project>/<request-id>.json`) into a canonical
 * `approval.granted@1` and runs the held L4 action. That file's `approver_id` is
 * just a string — anything that can write the `.approvals/` directory could forge
 * it — and the `lodestar approve` authority check runs in the *writer* process, so
 * a hostile writer simply skips it. Honest-mistake protection, not a boundary.
 *
 * Signed approvals close that hole: the operator pins approver public keys in
 * `approvals.authorized_keys`, and the proxy verifies a resolution's Ed25519
 * signature against them before promoting. The trust root moves from "can write
 * the file" to "holds the approver private key". This probe drives the REAL
 * `signApprovalResolution` / verification path through the real proxy and pins:
 *
 * 1. SIGNED — a resolution signed by the pinned operator key un-parks the action:
 *    the downstream tool runs once, and the promoted `approval.granted@1` carries
 *    the verified signature (the log is self-verifying).
 *
 * 2. FORGED KEY — a resolution signed by an ATTACKER keypair but claiming the
 *    pinned approver's id is NOT promoted: the action stays held to the deadline
 *    (`approval_timeout`), the tool never runs, no `approval.granted@1` is emitted,
 *    and a `guard.approval.signature_rejected` diagnostic is recorded.
 *
 * 3. UNSIGNED — with a key pinned (no `allow_unsigned`), a resolution carrying no
 *    signature is NOT promoted: it times out, the tool never runs. This is the
 *    secure-by-default posture — an unauthenticated grant cannot execute.
 *
 * 4. TAMPERED — a validly-signed resolution whose `reason` was altered AFTER
 *    signing fails the payload_hash check and is NOT promoted: it times out, the
 *    tool never runs. A signature cannot be lifted onto modified content.
 *
 * 5. LOG-PATH BYPASS — a forged unsigned `approval.granted@1` appended directly
 *    to the sibling NDJSON log (same `log_root` as `.approvals/`, so the same
 *    local-write capability) is verified by the SAME gate and NOT promoted: the
 *    forgery boundary covers both resolution sources, not just the side-channel.
 *
 * 6. PINNED KEY + allow_unsigned — pinning a key still REQUIRES a valid signature
 *    even when `allow_unsigned: true` is also set; the opt-out must not silently
 *    weaken a key-pinned path. An unsigned resolution is still refused.
 *
 * 7. VALID-AFTER-FORGED (log) — a genuine signed `approval.granted@1` appended to
 *    the log AFTER a forged one IS honored: the scan moves past the rejected
 *    forged event, so a planted forgery cannot permanently mask a later approval.
 *
 * Why this matters: with `approval_timeout_ms > 0`, the held L4 — the whole point
 * of the trust-ladder floor — must un-park only for a real, operator-authorised
 * approver. A forged, unsigned, or tampered resolution that could un-park it would
 * defeat human-in-the-loop entirely.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests } from "@qmilab/lodestar-action-kernel"
import { type EventEnvelope, type Signature, registry } from "@qmilab/lodestar-core"
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
  readApprovalResolution,
  writeApprovalResolution,
} from "@qmilab/lodestar-guard-mcp"
import { generateApproverKeyPair, signApprovalResolution } from "@qmilab/lodestar-policy-kernel"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-project-forged-approval"
const ACTOR_ID = "agent:probe-forged-approval"
const APPROVER_ID = "human:operator"
const DOWNSTREAM_NAME = "test"
const DOWNSTREAM_TOOL_NAME = "push"
const LODESTAR_TOOL_NAME = `mcp.${DOWNSTREAM_NAME}.${DOWNSTREAM_TOOL_NAME}`

// One operator keypair pinned across the probe; the attacker mints their own.
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

/**
 * Build a proxy whose single tool is L4 (always held by the floor), pinning the
 * operator's public key so side-channel resolutions are signature-verified.
 * `allowUnsigned` defaults to false; setting it true alongside a pinned key
 * exercises the secure-by-default contract that pinning a key still REQUIRES a
 * valid signature (a stray opt-out flag must not weaken a key-pinned path).
 */
function makeProxy(
  logDir: string,
  sessionId: string,
  approvalTimeoutMs: number,
  allowUnsigned = false,
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
    // The trust root: only a resolution signed by this pinned key can un-park the
    // held action. Secure by default — and even with allow_unsigned set, a pinned
    // key still requires a valid signature.
    approvals: {
      authorized_keys: [{ actor_id: APPROVER_ID, public_key: OPERATOR.publicKeyPem }],
      allow_unsigned: allowUnsigned,
    },
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

// ── Case 1: SIGNED grant from the pinned key → promoted, tool runs once ──────
async function caseSigned(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-forged-signed-"))
  const sessionId = "probe-session-forged-signed"
  const { proxy, calls } = makeProxy(logDir, sessionId, 3000)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 2000)
    if (request === undefined) return "[signed] approval.requested never appeared in the log."

    const at = new Date().toISOString()
    const doc = {
      request_id: request.request_id,
      action_id: request.action_id,
      kind: "granted" as const,
      approver_id: APPROVER_ID,
      at,
    }
    const signature = signApprovalResolution(doc, OPERATOR.privateKeyPem)
    await writeApprovalResolution(logDir, PROJECT_ID, { ...doc, signature })

    const result = await callPromise
    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[signed] a signed grant returned an error result (kind '${String(kind)}'); expected the tool to run.`
    }
    if (calls.length !== 1) {
      return `[signed] downstream tool ran ${calls.length}x; expected exactly 1 after a signed grant.`
    }

    await proxy.stop()
    const events = await sessionEvents(logDir, sessionId)
    const grant = events.find((e) => e.type === "approval.granted")
    if (grant === undefined) return "[signed] approval.granted@1 missing after promotion."
    // The promoted event carries the verified signature — the log is self-verifying.
    const sig = (grant.payload as { signature?: Signature }).signature
    if (sig === undefined || sig.algorithm !== "ed25519" || sig.signer_id !== APPROVER_ID) {
      return `[signed] promoted approval.granted@1 did not carry the verified signature (got ${JSON.stringify(sig)}).`
    }
    return undefined
  } finally {
    // Stop on every exit path (incl. a failure early-return) so the poll loop is
    // not left running against a directory rm is about to delete.
    await proxy.stop().catch(() => {})
    await rm(logDir, { recursive: true, force: true })
  }
}

/**
 * Shared driver for the three rejection cases: write a (bad) resolution and
 * assert the held action is NOT promoted — it times out, the tool never runs,
 * no approval.granted@1 lands. `mutate` builds the resolution to write given the
 * matched request.
 */
async function expectNotPromoted(
  label: string,
  buildResolution: (
    req: { request_id: string; action_id: string },
    at: string,
  ) => {
    request_id: string
    action_id: string
    kind: "granted" | "denied"
    approver_id: string
    reason?: string
    at: string
    signature?: Signature
  },
  opts: { expectSignatureRejected: boolean; allowUnsigned?: boolean },
): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), `lodestar-probe-forged-${label}-`))
  const sessionId = `probe-session-forged-${label}`
  const { proxy, calls } = makeProxy(logDir, sessionId, 800, opts.allowUnsigned ?? false)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 500)
    if (request === undefined) return `[${label}] approval.requested never appeared in the log.`

    await writeApprovalResolution(
      logDir,
      PROJECT_ID,
      buildResolution(request, new Date().toISOString()),
    )

    const result = await callPromise
    if (result.isError !== true) {
      return `[${label}] the bad resolution was accepted; expected a timeout (it must not un-park the action).`
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[${label}] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[${label}] downstream tool ran ${calls.length}x; a rejected resolution must never execute the tool.`
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
    if (opts.expectSignatureRejected) {
      const diag = events.find((e) => e.type === "guard.approval.signature_rejected")
      if (diag === undefined) {
        return `[${label}] expected a guard.approval.signature_rejected diagnostic; got: ${types.join(", ")}`
      }
    }
    return undefined
  } finally {
    // Stop on every exit path (incl. a failure early-return) so the poll loop is
    // not left running against a directory rm is about to delete.
    await proxy.stop().catch(() => {})
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 5: LOG-PATH forgery — a forged unsigned approval.granted@1 appended ──
// directly to the sibling NDJSON log must NOT bypass the signature gate.
async function caseLogForgery(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-forged-logpath-"))
  const sessionId = "probe-session-forged-logpath"
  const { proxy, calls } = makeProxy(logDir, sessionId, 800)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 500)
    if (request === undefined) return "[log-forgery] approval.requested never appeared in the log."

    // The attacker appends a forged UNSIGNED approval.granted@1 straight into the
    // session NDJSON log — a sibling of .approvals/ under the same log_root, so
    // the same local-write capability the side-channel threat assumes. With a key
    // pinned, the log path must verify it too and refuse to promote it.
    const payload = {
      request_id: request.request_id,
      action_id: request.action_id,
      approver_id: APPROVER_ID,
      at: new Date().toISOString(),
    }
    await new EventLogWriter(logDir).append({
      id: `forged-${request.request_id}`,
      type: "approval.granted",
      schema_version: "1",
      project_id: PROJECT_ID,
      session_id: sessionId,
      actor_id: "attacker",
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })

    const result = await callPromise
    if (result.isError !== true) {
      return "[log-forgery] a forged unsigned log grant was accepted; expected a timeout."
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[log-forgery] expected _lodestar.kind 'approval_timeout'; got '${String(kind)}'.`
    }
    if (calls.length !== 0) {
      return `[log-forgery] downstream tool ran ${calls.length}x; a forged log grant must not execute the tool.`
    }

    await proxy.stop()
    const types = (await sessionEvents(logDir, sessionId)).map((e) => e.type)
    if (types.includes("action.approved") || types.includes("action.completed")) {
      return "[log-forgery] a forged unsigned log grant un-parked the held action."
    }
    if (!types.includes("guard.approval.signature_rejected")) {
      return `[log-forgery] expected a guard.approval.signature_rejected diagnostic; got: ${types.join(", ")}`
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    await rm(logDir, { recursive: true, force: true })
  }
}

// ── Case 7: a VALID signed log grant appended AFTER a forged one is still ─────
// honored — a planted forgery must not permanently mask a later genuine approval.
async function caseLogValidAfterForged(): Promise<string | undefined> {
  resetState()
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-forged-logvalid-"))
  const sessionId = "probe-session-forged-logvalid"
  const { proxy, calls } = makeProxy(logDir, sessionId, 2500)
  try {
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: LODESTAR_TOOL_NAME, arguments: {} })

    const request = await waitForRequest(logDir, sessionId, 1500)
    if (request === undefined) return "[log-valid] approval.requested never appeared in the log."

    const writer = new EventLogWriter(logDir)
    const at = new Date().toISOString()
    const envelope = (id: string, payload: Record<string, unknown>) => ({
      id,
      type: "approval.granted" as const,
      schema_version: "1",
      project_id: PROJECT_ID,
      session_id: sessionId,
      actor_id: "attacker",
      timestamp: new Date().toISOString(),
      causal_parent_ids: [] as string[],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })

    // (1) A forged UNSIGNED grant lands FIRST (the first match for this request).
    const forged = {
      request_id: request.request_id,
      action_id: request.action_id,
      approver_id: APPROVER_ID,
      at,
    }
    await writer.append(envelope(`forged-${request.request_id}`, forged))

    // (2) A genuine grant SIGNED by the pinned operator key lands SECOND. The scan
    // must move past the rejected forged event and honor this one.
    const doc = {
      request_id: request.request_id,
      action_id: request.action_id,
      kind: "granted" as const,
      approver_id: APPROVER_ID,
      at,
    }
    const signature = signApprovalResolution(doc, OPERATOR.privateKeyPem)
    await writer.append(
      envelope(`valid-${request.request_id}`, { ...forged, signature }),
    )

    const result = await callPromise
    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[log-valid] a valid signed log grant after a forged one was not honored (kind '${String(kind)}'); expected the tool to run.`
    }
    if (calls.length !== 1) {
      return `[log-valid] downstream tool ran ${calls.length}x; expected exactly 1 once the valid signed log grant was honored.`
    }
    return undefined
  } finally {
    await proxy.stop().catch(() => {})
    await rm(logDir, { recursive: true, force: true })
  }
}

async function run(): Promise<ProbeResult> {
  const signedFail = await caseSigned()
  if (signedFail) return { passed: false, details: signedFail }

  // 2. FORGED KEY — attacker keypair, claims the pinned approver's id.
  const attacker = generateApproverKeyPair()
  const forgedFail = await expectNotPromoted(
    "forged",
    (req, at) => {
      const doc = {
        request_id: req.request_id,
        action_id: req.action_id,
        kind: "granted" as const,
        approver_id: APPROVER_ID,
        at,
      }
      return { ...doc, signature: signApprovalResolution(doc, attacker.privateKeyPem) }
    },
    { expectSignatureRejected: true },
  )
  if (forgedFail) return { passed: false, details: forgedFail }

  // 3. UNSIGNED — no signature, with a key pinned (no allow_unsigned).
  const unsignedFail = await expectNotPromoted(
    "unsigned",
    (req, at) => ({
      request_id: req.request_id,
      action_id: req.action_id,
      kind: "granted" as const,
      approver_id: APPROVER_ID,
      at,
    }),
    { expectSignatureRejected: true },
  )
  if (unsignedFail) return { passed: false, details: unsignedFail }

  // 4. TAMPERED — sign with reason "ok", then write with reason "tampered".
  const tamperedFail = await expectNotPromoted(
    "tampered",
    (req, at) => {
      const signedDoc = {
        request_id: req.request_id,
        action_id: req.action_id,
        kind: "granted" as const,
        approver_id: APPROVER_ID,
        reason: "ok",
        at,
      }
      const signature = signApprovalResolution(signedDoc, OPERATOR.privateKeyPem)
      // Same signature, altered reason → payload_hash no longer matches.
      return { ...signedDoc, reason: "tampered", signature }
    },
    { expectSignatureRejected: true },
  )
  if (tamperedFail) return { passed: false, details: tamperedFail }

  // 5. LOG-PATH forgery — bypass the side-channel by writing to the sibling log.
  const logForgeryFail = await caseLogForgery()
  if (logForgeryFail) return { passed: false, details: logForgeryFail }

  // 6. PINNED KEY + allow_unsigned — pinning a key must still REQUIRE a signature
  // even when allow_unsigned is also set; the opt-out must not weaken a key-pinned
  // path (otherwise pinning a key gives a false sense of security).
  const allowUnsignedFail = await expectNotPromoted(
    "pinned-allow-unsigned",
    (req, at) => ({
      request_id: req.request_id,
      action_id: req.action_id,
      kind: "granted" as const,
      approver_id: APPROVER_ID,
      at,
    }),
    { expectSignatureRejected: true, allowUnsigned: true },
  )
  if (allowUnsignedFail) return { passed: false, details: allowUnsignedFail }

  // 7. A valid signed log grant after a forged one is still honored (the forged
  // event must not permanently mask the genuine later approval).
  const logValidFail = await caseLogValidAfterForged()
  if (logValidFail) return { passed: false, details: logValidFail }

  return {
    passed: true,
    details:
      "A side-channel resolution signed by the pinned operator key un-parked the held L4 (tool ran once; the promoted approval.granted@1 carried the verified signature). A forgery signed by an attacker key claiming the operator's id, an unsigned resolution, a validly-signed-then-tampered resolution, and a forged unsigned approval.granted@1 appended directly to the sibling NDJSON log (the log-path bypass) were each refused — held to the deadline, timed out, never ran the tool, with a guard.approval.signature_rejected diagnostic. Pinning a key still required a signature even with allow_unsigned set. And a genuine signed log grant landing after a forged one was still honored — the forgery did not mask it.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: forged_approval_cannot_execute")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
