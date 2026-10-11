#!/usr/bin/env bun
/**
 * Probe: approved-action-cannot-be-substituted
 *
 * ADR-0042 / #179 — Loopjacking's *representation mismatch*: an approver is shown
 * something other than the operation that will run. The approval surface used to
 * carry an `action_id` and the rule's reason, never the operation; a signed
 * resolution said nothing about WHAT was approved. Now a request names the held
 * operation (`action_type` + `inputs_hash`, the `actionRepresentationHash` of
 * `{ action_id, tool, inputs, contract, proposed_by }`), an approver's tooling
 * binds the representation it rendered into the signed resolution, and every host
 * recomputes the hash from **the action it is about to run** before it promotes
 * anything.
 *
 * The event log is not authenticated per event — a local writer can append to it
 * and to the `.approvals/` side-channel, but cannot forge an approver's Ed25519
 * signature. So each host is asserted on its OWN promotion sites, with real
 * signatures, and every refusal is paired with a correctly bound control that
 * executes — the refusal must be the binding, not a bad key.
 *
 * Pure surfaces:
 *   A. Byte-identity: a resolution with no `inputs_hash` has its exact pre-ADR
 *      canonical hash, and a request with neither new field parses unchanged.
 *   B. `ActionKernel.resolve()` refuses an outcome bound to a different
 *      representation (the backstop behind every host).
 *   C. `evaluateQuorum` refuses a vote bound to a different representation than
 *      its request, so a log re-adjudicator reaches the host's answer.
 *   D. The approver-visible rendering re-parses to the canonical stored inputs and
 *      re-hashes to the request's `inputs_hash`; a bidi override renders escaped;
 *      a planted `action.proposed` and a planted unbound copy of the request are
 *      each a MISMATCH.
 *
 * guard.wrap() (in process):
 *   E. A resolver outcome bound to a different representation is refused — the
 *      tool never runs — while the correctly bound control executes and its
 *      `approval.granted@1` carries the binding.
 *   F. A held action whose live inputs were mutated while the resolver waited is
 *      refused: the request no longer describes it.
 *   G. Quorum votes bound to a different representation are never promoted; the
 *      bound control reaches quorum and its promoted votes still verify.
 *
 * The MCP proxy (real `.approvals/` side-channel + its own log):
 *   H. Single-approver channel: a validly signed grant naming a different
 *      operation is refused (audited, consumed, never promoted) and the hold keeps
 *      waiting; a correctly bound grant then executes — and the downstream tool
 *      receives the CANONICAL inputs (what runs is what was hashed).
 *   I. Single-approver log path: the same grant appended straight to the log is
 *      refused and audited with its event id, and the read-side queue keeps the
 *      request pending.
 *   J. A held action whose live inputs were mutated during the hold is refused.
 *   K. Quorum: a mismatched channel vote is never promoted and a mismatched log
 *      vote is audited; correctly bound votes then reach quorum and the downstream
 *      tool receives the canonical inputs.
 *   K2. A bound quorum DENY is promoted with its binding and vetoes at once.
 *
 * The runtime gate (real NDJSON-RPC loopback, durable resume):
 *   L. Single-approver channel + log path: both mismatches refused and audited; an
 *      UNBOUND legacy grant still resolves a bound request (verify-if-present),
 *      and the remoted body receives the canonical inputs.
 *   M. Restart over a planted `action.pending_approval` (same id, other inputs):
 *      the gate refuses to resume rather than run whichever record sorts last.
 *   N. Restart over a planted `approval.requested` that strips the quorum: one
 *      valid vote must NOT execute a quorum hold — the conflict fails closed.
 *   O. Quorum sites: a mismatched channel vote is never promoted, a mismatched log
 *      vote is audited, and bound votes reach quorum with the body receiving the
 *      canonical inputs.
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import {
  ActionKernel,
  type ApprovalOutcome,
  _resetToolsForTests,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import {
  APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  type Action,
  type ApprovalRequest,
  ApprovalRequestSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE,
  type GuardApprovalSignatureRejectedPayload,
  type Policy,
  actionRepresentationHash,
  canonicalJsonValue,
  registry,
} from "@qmilab/lodestar-core"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import {
  type Actor,
  type ApprovalResolution,
  type ApproverAuthorityConfig,
  type GuardConfig,
  type QuorumRoster,
  alwaysHoldsChecker,
  authorizeResolution,
  canonicalApprovalResolutionHash,
  compile,
  evaluateQuorum,
  generateApproverKeyPair,
  runGuarded,
  signApprovalResolution,
  verifyApprovalSignature,
} from "@qmilab/lodestar-guard"
import {
  DownstreamConnection,
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
  readApprovalResolution,
  writeApprovalResolution,
} from "@qmilab/lodestar-guard-mcp"
import {
  RuntimeGate,
  RuntimeGateConfigSchema,
  createLoopbackPair,
} from "@qmilab/lodestar-runtime-core"
import {
  approvalRepresentation,
  pendingApprovals,
  renderCanonicalJson,
} from "@qmilab/lodestar-trace"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.representation@1"
const PROJECT_ID = "probe-representation"
const AGENT_ID = "probe-agent"
const REP_PREFIX = "representation mismatch:"

// ── Approvers ────────────────────────────────────────────────────────────────

const APPROVERS = ["alice", "bob", "carol"] as const
const keypairs = new Map(APPROVERS.map((id) => [id, generateApproverKeyPair()]))

function keyOf(id: string): { publicKeyPem: string; privateKeyPem: string } {
  const kp = keypairs.get(id as (typeof APPROVERS)[number])
  if (kp === undefined) throw new Error(`probe: no keypair for '${id}'`)
  return kp
}

const AUTHORITY: ApproverAuthorityConfig = {
  trust_baseline: 1,
  sensitivity_clearance: "secret",
  authority_scope: [{ level: "global", identifier: "*" }],
}

function actorFor(id: string): Actor {
  return {
    id,
    kind: "human",
    display_name: id,
    authority_scope: AUTHORITY.authority_scope,
    trust_baseline: AUTHORITY.trust_baseline,
    sensitivity_clearance: AUTHORITY.sensitivity_clearance,
    created_at: "2026-10-11T00:00:00.000Z",
  }
}

function roster(): QuorumRoster {
  return {
    authorized_keys: new Map(APPROVERS.map((id) => [id, keyOf(id).publicKeyPem])),
    approvers: new Map(APPROVERS.map((id) => [id, actorFor(id)])),
  }
}

function pinnedKeys(): Array<{
  actor_id: string
  public_key: string
  authority: ApproverAuthorityConfig
}> {
  return APPROVERS.map((id) => ({
    actor_id: id,
    public_key: keyOf(id).publicKeyPem,
    authority: AUTHORITY,
  }))
}

let voteClock = 0

/**
 * One approver's OWN signed resolution. `inputsHash` is the representation the
 * approver's tooling bound — the operation they were SHOWN. Omitted, it is the
 * unbound legacy shape.
 */
function vote(
  request: { request_id: string; action_id: string },
  approverId: string,
  inputsHash?: string,
  kind: "granted" | "denied" = "granted",
): ApprovalResolution {
  voteClock += 1
  const doc = {
    request_id: request.request_id,
    action_id: request.action_id,
    kind,
    approver_id: approverId,
    at: new Date(Date.now() + voteClock).toISOString(),
    ...(inputsHash !== undefined ? { inputs_hash: inputsHash } : {}),
  }
  return { ...doc, signature: signApprovalResolution(doc, keyOf(approverId).privateKeyPem) }
}

/**
 * The representation a deceived approver was shown: the SAME action — same id,
 * tool, contract, actor — with benign inputs. This is exactly the hash a planted
 * `action.proposed` record would make an approver's tooling compute.
 */
function benignHashFor(held: Action, benignInputs: unknown): string {
  return actionRepresentationHash({ ...held, inputs: benignInputs })
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readSession(logDir: string, sessionId: string): Promise<EventEnvelope[]> {
  return new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)
}

function countOf(events: EventEnvelope[], type: string): number {
  return events.filter((e) => e.type === type).length
}

function representationRejections(
  events: EventEnvelope[],
): GuardApprovalSignatureRejectedPayload[] {
  return events
    .filter((e) => e.type === GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE)
    .map((e) => e.payload as GuardApprovalSignatureRejectedPayload)
    .filter((p) => p.reason.startsWith(REP_PREFIX))
}

async function waitFor(check: () => Promise<boolean>, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await delay(20)
  }
  return false
}

async function waitForEvent(
  logDir: string,
  sessionId: string,
  type: string,
  withinMs: number,
): Promise<EventEnvelope | undefined> {
  let found: EventEnvelope | undefined
  await waitFor(async () => {
    found = (await readSession(logDir, sessionId)).find((e) => e.type === type)
    return found !== undefined
  }, withinMs)
  return found
}

/** Append an event to a host's log from the same process (seq-safe: shared mutex). */
async function appendToLog(
  logDir: string,
  sessionId: string,
  type: string,
  payload: unknown,
): Promise<string> {
  const id = crypto.randomUUID()
  await new EventLogWriter(logDir).append({
    id,
    type,
    schema_version: "0.1.0",
    project_id: PROJECT_ID,
    session_id: sessionId,
    actor_id: "local-writer",
    timestamp: new Date().toISOString(),
    causal_parent_ids: [],
    payload,
    payload_hash: canonicalHash(payload),
    versions: { schema_registry_version: "0.1.0" },
  })
  return id
}

/** The resolution as a promoted `approval.granted@1` payload — the log-path shape. */
function asGrantedPayload(resolution: ApprovalResolution): Record<string, unknown> {
  const { kind: _kind, ...rest } = resolution
  return rest
}

/** A minimal valid envelope, for the pure-projection assertions. */
function probeEvent(type: string, id: string, payload: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse({
    id,
    seq: 1,
    type,
    schema_version: "1",
    project_id: PROJECT_ID,
    session_id: "probe-projection",
    actor_id: "host:probe",
    timestamp: "2026-10-11T00:00:03.000Z",
    logical_clock: 1,
    causal_parent_ids: [],
    payload,
    payload_hash: canonicalHash(payload),
    versions: { schema_registry_version: "0.1.0" },
  })
}

function sampleAction(inputs: unknown): Action {
  return {
    id: "act-sample",
    intent: "push",
    tool: "mcp.deploy.push",
    inputs,
    contract: {
      required_level: 4,
      blast_radius: "external",
      reversibility: "irreversible",
      scope: { level: "project", identifier: PROJECT_ID },
      data_sensitivity: "private",
      preconditions: [],
    },
    phase: "pending_approval",
    audit: [{ phase: "proposed", by_actor_id: AGENT_ID, at: "2026-10-11T00:00:00.000Z" }],
    proposed_at: "2026-10-11T00:00:00.000Z",
    proposed_by: AGENT_ID,
  }
}

// ── A–D: the pure surfaces ───────────────────────────────────────────────────

function pureCases(): string | undefined {
  // A. Byte-identity.
  const legacyDoc = {
    request_id: "req-1",
    action_id: "act-1",
    kind: "granted" as const,
    approver_id: "alice",
    at: "2026-10-11T00:00:00.000Z",
  }
  const preAdrBytes =
    '{"action_id":"act-1","approver_id":"alice","at":"2026-10-11T00:00:00.000Z","kind":"granted","request_id":"req-1"}'
  const preAdrHash = new Bun.CryptoHasher("sha256").update(preAdrBytes).digest("hex")
  if (canonicalApprovalResolutionHash(legacyDoc) !== preAdrHash) {
    return "[A] a resolution with NO inputs_hash no longer has its pre-ADR canonical hash — every signature made before ADR-0042 would stop verifying."
  }
  // ...and a bound one is a DIFFERENT document, so the binding is inside the
  // signed bytes and cannot be stripped without breaking the signature.
  if (
    canonicalApprovalResolutionHash({ ...legacyDoc, inputs_hash: "e".repeat(64) }) === preAdrHash
  ) {
    return "[A] inputs_hash is not part of the signed resolution document — a bound resolution could be stripped to an unbound one without breaking its signature."
  }
  const legacyRequest = {
    request_id: "req-1",
    action_id: "act-1",
    reason: "held",
    required_authority: {},
    requested_at: "2026-10-11T00:00:00.000Z",
  }
  const parsedLegacy = ApprovalRequestSchema.parse(legacyRequest)
  if (JSON.stringify(parsedLegacy) !== JSON.stringify(legacyRequest)) {
    return "[A] a request written before ADR-0042 does not round-trip byte-identically."
  }

  // B. The kernel backstop.
  const kernel = new ActionKernel(
    async () => ({ approved: false, reason: "held", approver_id: "p" }),
    alwaysHoldsChecker,
    async () => {},
    { useStubsForTests: true },
  )
  const held = sampleAction({ branch: "release" })
  const bound: ApprovalOutcome = {
    kind: "granted",
    action_id: held.id,
    request_id: "req",
    approver_id: "alice",
    inputs_hash: benignHashFor(held, { branch: "docs" }),
  }
  let kernelThrew = false
  try {
    kernel.resolve(held, bound)
  } catch {
    kernelThrew = true
  }
  if (!kernelThrew) {
    return "[B] ActionKernel.resolve() applied an outcome bound to a DIFFERENT representation of the action."
  }
  const resolved = kernel.resolve(held, {
    ...bound,
    inputs_hash: actionRepresentationHash(held),
  })
  if (resolved.phase !== "approved") {
    return "[B] a correctly bound outcome did not resolve the action."
  }

  // C. The quorum backstop.
  const request: ApprovalRequest = {
    request_id: "req-q",
    action_id: held.id,
    reason: "held",
    required_authority: {},
    requested_at: new Date(Date.now() - 1000).toISOString(),
    quorum: 2,
    inputs_hash: actionRepresentationHash(held),
  }
  const shown = benignHashFor(held, { branch: "docs" })
  const votes = [vote(request, "alice", shown), vote(request, "bob", shown)].map((r, i) => ({
    resolution: {
      request_id: r.request_id,
      action_id: r.action_id,
      kind: r.kind,
      approver_id: r.approver_id,
      at: r.at,
      inputs_hash: shown,
    },
    signature: r.signature,
    event_id: `evt-${i}`,
  }))
  const evaluation = evaluateQuorum(request, votes, {
    authorizedKeys: roster().authorized_keys,
    approverAuthority: roster().approvers,
  })
  if (evaluation.satisfied || !evaluation.rejected.every((r) => r.code === "not_for_request")) {
    return `[C] evaluateQuorum counted votes bound to a different representation (satisfied=${evaluation.satisfied}, rejected=${evaluation.rejected.map((r) => r.code).join(",")}).`
  }

  // D. The approver-visible rendering.
  const RLO = String.fromCodePoint(0x202e)
  const stored = sampleAction({ remote: "origin", branch: `release${RLO}txt`, force: true })
  const storedRequest: ApprovalRequest = {
    request_id: "req-d",
    action_id: stored.id,
    reason: "held",
    required_authority: {},
    requested_at: "2026-10-11T00:00:00.000Z",
    action_type: stored.tool,
    inputs_hash: actionRepresentationHash(stored),
  }
  const honest = [
    probeEvent("action.proposed", "e1", { ...stored, phase: "proposed" }),
    probeEvent("action.pending_approval", "e2", stored),
    probeEvent("approval.requested", "e3", storedRequest),
  ]
  const shownRep = approvalRepresentation(honest, storedRequest)
  if (shownRep.status !== "verified" || shownRep.representation === undefined) {
    return `[D] an honest log did not verify (status '${shownRep.status}': ${shownRep.problems.join("; ")}).`
  }
  const rendered = renderCanonicalJson(shownRep.representation.inputs)
  if (rendered.includes(RLO) || !rendered.includes("\\u202e")) {
    return "[D] a bidi override in the inputs reached the rendering raw — the terminal would show the approver something other than the bytes."
  }
  const reparsed = JSON.parse(rendered) as unknown
  if (JSON.stringify(reparsed) !== JSON.stringify(canonicalJsonValue(stored.inputs))) {
    return "[D] the rendered inputs do not re-parse to the canonical stored inputs."
  }
  if (actionRepresentationHash({ ...stored, inputs: reparsed }) !== storedRequest.inputs_hash) {
    return "[D] the rendering does not re-hash to the request's inputs_hash — what the approver sees is not what the binding covers."
  }
  const planted = approvalRepresentation(
    [
      ...honest,
      probeEvent("action.proposed", "e4", { ...stored, inputs: { branch: "docs-typo" } }),
    ],
    storedRequest,
  )
  if (planted.status !== "mismatch") {
    return `[D] a planted action.proposed with benign inputs was not flagged (status '${planted.status}').`
  }
  const { action_type: _t, inputs_hash: _h, ...unboundCopy } = storedRequest
  const shadowed = approvalRepresentation(
    [...honest, probeEvent("approval.requested", "e5", unboundCopy)],
    storedRequest,
  )
  if (shadowed.status !== "mismatch") {
    return "[D] a planted UNBOUND copy of a bound request was not flagged — an attacker could downgrade the binding by shadowing the request."
  }
  return undefined
}

// ── E–G: guard.wrap() ────────────────────────────────────────────────────────

let executeCalls = 0
const callCount = (): number => executeCalls
let lastInputs: unknown

function registerGuardTool(): void {
  _resetToolsForTests()
  executeCalls = 0
  lastInputs = undefined
  registerTool({
    name: "probe.push",
    // `z.unknown()` keeps the caller's object by reference — the in-process shape
    // where code holding that reference can mutate the held action's inputs.
    inputs: z.object({ target: z.unknown() }),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async (inputs) => {
      executeCalls += 1
      lastInputs = JSON.parse(JSON.stringify(inputs))
      return { ran: true }
    },
  })
}

function guardPolicy(quorum?: number): Policy {
  return {
    id: "probe-representation-policy",
    version: "1",
    rules: [
      {
        match: { tool: "probe.push" },
        effect: "require_approval",
        reason: "irreversible push requires approval",
        approval: { required_authority: {}, ...(quorum !== undefined ? { quorum } : {}) },
      },
    ],
  }
}

function guardConfig(logDir: string, quorum?: number): GuardConfig {
  return {
    project_id: PROJECT_ID,
    actor_id: AGENT_ID,
    log_root: logDir,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    policy_gate: compile(guardPolicy(quorum), { decider_id: "probe", allow_unsigned: true }),
    precondition_checker: alwaysHoldsChecker,
  }
}

interface GuardOutcome {
  result: string
  error: string
  events: EventEnvelope[]
}

async function driveGuard(
  logDir: string,
  target: Record<string, unknown>,
  config: GuardConfig,
): Promise<GuardOutcome> {
  registerGuardTool()
  let error = ""
  const run = await runGuarded(async (ctx) => {
    try {
      await ctx.callTool("probe.push", { target }, { contract: { required_level: 4 } })
      return "ok"
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      return "threw"
    }
  }, config)
  return { result: run.result, error, events: await readSession(logDir, run.session_id) }
}

/** The held action, as the host logged it when it parked. */
function heldFrom(events: EventEnvelope[]): Action {
  const parked = events.find((e) => e.type === "action.pending_approval")
  if (parked === undefined) throw new Error("probe: no action.pending_approval in the log")
  return parked.payload as Action
}

async function guardCases(): Promise<string | undefined> {
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-guard-"))

  // E. A resolver outcome bound to a different representation is refused.
  {
    const config: GuardConfig = {
      ...guardConfig(logDir),
      approval_resolver: async (request) => {
        const auth = authorizeResolution(request, actorFor("alice"), "granted")
        if (!auth.authorized) throw new Error(auth.reason)
        // The approval UI showed alice a benign version of this push.
        const shown = actionRepresentationHash({
          id: request.action_id,
          tool: "probe.push",
          inputs: { target: { branch: "docs-typo" } },
          contract: {
            required_level: 4,
            blast_radius: "self",
            reversibility: "irreversible",
            scope: { level: "project", identifier: PROJECT_ID },
            data_sensitivity: "private",
            preconditions: [],
          },
          proposed_by: AGENT_ID,
        })
        return { ...auth.outcome, inputs_hash: shown }
      },
    }
    const e = await driveGuard(logDir, { branch: "main", force: true }, config)
    if (e.result !== "threw" || callCount() !== 0) {
      return `[E] guard.wrap() executed a grant bound to a DIFFERENT operation (loop '${e.result}', tool ran ${callCount()}x).`
    }
    if (!e.error.includes(REP_PREFIX)) {
      return `[E] the refusal did not name the representation mismatch. Got: ${e.error}`
    }
    if (
      countOf(e.events, "approval.granted") !== 0 ||
      countOf(e.events, "approval.expired") !== 1
    ) {
      return "[E] a refused binding must expire the request (approval.expired@1), never write approval.granted@1."
    }
  }
  // E control: the same resolver, bound to the operation actually held.
  {
    const config: GuardConfig = {
      ...guardConfig(logDir),
      approval_resolver: async (request) => {
        const auth = authorizeResolution(request, actorFor("alice"), "granted")
        if (!auth.authorized) throw new Error(auth.reason)
        return {
          ...auth.outcome,
          ...(request.inputs_hash ? { inputs_hash: request.inputs_hash } : {}),
        }
      },
    }
    const ok = await driveGuard(logDir, { branch: "main" }, config)
    if (ok.result !== "ok" || callCount() !== 1) {
      return `[E] the correctly bound control did not execute (loop '${ok.result}': ${ok.error}).`
    }
    const granted = ok.events.find((ev) => ev.type === "approval.granted")
    const expected = actionRepresentationHash(heldFrom(ok.events))
    if ((granted?.payload as { inputs_hash?: string } | undefined)?.inputs_hash !== expected) {
      return "[E] the promoted approval.granted@1 did not carry the binding its resolver supplied."
    }
  }

  // F. The held action's live inputs change while the resolver waits.
  {
    const target: Record<string, unknown> = { branch: "release" }
    const config: GuardConfig = {
      ...guardConfig(logDir),
      approval_resolver: async (request) => {
        // Concurrent code holding the caller's reference rewrites the operation
        // after the request — and anything the approver saw — was formed.
        target.branch = "main"
        target.force = true
        const auth = authorizeResolution(request, actorFor("alice"), "granted")
        if (!auth.authorized) throw new Error(auth.reason)
        return auth.outcome
      },
    }
    const f = await driveGuard(logDir, target, config)
    if (f.result !== "threw" || callCount() !== 0) {
      return `[F] guard.wrap() executed a held action whose inputs changed after the request was opened (tool ran ${callCount()}x with ${JSON.stringify(lastInputs)}).`
    }
    if (!f.error.includes("no longer describes")) {
      return `[F] the refusal did not say the request no longer describes the held action. Got: ${f.error}`
    }
  }

  // G. Quorum votes bound to a different operation are never promoted.
  {
    const config = (bindTo: (request: ApprovalRequest) => string): GuardConfig => ({
      ...guardConfig(logDir, 2),
      quorum: {
        ...roster(),
        collect: async (request) => [
          vote(request, "alice", bindTo(request)),
          vote(request, "bob", bindTo(request)),
        ],
      },
    })
    const g = await driveGuard(
      logDir,
      { branch: "main" },
      config((request) =>
        actionRepresentationHash({
          id: request.action_id,
          tool: "probe.push",
          inputs: { target: { branch: "docs-typo" } },
          contract: {
            required_level: 4,
            blast_radius: "self",
            reversibility: "irreversible",
            scope: { level: "project", identifier: PROJECT_ID },
            data_sensitivity: "private",
            preconditions: [],
          },
          proposed_by: AGENT_ID,
        }),
      ),
    )
    if (g.result !== "threw" || callCount() !== 0) {
      return `[G] two votes bound to a DIFFERENT operation reached quorum in guard.wrap() (tool ran ${callCount()}x).`
    }
    if (countOf(g.events, "approval.granted") !== 0) {
      return `[G] ${countOf(g.events, "approval.granted")} vote(s) bound to a different operation were PROMOTED — the log would say these approvers granted what they never saw.`
    }
    if (!g.error.includes("refused at promote")) {
      return `[G] the shortfall did not name the votes refused at promote. Got: ${g.error}`
    }
    const okRun = await driveGuard(
      logDir,
      { branch: "main" },
      config((request) => request.inputs_hash ?? ""),
    )
    if (okRun.result !== "ok" || callCount() !== 1) {
      return `[G] correctly bound quorum votes did not execute (loop '${okRun.result}': ${okRun.error}).`
    }
    // The promoted votes carry the binding and still verify — the quorum record's
    // evidence stays re-checkable.
    for (const ev of okRun.events.filter((x) => x.type === "approval.granted")) {
      const p = ev.payload as ApprovalResolution
      try {
        verifyApprovalSignature({ ...p, kind: "granted" }, p.signature, {
          authorizedKeys: roster().authorized_keys,
        })
      } catch {
        return "[G] a promoted bound vote no longer verifies from its own log payload — the binding was dropped on promotion."
      }
    }
    if (countOf(okRun.events, APPROVAL_QUORUM_REACHED_EVENT_TYPE) !== 1) {
      return "[G] the bound quorum did not emit its approval.quorum_reached@1."
    }
  }
  return undefined
}

// ── H–K: the MCP proxy ───────────────────────────────────────────────────────

const DOWNSTREAM = "deploy"
const PROXY_TOOL = `mcp.${DOWNSTREAM}.push`

class FakeDownstream extends DownstreamConnection {
  constructor(
    cfg: ProxyConfig["downstream_servers"][number],
    private readonly onCall: (args: Record<string, unknown>) => void,
  ) {
    super(cfg, { name: "probe-fake-client", version: "0.0.0" })
  }
  override async start(): Promise<void> {}
  override getTools(): readonly MCPTool[] {
    return [{ name: "push", description: "push", inputSchema: { type: "object", properties: {} } }]
  }
  override async callTool(_name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.onCall(args)
    return { content: [{ type: "text", text: "pushed" }], isError: false }
  }
  override async stop(): Promise<void> {}
}

class NoOpUpstream extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

function makeProxy(logDir: string, sessionId: string, timeoutMs: number, quorum?: number) {
  const received: Array<Record<string, unknown>> = []
  const config: ProxyConfig = {
    project_id: PROJECT_ID,
    actor_id: AGENT_ID,
    session_id: sessionId,
    log_root: logDir,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    approval_timeout_ms: timeoutMs,
    approvals: { authorized_keys: pinnedKeys(), allow_unsigned: false },
    downstream_servers: [{ name: DOWNSTREAM, command: "not-spawned", args: [] }],
    tool_defaults: {
      [PROXY_TOOL]: {
        reversibility: "irreversible",
        permissions: [],
        sandbox: "controlled-shell",
        required_trust_level: 4,
        blast_radius: "external",
      },
    },
  }
  const policy: Policy = {
    id: "probe-representation-proxy",
    version: "1",
    rules: [
      {
        match: { tool: PROXY_TOOL },
        effect: "require_approval",
        reason: "egress requires approval",
        approval: { required_authority: {}, ...(quorum !== undefined ? { quorum } : {}) },
      },
    ],
  }
  const proxy = new MCPProxy(config, {
    policyGate: compile(policy, { decider_id: "probe", allow_unsigned: true }),
    downstreamFactory: (cfg) =>
      cfg.downstream_servers.map((entry) => new FakeDownstream(entry, (a) => received.push(a))),
    upstreamFactory: (tools, handler) =>
      new NoOpUpstream(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  // Read through a function: after an early `received.length !== 0` return,
  // strict tsc narrows a direct `received.length` to the literal 0.
  return { proxy, received, calls: (): number => received.length }
}

function resetHost(): void {
  _resetToolsForTests()
  registry._resetForTests()
  _resetEventLogStateForTests()
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
}

async function proxyCases(): Promise<string | undefined> {
  // H. Single-approver channel path — refused, then the bound control executes
  //    with canonical inputs.
  {
    resetHost()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-proxy-h-"))
    const sessionId = "probe-representation-proxy-h"
    const { proxy, received, calls } = makeProxy(logDir, sessionId, 5000)
    await proxy.start()
    // Keys deliberately out of canonical order.
    const call = proxy.handleCallTool({
      name: PROXY_TOOL,
      arguments: { remote: "origin", branch: "main", force: true },
    })
    const requested = await waitForEvent(logDir, sessionId, "approval.requested", 3000)
    if (requested === undefined) return "[H] the proxy never opened an approval request."
    const request = requested.payload as ApprovalRequest
    const held = heldFrom(await readSession(logDir, sessionId))
    if (
      request.action_type !== PROXY_TOOL ||
      request.inputs_hash !== actionRepresentationHash(held)
    ) {
      return "[H] the proxy's approval request does not name the held operation (action_type / inputs_hash)."
    }

    // Alice was shown a benign version of this push and signed it.
    await writeApprovalResolution(
      logDir,
      PROJECT_ID,
      vote(request, "alice", benignHashFor(held, { remote: "origin", branch: "docs" })),
    )
    const refused = await waitFor(
      async () => representationRejections(await readSession(logDir, sessionId)).length > 0,
      3000,
    )
    if (!refused) {
      await proxy.stop()
      return "[H] the proxy did not audit a validly signed grant bound to a DIFFERENT operation."
    }
    const stillHeld = await readSession(logDir, sessionId)
    if (countOf(stillHeld, "approval.granted") !== 0 || received.length !== 0) {
      await proxy.stop()
      return "[H] the proxy PROMOTED or EXECUTED a grant bound to a different operation."
    }
    if (
      (await waitFor(
        async () =>
          (await readApprovalResolution(logDir, PROJECT_ID, request.request_id)) === undefined,
        2000,
      )) === false
    ) {
      await proxy.stop()
      return "[H] the refused resolution was not consumed from the single-slot channel."
    }

    // The bound control, inside the same hold.
    await writeApprovalResolution(
      logDir,
      PROJECT_ID,
      vote(request, "bob", actionRepresentationHash(held)),
    )
    const result = await call
    await proxy.stop()
    if (result.isError === true || calls() !== 1) {
      return `[H] a correctly bound grant did not execute the held call (isError=${String(result.isError)}, downstream calls=${calls()}).`
    }
    const keys = Object.keys(received[0] ?? {})
    if (keys.join(",") !== "branch,force,remote") {
      return `[H] the downstream tool received inputs in key order '${keys.join(",")}' — the proxy must execute the CANONICAL form, so what runs is byte-for-byte what was hashed.`
    }
    const granted = (await readSession(logDir, sessionId)).find(
      (e) => e.type === "approval.granted",
    )
    if (
      (granted?.payload as { inputs_hash?: string } | undefined)?.inputs_hash !==
      actionRepresentationHash(held)
    ) {
      return "[H] the promoted approval.granted@1 dropped the binding — it would no longer verify from the log."
    }
  }

  // I. Single-approver LOG path.
  {
    resetHost()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-proxy-i-"))
    const sessionId = "probe-representation-proxy-i"
    const { proxy, received } = makeProxy(logDir, sessionId, 1500)
    await proxy.start()
    const call = proxy.handleCallTool({ name: PROXY_TOOL, arguments: { branch: "main" } })
    const requested = await waitForEvent(logDir, sessionId, "approval.requested", 3000)
    if (requested === undefined) return "[I] the proxy never opened an approval request."
    const request = requested.payload as ApprovalRequest
    const held = heldFrom(await readSession(logDir, sessionId))
    const planted = await appendToLog(
      logDir,
      sessionId,
      "approval.granted",
      asGrantedPayload(vote(request, "alice", benignHashFor(held, { branch: "docs" }))),
    )
    // A host that skipped its own check would hit the ActionKernel backstop and
    // throw out of the hold. Report that as THIS host's failure, not a crash.
    let result: Awaited<typeof call>
    try {
      result = await call
    } catch (err) {
      await proxy.stop()
      return `[I] the proxy did not refuse a log-path grant bound to a different operation at promote — it reached ActionKernel.resolve() and threw: ${err instanceof Error ? err.message : String(err)}`
    }
    await proxy.stop()
    const events = await readSession(logDir, sessionId)
    const audit = representationRejections(events).find((p) => p.rejected_event_id === planted)
    if (audit === undefined) {
      return "[I] the proxy did not audit a log-path grant bound to a different operation with its event id."
    }
    if (received.length !== 0 || result.isError !== true) {
      return "[I] the proxy executed a log-path grant bound to a different operation."
    }
    const midHold = events.filter(
      (e) => e.type !== "approval.expired" && e.type !== "action.rejected",
    )
    if (pendingApprovals(midHold).length !== 1) {
      return "[I] the read-side queue treated the refused log grant as a resolution."
    }
  }

  // J. The held action's live inputs change during the hold.
  {
    resetHost()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-proxy-j-"))
    const sessionId = "probe-representation-proxy-j"
    const { proxy, received } = makeProxy(logDir, sessionId, 1500)
    await proxy.start()
    const target: Record<string, unknown> = { branch: "release" }
    const call = proxy.handleCallTool({ name: PROXY_TOOL, arguments: { target } })
    const requested = await waitForEvent(logDir, sessionId, "approval.requested", 3000)
    if (requested === undefined) return "[J] the proxy never opened an approval request."
    const request = requested.payload as ApprovalRequest
    target.branch = "main"
    // An UNBOUND (legacy) grant: only the request-level check can stop this one.
    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "alice"))
    const result = await call
    await proxy.stop()
    if (received.length !== 0 || result.isError !== true) {
      return `[J] the proxy executed a held action whose inputs changed during the hold (downstream received ${JSON.stringify(received)}).`
    }
    const audit = representationRejections(await readSession(logDir, sessionId))
    if (!audit.some((p) => p.reason.includes("no longer describes"))) {
      return "[J] the refusal was not audited as the request no longer describing the held action."
    }
  }

  // K. Quorum: mismatched channel vote never promoted, mismatched log vote audited.
  {
    resetHost()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-proxy-k-"))
    const sessionId = "probe-representation-proxy-k"
    const { proxy, received } = makeProxy(logDir, sessionId, 6000, 2)
    await proxy.start()
    const call = proxy.handleCallTool({
      name: PROXY_TOOL,
      arguments: { remote: "origin", branch: "main" },
    })
    const requested = await waitForEvent(logDir, sessionId, "approval.requested", 3000)
    if (requested === undefined) return "[K] the proxy never opened an approval request."
    const request = requested.payload as ApprovalRequest
    const held = heldFrom(await readSession(logDir, sessionId))
    const shown = benignHashFor(held, { branch: "docs" })

    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "alice", shown))
    if (
      !(await waitFor(
        async () => representationRejections(await readSession(logDir, sessionId)).length > 0,
        3000,
      ))
    ) {
      await proxy.stop()
      return "[K] a quorum channel vote bound to a different operation was not refused."
    }
    const plantedLogVote = await appendToLog(
      logDir,
      sessionId,
      "approval.granted",
      asGrantedPayload(vote(request, "carol", shown)),
    )
    if (
      !(await waitFor(
        async () =>
          representationRejections(await readSession(logDir, sessionId)).some(
            (p) => p.rejected_event_id === plantedLogVote,
          ),
        3000,
      ))
    ) {
      await proxy.stop()
      return "[K] a quorum LOG vote bound to a different operation was not audited by the proxy."
    }
    const promotedSoFar = (await readSession(logDir, sessionId)).filter(
      (e) => e.type === "approval.granted" && e.id !== plantedLogVote,
    )
    if (promotedSoFar.length !== 0) {
      await proxy.stop()
      return "[K] the proxy PROMOTED a quorum vote bound to a different operation."
    }
    for (const approver of ["alice", "bob"]) {
      await writeApprovalResolution(
        logDir,
        PROJECT_ID,
        vote(request, approver, actionRepresentationHash(held)),
      )
      await waitFor(
        async () =>
          (await readSession(logDir, sessionId)).some(
            (e) =>
              e.type === "approval.granted" &&
              (e.payload as { approver_id?: string }).approver_id === approver &&
              e.id !== plantedLogVote,
          ),
        3000,
      )
    }
    const result = await call
    await proxy.stop()
    if (result.isError === true || received.length !== 1) {
      return `[K] correctly bound quorum votes did not execute the held call (downstream calls=${received.length}).`
    }
    if (Object.keys(received[0] ?? {}).join(",") !== "branch,remote") {
      return "[K] the quorum path executed the held call with non-canonical inputs — what runs must be what was hashed."
    }
  }

  // K2. A BOUND deny on the quorum path is promoted with its binding and vetoes:
  //     drop the binding on promotion and the re-read vote no longer verifies, so
  //     the veto is lost and the hold just waits out its deadline.
  {
    resetHost()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-proxy-k2-"))
    const sessionId = "probe-representation-proxy-k2"
    const { proxy, received } = makeProxy(logDir, sessionId, 4000, 2)
    await proxy.start()
    const started = Date.now()
    const call = proxy.handleCallTool({ name: PROXY_TOOL, arguments: { branch: "main" } })
    const requested = await waitForEvent(logDir, sessionId, "approval.requested", 3000)
    if (requested === undefined) return "[K2] the proxy never opened an approval request."
    const request = requested.payload as ApprovalRequest
    const held = heldFrom(await readSession(logDir, sessionId))
    await writeApprovalResolution(
      logDir,
      PROJECT_ID,
      vote(request, "alice", actionRepresentationHash(held), "denied"),
    )
    const result = await call
    await proxy.stop()
    const kind = (result._meta as { _lodestar?: { kind?: unknown } } | undefined)?._lodestar?.kind
    if (received.length !== 0 || kind !== "approval_denied" || Date.now() - started >= 3500) {
      return `[K2] a bound quorum deny did not veto promptly (kind '${String(kind)}') — its binding was not carried onto the promoted approval.denied@1, so the re-read vote no longer verified.`
    }
    const denied = (await readSession(logDir, sessionId)).find((e) => e.type === "approval.denied")
    if (
      (denied?.payload as { inputs_hash?: string } | undefined)?.inputs_hash !==
      actionRepresentationHash(held)
    ) {
      return "[K2] the promoted approval.denied@1 dropped the binding."
    }
  }
  return undefined
}

// ── L–O: the runtime gate ────────────────────────────────────────────────────

type RpcMessage = Record<string, unknown> & { type?: string; id?: number }

class GateHook {
  private idCounter = 0
  private readonly pending = new Map<number, (msg: RpcMessage) => void>()
  private readyResolve?: () => void
  readonly bodyArgs: unknown[] = []
  /** Read through a method so strict tsc does not narrow `bodyArgs.length` to a literal. */
  runs(): number {
    return this.bodyArgs.length
  }

  constructor(private readonly channel: ReturnType<typeof createLoopbackPair>["hook"]) {
    channel.onMessage((raw) => {
      const msg = raw as RpcMessage
      if (msg.type === "ready") {
        this.readyResolve?.()
        return
      }
      if (msg.type === "run_tool") {
        this.bodyArgs.push(msg.args)
        this.channel.send({ type: "tool_result", id: msg.id, output: { ran: true }, documents: [] })
        return
      }
      if (typeof msg.id === "number") {
        const resolve = this.pending.get(msg.id)
        if (resolve) {
          this.pending.delete(msg.id)
          resolve(msg)
        }
      }
    })
  }

  waitReady(): Promise<void> {
    return new Promise((resolve) => {
      this.readyResolve = resolve
    })
  }

  private request(partial: Record<string, unknown>): Promise<RpcMessage> {
    const id = ++this.idCounter
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.channel.send({ ...partial, id })
    })
  }

  register(name: string): Promise<RpcMessage> {
    return this.request({ type: "register_tool", name })
  }
  govern(tool: string, args: Record<string, unknown>): Promise<RpcMessage> {
    return this.request({ type: "govern", tool, args })
  }
  resume(actionId: string, requestId: string, waitMs: number): Promise<RpcMessage> {
    return this.request({
      type: "resume",
      action_id: actionId,
      request_id: requestId,
      wait_ms: waitMs,
    })
  }
}

const GATE_TOOL = "deploy"

async function buildGate(sessionId: string, logDir: string, quorum?: number) {
  resetHost()
  const config = RuntimeGateConfigSchema.parse({
    project_id: PROJECT_ID,
    actor_id: AGENT_ID,
    session_id: sessionId,
    log_root: logDir,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    approval_timeout_ms: 8000,
    tool_defaults: {
      [`runtime.${GATE_TOOL}`]: {
        required_trust_level: 4,
        reversibility: "irreversible",
        sandbox: "read",
        permissions: [],
        blast_radius: "external",
      },
    },
    approvals: { authorized_keys: pinnedKeys(), allow_unsigned: false },
  })
  const policy: Policy = {
    id: "probe-representation-gate",
    version: "1",
    rules: [
      {
        match: {},
        effect: "require_approval",
        reason: "egress requires approval",
        approval: { required_authority: {}, ...(quorum !== undefined ? { quorum } : {}) },
      },
    ],
  }
  const gate = new RuntimeGate(config, {
    policyGate: compile(policy, { decider_id: "probe", allow_unsigned: true }),
  })
  await gate.init()
  const pair = createLoopbackPair()
  const hook = new GateHook(pair.hook)
  void gate.serve(pair.gate)
  await hook.waitReady()
  await hook.register(GATE_TOOL)
  return { gate, hook }
}

async function gateHold(
  hook: GateHook,
  args: Record<string, unknown>,
  logDir: string,
  sessionId: string,
): Promise<{ actionId: string; requestId: string; request: ApprovalRequest; held: Action }> {
  const heldMsg = await hook.govern(GATE_TOOL, args)
  if (heldMsg.phase !== "pending_approval") {
    throw new Error(`probe: the gate did not hold the call (phase '${String(heldMsg.phase)}')`)
  }
  const events = await readSession(logDir, sessionId)
  const request = events.find((e) => e.type === "approval.requested")?.payload as ApprovalRequest
  return {
    actionId: String(heldMsg.action_id),
    requestId: String(heldMsg.request_id),
    request,
    held: heldFrom(events),
  }
}

async function gateCases(): Promise<string | undefined> {
  // L. Single-approver channel + log paths, then an UNBOUND legacy grant resolves.
  {
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-gate-l-"))
    const sessionId = "probe-representation-gate-l"
    const { gate, hook } = await buildGate(sessionId, logDir)
    const { actionId, requestId, request, held } = await gateHold(
      hook,
      { remote: "origin", branch: "main" },
      logDir,
      sessionId,
    )
    if (
      request.inputs_hash !== actionRepresentationHash(held) ||
      request.action_type !== held.tool
    ) {
      await gate.stop()
      return "[L] the runtime gate's approval request does not name the held operation."
    }
    const shown = benignHashFor(held, { remote: "origin", branch: "docs" })

    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "alice", shown))
    const afterChannel = await hook.resume(actionId, requestId, 0)
    if (afterChannel.phase !== "pending_approval" || hook.bodyArgs.length !== 0) {
      await gate.stop()
      return `[L] the gate acted on a CHANNEL grant bound to a different operation (phase '${String(afterChannel.phase)}').`
    }
    if (representationRejections(await readSession(logDir, sessionId)).length !== 1) {
      await gate.stop()
      return "[L] the gate did not audit the mismatched channel grant."
    }

    const plantedLog = await appendToLog(
      logDir,
      sessionId,
      "approval.granted",
      asGrantedPayload(vote(request, "bob", shown)),
    )
    const afterLog = await hook.resume(actionId, requestId, 0)
    if (afterLog.phase !== "pending_approval" || hook.bodyArgs.length !== 0) {
      await gate.stop()
      return `[L] the gate acted on a LOG grant bound to a different operation (phase '${String(afterLog.phase)}').`
    }
    if (
      !representationRejections(await readSession(logDir, sessionId)).some(
        (p) => p.rejected_event_id === plantedLog,
      )
    ) {
      await gate.stop()
      return "[L] the gate did not audit the mismatched log grant with its event id."
    }

    // An UNBOUND legacy grant still resolves a bound request (verify-if-present).
    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "carol"))
    const done = await hook.resume(actionId, requestId, 600)
    await gate.stop()
    if (done.phase !== "completed" || hook.runs() !== 1) {
      return `[L] an unbound legacy grant did not resolve the bound request (phase '${String(done.phase)}') — binding is verify-if-present.`
    }
    const keys = Object.keys((hook.bodyArgs[0] ?? {}) as Record<string, unknown>)
    if (keys.join(",") !== "branch,remote") {
      return `[L] the remoted body received inputs in key order '${keys.join(",")}' — the gate must execute the CANONICAL form.`
    }
  }

  // M. Restart over a planted action.pending_approval (same id, other inputs).
  {
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-gate-m-"))
    const sessionId = "probe-representation-gate-m"
    const first = await buildGate(sessionId, logDir)
    const { actionId, requestId, request, held } = await gateHold(
      first.hook,
      { branch: "docs" },
      logDir,
      sessionId,
    )
    await first.gate.stop()
    // A local writer appends a record of the SAME action with different inputs.
    await appendToLog(logDir, sessionId, "action.pending_approval", {
      ...held,
      inputs: { branch: "main", force: true },
    })
    const second = await buildGate(sessionId, logDir)
    // Bound to the request — and to the operation the approver actually saw.
    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "alice", request.inputs_hash))
    const resumed = await second.hook.resume(actionId, requestId, 600)
    await second.gate.stop()
    if (second.hook.bodyArgs.length !== 0) {
      return `[M] after a restart the gate EXECUTED a held action over a planted record (body received ${JSON.stringify(second.hook.bodyArgs[0])}).`
    }
    if (resumed.phase !== "rejected" || !String(resumed.reason ?? "").includes("planted")) {
      return `[M] a conflicting planted action.pending_approval did not fail the resume closed (phase '${String(resumed.phase)}', reason '${String(resumed.reason)}').`
    }
  }

  // N. Restart over a planted approval.requested that strips the quorum.
  {
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-gate-n-"))
    const sessionId = "probe-representation-gate-n"
    const first = await buildGate(sessionId, logDir, 2)
    const { actionId, requestId, request } = await gateHold(
      first.hook,
      { branch: "main" },
      logDir,
      sessionId,
    )
    await first.gate.stop()
    const { quorum: _q, ...stripped } = request
    await appendToLog(logDir, sessionId, "approval.requested", stripped)
    const second = await buildGate(sessionId, logDir, 2)
    // ONE authentic, correctly bound vote. Under the stripped request this would
    // be a single-approver grant.
    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "alice", request.inputs_hash))
    const resumed = await second.hook.resume(actionId, requestId, 600)
    await second.gate.stop()
    if (resumed.phase === "completed" || second.hook.bodyArgs.length !== 0) {
      return "[N] ONE vote executed a QUORUM hold after a planted approval.requested stripped its quorum — the request terms were read latest-wins."
    }
    if (resumed.phase !== "rejected") {
      return `[N] a conflicting planted approval.requested did not fail the resume closed (phase '${String(resumed.phase)}').`
    }
  }

  // O. Quorum sites in the gate.
  {
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-representation-gate-o-"))
    const sessionId = "probe-representation-gate-o"
    const { gate, hook } = await buildGate(sessionId, logDir, 2)
    const { actionId, requestId, request, held } = await gateHold(
      hook,
      { remote: "origin", branch: "main" },
      logDir,
      sessionId,
    )
    const shown = benignHashFor(held, { remote: "origin", branch: "docs" })
    await writeApprovalResolution(logDir, PROJECT_ID, vote(request, "alice", shown))
    await hook.resume(actionId, requestId, 0)
    const plantedLog = await appendToLog(
      logDir,
      sessionId,
      "approval.granted",
      asGrantedPayload(vote(request, "bob", shown)),
    )
    await hook.resume(actionId, requestId, 0)
    const events = await readSession(logDir, sessionId)
    const promoted = events.filter((e) => e.type === "approval.granted" && e.id !== plantedLog)
    if (promoted.length !== 0) {
      await gate.stop()
      return "[O] the gate PROMOTED a quorum channel vote bound to a different operation."
    }
    if (!representationRejections(events).some((p) => p.rejected_event_id === plantedLog)) {
      await gate.stop()
      return "[O] the gate did not audit a quorum LOG vote bound to a different operation."
    }
    let last: RpcMessage = {}
    for (const approver of ["alice", "carol"]) {
      await writeApprovalResolution(
        logDir,
        PROJECT_ID,
        vote(request, approver, actionRepresentationHash(held)),
      )
      last = await hook.resume(actionId, requestId, 600)
    }
    await gate.stop()
    if (last.phase !== "completed" || hook.runs() !== 1) {
      return `[O] correctly bound quorum votes did not complete the action (phase '${String(last.phase)}').`
    }
    if (
      Object.keys((hook.bodyArgs[0] ?? {}) as Record<string, unknown>).join(",") !== "branch,remote"
    ) {
      return "[O] the gate's quorum path executed non-canonical inputs — what runs must be what was hashed."
    }
  }
  return undefined
}

async function run(): Promise<ProbeResult> {
  resetHost()
  const pure = pureCases()
  if (pure !== undefined) return { passed: false, details: pure }
  const guard = await guardCases()
  if (guard !== undefined) return { passed: false, details: guard }
  const proxy = await proxyCases()
  if (proxy !== undefined) return { passed: false, details: proxy }
  const gate = await gateCases()
  if (gate !== undefined) return { passed: false, details: gate }
  return {
    passed: true,
    details:
      "An approval binds the operation it authorizes, and every host refuses anything else at promote. Pure: a resolution with no inputs_hash keeps its exact pre-ADR canonical hash and a legacy request round-trips byte-identically; ActionKernel.resolve() and evaluateQuorum each refuse an outcome / vote bound to a different representation; the approver-visible rendering re-parses to the canonical stored inputs and re-hashes to the request's inputs_hash, escapes a bidi override, and flags a planted action.proposed and a planted UNBOUND copy of the request as MISMATCH. guard.wrap(): a resolver outcome bound to a different operation expired the request with the tool never run while the bound control ran and recorded its binding; a held action mutated while the resolver waited was refused; quorum votes bound to a different operation were never promoted while bound votes reached quorum and still verified from their own log payloads. MCP proxy: a validly signed channel grant naming a different operation was audited, consumed and never promoted, then a bound grant executed the call with the CANONICAL inputs; a planted log grant was audited by event id and left the read-side queue pending; a mid-hold input mutation was refused; quorum channel and log votes bound to a different operation were refused and bound votes executed. Runtime gate: mismatched channel and log grants were refused and audited, an UNBOUND legacy grant still resolved the bound request with the body receiving canonical inputs; after a restart a planted action.pending_approval and a planted quorum-stripping approval.requested each failed the resume CLOSED instead of being read latest-wins; and mismatched quorum channel and log votes were refused while bound votes completed the action.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: approved_action_cannot_be_substituted")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
