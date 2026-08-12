#!/usr/bin/env bun
/**
 * Probe: quorum_requires_distinct_eligible_approvers
 *
 * M-of-N quorum approvals (ADR-0041, #175). The invariant this pins is the one
 * the whole design exists for:
 *
 *   THE CLIENT ACCUMULATES; THE KERNEL ADJUDICATES.
 *
 * The value of customer-held approver keys is that no intermediary can
 * manufacture authorization. If a coordinating client — a hosted control plane,
 * a desktop app, a CI collector — gathers N signatures and hands the kernel one
 * synthesized grant, the log records a *single-approver* decision and "quorum"
 * degrades into an unverifiable claim by that intermediary. So the threshold is
 * decided by the kernel, over each approver's own independently-signed
 * resolution, and never attested by anything else.
 *
 * The load-bearing separation: `approval.granted@1` stays **one approver's
 * vote**; `approval.quorum_reached@1` is the **authorization** that drives
 * `ActionKernel.resolve()`. At the single-approver threshold the two coincide,
 * which is why that path emits no quorum event and must stay byte-identical.
 *
 * Adjudication checks TWO ORTHOGONAL THINGS, and conflating them silently
 * weakens every quorum:
 *   - authenticity — did an operator-pinned key sign this exact resolution?
 *   - eligibility  — does this approver satisfy the request's
 *                    `required_authority`?
 * Signatures alone answer only the first, and the signed resolution deliberately
 * carries no authority (self-attested authority is not authority), so a
 * keys-only adjudicator would let *any* N pinned approvers satisfy a
 * `secret`-clearance quorum. Cases F–H are that boundary.
 *
 * Assertions — the ADR's required set, driven through a REAL `guard.wrap()`
 * session with a REAL compiled `quorum: 3` policy and REAL Ed25519 signatures:
 *
 *   A. THREE eligible grants satisfy it: the held L4 action un-parks, the tool
 *      runs exactly once, and the log carries three `approval.granted@1` (one
 *      per vote) plus one `approval.quorum_reached@1` naming all three.
 *   B. A COLLECTOR-SYNTHESIZED single grant cannot satisfy `quorum: 3` — the
 *      headline. One grant is one vote, never three.
 *   C. M-1 valid grants do not un-park. An accumulated 2-of-3 is not an
 *      approval; the hold expires as a soft denial and the tool never runs.
 *   D. A duplicate `actor_id` counts ONCE — three grant events, two approvers.
 *   E. A deny after M-1 grants rejects, regardless of grants collected.
 *   F. A revoked key's outstanding vote stops counting (the verify-time roster:
 *      no request-time snapshot, so revocation takes effect immediately).
 *   G. An authentically-signed grant from a PINNED approver who does NOT clear
 *      `required_authority` does not count.
 *   H. An approver with NO supplied authority record does not count (fail
 *      closed — a host with no authority source cannot satisfy a quorum).
 *   I. The action's own PROPOSER cannot count toward its own quorum.
 *   J. `quorum` absent is byte-identical to today: the single-approver resolver
 *      path runs unchanged and emits NO `approval.quorum_reached@1`.
 *   O. A promoted deny from a pinned but INELIGIBLE approver leaves the hold
 *      VISIBLE in the read-side queue. The host promotes an authentic vote before
 *      it knows the vote is eligible, and only an eligible deny vetoes — so if the
 *      projection treated any deny as terminal, a low-privilege pinned approver
 *      could make a live hold vanish from the queue and doom it single-handedly.
 *   P. A collector's mis-bound vote is never promoted: a validly-signed
 *      resolution for a DIFFERENT request must not be written into this session's
 *      log, where it would look like that other request's resolution.
 *
 * And through the REAL MCP proxy, over the REAL signed `.approvals/` file
 * side-channel — the accumulating hold loop, which is where the transport
 * question actually bites:
 *
 *   K. Three votes cast one at a time (the channel is single-slot per request)
 *      are each promoted to their own `approval.granted@1` and accumulate in the
 *      LOG until the third satisfies the threshold; the downstream tool then
 *      runs exactly once.
 *   L. A PARTIALLY satisfied request that hits its deadline is a SOFT DENIAL,
 *      not an approval — 2-of-3 at the deadline times out with the tool never
 *      run. This is the case a naive "we already have most of them" reading
 *      would get wrong.
 *   M. The documented `quorumRoster` override IS the effective trust root: a host
 *      that pins its keys only there reaches quorum. Config pins an unrelated
 *      approver, so verifying against config instead of the roster would reject
 *      every real vote before adjudication and look like nobody voted.
 *
 * And through the REAL runtime gate over the REAL NDJSON-RPC loopback — the third
 * host, whose hold accumulates across `resume` calls rather than in one poll loop:
 *
 *   N. Votes accumulate across resumes until the threshold is met and the remoted
 *      tool body runs exactly once; and the same `quorumRoster` override is the
 *      trust root there too.
 *   Q. A quorum hold whose durable `approval.requested@1` cannot be recovered
 *      FAILS CLOSED rather than resuming down the single-approver path, where one
 *      signed grant would un-park an action the policy held for three approvers.
 *   R. Once a quorum is reached, a promoted deny that never vetoed does not
 *      relabel a later downstream rejection as a human refusal on replay.
 *   S. A roster that could never satisfy the declared threshold is refused at
 *      CONSTRUCTION — `quorum: 3` with two fully-configured approvers is a
 *      deterministic misconfiguration, not a hold that stalls to a timeout.
 *   T. An unusable vote (post-deadline / mis-bound) is CONSUMED from the
 *      single-slot channel rather than left to block every later approver.
 *
 * Why this matters: quorum is the control an operator reaches for when one
 * approver is not enough — an irreversible payment, a production deploy, a key
 * rotation. Every failure mode here degrades it back to single-approver
 * authorization while still *looking* like quorum in the log. A silent downgrade
 * is worse than no feature.
 */

import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import {
  APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  type ApprovalQuorumReachedPayload,
  type EventEnvelope,
  EventEnvelopeSchema,
  type Policy,
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
  type ApprovalResolver,
  type ApproverAuthorityConfig,
  type GuardConfig,
  type QuorumRoster,
  alwaysHoldsChecker,
  authorizeResolution,
  compile,
  generateApproverKeyPair,
  runGuarded,
  signApprovalResolution,
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
import { pendingApprovals } from "@qmilab/lodestar-trace"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.quorum@1"
const PROJECT_ID = "probe-quorum"
const LOG_ROOT = "/tmp/lodestar-probe-quorum-log"
const AGENT_ID = "probe-agent"

// ── The approver roster ──────────────────────────────────────────────────────
// Four humans plus the agent. `intern` is pinned and can sign perfectly valid
// resolutions but holds only `public` clearance, so it fails the rule's
// `secret` requirement (case G). `stranger` is pinned with NO authority record
// at all (case H). The agent signs as the action's proposer (case I).

const APPROVER_IDS = ["alice", "bob", "carol", "dave", "intern", "stranger", AGENT_ID] as const

const keypairs = new Map<string, { publicKeyPem: string; privateKeyPem: string }>()
for (const id of APPROVER_IDS) keypairs.set(id, generateApproverKeyPair())

function publicKeyOf(id: string): string {
  const kp = keypairs.get(id)
  if (kp === undefined) throw new Error(`probe: no keypair for '${id}'`)
  return kp.publicKeyPem
}

function privateKeyOf(id: string): string {
  const kp = keypairs.get(id)
  if (kp === undefined) throw new Error(`probe: no keypair for '${id}'`)
  return kp.privateKeyPem
}

const SECRET_AUTHORITY: ApproverAuthorityConfig = {
  trust_baseline: 1,
  sensitivity_clearance: "secret",
  authority_scope: [{ level: "global", identifier: "*" }],
}

/** Authority records the operator declares. `stranger` deliberately has none. */
const AUTHORITY: ReadonlyMap<string, ApproverAuthorityConfig> = new Map([
  ["alice", SECRET_AUTHORITY],
  ["bob", SECRET_AUTHORITY],
  ["carol", SECRET_AUTHORITY],
  ["dave", SECRET_AUTHORITY],
  [AGENT_ID, SECRET_AUTHORITY],
  // `intern` is pinned and authentic, but cannot clear the rule's `secret`.
  ["intern", { ...SECRET_AUTHORITY, sensitivity_clearance: "public" }],
])

function actorFor(id: string): Actor {
  const authority = AUTHORITY.get(id)
  if (authority === undefined) throw new Error(`probe: no authority for '${id}'`)
  return {
    id,
    kind: "human",
    display_name: id,
    authority_scope: authority.authority_scope,
    trust_baseline: authority.trust_baseline,
    sensitivity_clearance: authority.sensitivity_clearance,
    created_at: "2026-08-12T00:00:00.000Z",
  }
}

/**
 * Build the roster a host holds. `pinned` is the authenticity half; `eligible`
 * is the orthogonal eligibility half. They are supplied separately here so a
 * case can revoke a key (F) without touching authority, or withhold an authority
 * record (H) without un-pinning the key.
 */
function roster(pinned: readonly string[], eligible: readonly string[]): QuorumRoster {
  return {
    authorized_keys: new Map(pinned.map((id) => [id, publicKeyOf(id)])),
    approvers: new Map(eligible.map((id) => [id, actorFor(id)])),
  }
}

const EVERY_APPROVER = ["alice", "bob", "carol", "dave", "intern", "stranger", AGENT_ID]
const EVERY_ELIGIBLE = ["alice", "bob", "carol", "dave", "intern", AGENT_ID]

// ── Signing ──────────────────────────────────────────────────────────────────

let voteClock = 0

/**
 * One approver's OWN signed resolution — never a synthesized verdict. Each vote
 * is an independent document (`{ request_id, action_id, kind, approver_id, at }`)
 * signed by that approver's private key, which is what makes it independently
 * attributable and re-verifiable.
 */
function castVote(
  request: { request_id: string; action_id: string },
  approverId: string,
  kind: "granted" | "denied" = "granted",
): ApprovalResolution {
  voteClock += 1
  const doc = {
    request_id: request.request_id,
    action_id: request.action_id,
    kind,
    approver_id: approverId,
    at: new Date(Date.now() + voteClock).toISOString(),
  } as const
  return { ...doc, signature: signApprovalResolution(doc, privateKeyOf(approverId)) }
}

// ── The governed tool + policy ───────────────────────────────────────────────

let executeCalls = 0
/** Read through a function so comparisons see `number`, not the literal type. */
const callCount = (): number => executeCalls

function registerProbeTool(): void {
  _resetToolsForTests()
  executeCalls = 0
  registerTool({
    name: "probe.deploy",
    inputs: z.object({}),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async () => {
      executeCalls += 1
      return { ran: true }
    },
  })
}

/** A `require_approval` rule demanding THREE distinct `secret`-cleared approvers. */
const QUORUM_POLICY: Policy = {
  id: "probe-quorum-policy",
  version: "1",
  rules: [
    {
      match: { tool: "probe.deploy" },
      effect: "require_approval",
      reason: "irreversible deploy requires three approvers",
      approval: { required_authority: { sensitivity_clearance: "secret" }, quorum: 3 },
    },
  ],
}

/** The same rule with NO quorum — the untouched single-approver path (case J). */
const SINGLE_APPROVER_POLICY: Policy = {
  id: "probe-single-policy",
  version: "1",
  rules: [
    {
      match: { tool: "probe.deploy" },
      effect: "require_approval",
      reason: "irreversible deploy requires approval",
      approval: { required_authority: { sensitivity_clearance: "secret" } },
    },
  ],
}

function baseConfig(policy: Policy): Omit<GuardConfig, "quorum" | "approval_resolver"> {
  return {
    project_id: PROJECT_ID,
    actor_id: AGENT_ID,
    log_root: LOG_ROOT,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    policy_gate: compile(policy, { decider_id: "probe-policy", allow_unsigned: true }),
    precondition_checker: alwaysHoldsChecker,
  }
}

async function sessionEvents(sessionId: string): Promise<EventEnvelope[]> {
  return new EventLogReader(LOG_ROOT).readSession(PROJECT_ID, sessionId)
}

interface CaseOutcome {
  /** `"ok"` when the guarded call succeeded, `"threw"` when it was refused. */
  result: string
  calls: number
  types: string[]
  error: string
  sessionId: string
  quorumRecord?: ApprovalQuorumReachedPayload
}

/**
 * Drive one `guard.wrap()` session whose held action is resolved by `collect`.
 * The collector returns the approvers' OWN signed resolutions — the type is a
 * `QuorumCollector`, not an `ApprovalResolver`, precisely because it must not be
 * able to hand back a single synthesized verdict.
 */
async function driveQuorum(
  collect: (request: { request_id: string; action_id: string }) => ApprovalResolution[],
  rosterFor: QuorumRoster = roster(EVERY_APPROVER, EVERY_ELIGIBLE),
): Promise<CaseOutcome> {
  registerProbeTool()
  let error = ""
  const run = await runGuarded(
    async (ctx) => {
      try {
        await ctx.callTool("probe.deploy", {}, { contract: { required_level: 4 } })
        return "ok"
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        return "threw"
      }
    },
    { ...baseConfig(QUORUM_POLICY), quorum: { ...rosterFor, collect: async (r) => collect(r) } },
  )
  const events = await sessionEvents(run.session_id)
  const record = events.find((e) => e.type === APPROVAL_QUORUM_REACHED_EVENT_TYPE)
  return {
    result: run.result,
    calls: callCount(),
    types: events.map((e) => e.type),
    error,
    sessionId: run.session_id,
    ...(record !== undefined
      ? { quorumRecord: record.payload as ApprovalQuorumReachedPayload }
      : {}),
  }
}

function countOf(types: string[], type: string): number {
  return types.filter((t) => t === type).length
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
    timestamp: "2026-08-12T00:00:03.000Z",
    logical_clock: 1,
    causal_parent_ids: [],
    payload,
    payload_hash: canonicalHash(payload),
    versions: { schema_registry_version: "0.1.0" },
  })
}

/** Assert an unsatisfied quorum: refused, tool never ran, no authorization event. */
function assertNotAuthorized(label: string, outcome: CaseOutcome): string | undefined {
  if (outcome.result !== "threw") {
    return `[${label}] the held action was NOT refused (guarded loop returned '${outcome.result}') — an unsatisfied quorum must never un-park it.`
  }
  if (outcome.calls !== 0) {
    return `[${label}] the tool ran ${outcome.calls}x under an unsatisfied quorum; expected 0.`
  }
  if (outcome.types.includes(APPROVAL_QUORUM_REACHED_EVENT_TYPE)) {
    return `[${label}] an '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}' event was emitted for an unsatisfied quorum — that record IS the authorization and must never be written speculatively.`
  }
  return undefined
}

// ── Cases A–J: guard.wrap() ──────────────────────────────────────────────────

async function guardCases(): Promise<string | undefined> {
  // A. Three eligible grants satisfy it.
  const a = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(r, "bob"),
    castVote(r, "carol"),
  ])
  if (a.result !== "ok") {
    return `[A] three valid distinct eligible grants did not satisfy quorum 3; loop returned '${a.result}' (${a.error}).`
  }
  if (a.calls !== 1) {
    return `[A] the tool ran ${a.calls}x after quorum was reached; expected exactly 1.`
  }
  if (countOf(a.types, "approval.granted") !== 3) {
    return `[A] expected 3 'approval.granted@1' events (one per VOTE); got ${countOf(a.types, "approval.granted")}. Each approver's vote is its own record.`
  }
  if (countOf(a.types, APPROVAL_QUORUM_REACHED_EVENT_TYPE) !== 1) {
    return `[A] expected exactly 1 '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}' (the authorization); got ${countOf(a.types, APPROVAL_QUORUM_REACHED_EVENT_TYPE)}.`
  }
  const record = a.quorumRecord
  if (record === undefined) return "[A] the quorum record payload was missing."
  if (record.quorum !== 3 || record.approvals.length < 3) {
    return `[A] the quorum record claims quorum ${record.quorum} with ${record.approvals.length} approvals; expected 3 of each.`
  }
  const named = record.approvals.map((x) => x.approver_id).sort()
  if (named.join(",") !== "alice,bob,carol") {
    return `[A] the quorum record names [${named.join(", ")}]; expected alice, bob, carol.`
  }
  for (const ref of record.approvals) {
    // The record must NAME ITS EVIDENCE, not merely assert a count: a reader
    // holding their own pinned keys re-fetches each grant and re-verifies it.
    if (!ref.payload_hash || !ref.granted_event_id) {
      return `[A] the quorum record's vote for '${ref.approver_id}' is missing its evidence pointers (payload_hash / granted_event_id) — the claim would be unverifiable.`
    }
    if (!a.types.includes("approval.granted")) {
      return "[A] the quorum record cites grants that are not in the log."
    }
  }
  if (a.types.indexOf(APPROVAL_QUORUM_REACHED_EVENT_TYPE) > a.types.indexOf("action.approved")) {
    return "[A] the action was approved BEFORE its quorum record landed — the log must never show an approved action whose authorization is not yet written."
  }

  // B. THE HEADLINE — a collector-synthesized single grant cannot satisfy 3.
  const b = await driveQuorum((r) => [castVote(r, "alice")])
  const bFail = assertNotAuthorized("B", b)
  if (bFail) return bFail
  if (!/1 of 3/.test(b.error)) {
    return `[B] the refusal did not say how short the quorum was. Got: ${b.error}`
  }

  // C. M-1 valid grants do not un-park.
  const c = await driveQuorum((r) => [castVote(r, "alice"), castVote(r, "bob")])
  const cFail = assertNotAuthorized("C", c)
  if (cFail) return cFail

  // D. A duplicate actor_id counts once.
  const d = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(r, "alice"),
    castVote(r, "bob"),
  ])
  const dFail = assertNotAuthorized("D", d)
  if (dFail) return dFail
  if (!/2 of 3/.test(d.error)) {
    return `[D] two distinct approvers (alice twice + bob) should count as 2 of 3. Got: ${d.error}`
  }

  // E. A deny after M-1 grants rejects, regardless of grants collected.
  const e = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(r, "bob"),
    castVote(r, "carol", "denied"),
  ])
  const eFail = assertNotAuthorized("E", e)
  if (eFail) return eFail
  if (!e.types.includes("approval.denied")) {
    return `[E] a valid deny did not produce an 'approval.denied@1'. Got: ${e.types.join(", ")}`
  }
  if (!/denied/.test(e.error)) {
    return `[E] the refusal did not name the deny as decisive. Got: ${e.error}`
  }

  // F. A revoked key's outstanding vote stops counting (verify-time roster).
  //    Carol signs a perfectly valid resolution, then her key is un-pinned
  //    before adjudication — exactly the mid-collection revocation case. There
  //    is no request-time snapshot to shelter it behind.
  const f = await driveQuorum(
    (r) => [castVote(r, "alice"), castVote(r, "bob"), castVote(r, "carol")],
    roster(
      EVERY_APPROVER.filter((id) => id !== "carol"),
      EVERY_ELIGIBLE,
    ),
  )
  const fFail = assertNotAuthorized("F", f)
  if (fFail) return fFail
  if (countOf(f.types, "approval.granted") !== 2) {
    return `[F] a revoked signer's vote was still promoted to the log (${countOf(f.types, "approval.granted")} grants); an unpinned signature must not become an 'approval.granted@1' claiming that approver granted.`
  }

  // G. An authentic grant from a PINNED but INELIGIBLE approver does not count.
  //    `intern` holds only `public` clearance against a `secret` rule.
  const g = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(r, "bob"),
    castVote(r, "intern"),
  ])
  const gFail = assertNotAuthorized("G", g)
  if (gFail) return gFail
  if (!/intern \(shortfall\)/.test(g.error)) {
    return `[G] the refusal did not name the ineligible approver and WHY they did not count. Got: ${g.error}`
  }
  if (countOf(g.types, "approval.granted") !== 3) {
    return `[G] expected the intern's vote to still be PROMOTED (it is authentic, and a real vote belongs in the log) but not COUNTED; got ${countOf(g.types, "approval.granted")} grants. Authenticity gates the log write; eligibility gates the count.`
  }

  // H. An approver with NO supplied authority record does not count.
  const h = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(r, "bob"),
    castVote(r, "stranger"),
  ])
  const hFail = assertNotAuthorized("H", h)
  if (hFail) return hFail
  if (!/stranger/.test(h.error)) {
    return `[H] the refusal did not name the approver with no authority record. Got: ${h.error}`
  }

  // I. The action's own proposer cannot count toward its own quorum.
  const i = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(r, "bob"),
    castVote(r, AGENT_ID),
  ])
  const iFail = assertNotAuthorized("I", i)
  if (iFail) return iFail
  if (!/propos/.test(i.error)) {
    return `[I] the refusal did not name the proposer exclusion. Got: ${i.error}`
  }

  // J. `quorum` absent is byte-identical to today: the single-approver resolver
  //    path, unchanged, and NO quorum event.
  registerProbeTool()
  const singleResolver: ApprovalResolver = async (request) => {
    const auth = authorizeResolution(request, actorFor("alice"), "granted", { reason: "ok" })
    if (!auth.authorized) throw new Error(`probe approver refused: ${auth.reason}`)
    return auth.outcome
  }
  const j = await runGuarded(
    async (ctx) => {
      await ctx.callTool("probe.deploy", {}, { contract: { required_level: 4 } })
      return "ok"
    },
    { ...baseConfig(SINGLE_APPROVER_POLICY), approval_resolver: singleResolver },
  )
  if (j.result !== "ok" || callCount() !== 1) {
    return `[J] the single-approver path regressed: loop returned '${j.result}', tool ran ${callCount()}x (expected 'ok' / 1).`
  }
  const jTypes = (await sessionEvents(j.session_id)).map((e) => e.type)
  if (countOf(jTypes, "approval.granted") !== 1) {
    return `[J] expected exactly 1 'approval.granted@1' on the single-approver path; got ${countOf(jTypes, "approval.granted")}.`
  }
  if (jTypes.includes(APPROVAL_QUORUM_REACHED_EVENT_TYPE)) {
    return `[J] a request with NO quorum emitted '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}' — at the single-approver threshold the grant IS the authorization and no such event may appear.`
  }

  // O. An INELIGIBLE deny must not make the hold disappear from the read side.
  //    This is a property of the pure projection, so it is checked over the exact
  //    event stream a host writes MID-COLLECTION — one grant plus a promoted deny
  //    from a pinned-but-ineligible approver, with no terminal yet. The host
  //    promoted that deny because it is authentic (authenticity gates the log
  //    write) and is still waiting because it is not eligible (eligibility gates
  //    the count). A projection that read any deny as terminal would hide a live
  //    hold from the queue — a denial of service any low-privilege pinned approver
  //    could trigger by denying once.
  const openRequest = {
    request_id: "q-open",
    action_id: "act-open",
    reason: "needs three",
    required_authority: { sensitivity_clearance: "secret" },
    requested_at: "2026-08-12T00:00:00.000Z",
    quorum: 3,
  }
  const midCollection = [
    probeEvent("approval.requested", "e-req", openRequest),
    probeEvent("approval.granted", "e-grant", {
      request_id: "q-open",
      action_id: "act-open",
      approver_id: "alice",
      at: "2026-08-12T00:00:01.000Z",
    }),
    probeEvent("approval.denied", "e-deny", {
      request_id: "q-open",
      action_id: "act-open",
      approver_id: "intern",
      at: "2026-08-12T00:00:02.000Z",
    }),
  ]
  const openQueue = pendingApprovals(midCollection)
  if (openQueue.length !== 1) {
    return `[O] the read-side queue showed ${openQueue.length} pending holds; a still-open quorum must stay VISIBLE after an ineligible approver's promoted deny. A promoted vote is not a verdict.`
  }
  if (openQueue[0]?.quorum !== 3 || openQueue[0]?.approvers_so_far?.join(",") !== "alice") {
    return "[O] the pending item lost its quorum target or its advisory progress."
  }
  // ...and the host's own terminal DOES close it, so a genuinely vetoed hold does
  // not linger in the queue forever. That signal is host-authored; a vote is not.
  const vetoed = pendingApprovals([
    ...midCollection,
    probeEvent("action.rejected", "e-rejected", { id: "act-open", phase: "rejected" }),
  ])
  if (vetoed.length !== 0) {
    return "[O] the host's action.rejected did not close the vetoed hold — a settled quorum must not linger in the queue."
  }

  // P. A collector's MIS-BOUND vote is never promoted. It is validly signed, just
  //    for another hold; writing it would plant a terminal-looking resolution for
  //    a request this session never adjudicated.
  const foreign = { request_id: "other-request", action_id: "other-action" }
  const p = await driveQuorum((r) => [
    castVote(r, "alice"),
    castVote(foreign, "bob"),
    castVote(foreign, "carol"),
  ])
  const pFail = assertNotAuthorized("P", p)
  if (pFail) return pFail
  if (countOf(p.types, "approval.granted") !== 1) {
    return `[P] ${countOf(p.types, "approval.granted")} grants were promoted; expected only the 1 bound to this request. A validly-signed vote for ANOTHER request must not be written into this log.`
  }
  const pEvents = await sessionEvents(p.sessionId)
  const strayForOther = pEvents.some(
    (e) =>
      e.type === "approval.granted" &&
      (e.payload as { request_id?: unknown }).request_id === foreign.request_id,
  )
  if (strayForOther) {
    return "[P] a grant for a DIFFERENT request was written into this session's log — the read side would treat that request as resolved though nothing adjudicated it."
  }
  return undefined
}

// ── Cases K–L: the MCP proxy's accumulating hold loop ────────────────────────

const DOWNSTREAM_NAME = "deploy"
const PROXY_TOOL = `mcp.${DOWNSTREAM_NAME}.push`

class FakeDownstream extends DownstreamConnection {
  constructor(
    cfg: ProxyConfig["downstream_servers"][number],
    private readonly onCall: () => Promise<CallToolResult>,
  ) {
    super(cfg, { name: "probe-fake-client", version: "0.0.0" })
  }
  override async start(): Promise<void> {}
  override getTools(): readonly MCPTool[] {
    return [{ name: "push", description: "push", inputSchema: { type: "object", properties: {} } }]
  }
  override async callTool(): Promise<CallToolResult> {
    return this.onCall()
  }
  override async stop(): Promise<void> {}
}

class NoOpUpstream extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function proxyAuthorizedKeys(): Array<{
  actor_id: string
  public_key: string
  authority?: ApproverAuthorityConfig
}> {
  return EVERY_APPROVER.map((id) => {
    const authority = AUTHORITY.get(id)
    return {
      actor_id: id,
      public_key: publicKeyOf(id),
      ...(authority !== undefined ? { authority } : {}),
    }
  })
}

function makeProxy(
  logDir: string,
  sessionId: string,
  approvalTimeoutMs: number,
  /**
   * Case M: pin the quorum roster through `MCPProxyOverrides.quorumRoster`
   * instead of config. When set, `authorized_keys` deliberately carries a
   * DIFFERENT approver, so a host that verified votes against config rather than
   * the injected roster would reject every valid vote.
   */
  injectedRoster?: QuorumRoster,
) {
  let calls = 0
  const config: ProxyConfig = {
    project_id: PROJECT_ID,
    actor_id: AGENT_ID,
    session_id: sessionId,
    log_root: logDir,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    approval_timeout_ms: approvalTimeoutMs,
    approvals: {
      // With an injected roster, config pins only an unrelated approver — enough
      // to satisfy the "a waiting proxy must pin a key" guard, and nothing more.
      authorized_keys:
        injectedRoster === undefined
          ? proxyAuthorizedKeys()
          : [{ actor_id: "dave", public_key: publicKeyOf("dave") }],
      allow_unsigned: false,
    },
    downstream_servers: [{ name: DOWNSTREAM_NAME, command: "not-spawned", args: [] }],
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
  const proxyPolicy: Policy = {
    ...QUORUM_POLICY,
    rules: [{ ...QUORUM_POLICY.rules[0], match: { tool: PROXY_TOOL } } as Policy["rules"][number]],
  }
  const proxy = new MCPProxy(config, {
    policyGate: compile(proxyPolicy, { decider_id: "probe-policy", allow_unsigned: true }),
    ...(injectedRoster !== undefined ? { quorumRoster: injectedRoster } : {}),
    downstreamFactory: (cfg) =>
      cfg.downstream_servers.map(
        (entry) =>
          new FakeDownstream(entry, async () => {
            calls += 1
            return { content: [{ type: "text", text: "deployed" }], isError: false }
          }),
      ),
    upstreamFactory: (tools, handler) =>
      new NoOpUpstream(tools, handler, { name: "probe", version: "0.0.0" }),
  })
  return { proxy, calls: () => calls }
}

/** Poll `check` until it is true or `withinMs` elapses. */
async function waitFor(check: () => Promise<boolean>, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await delay(20)
  }
  return false
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
    const found = events.find((e) => e.type === "approval.requested")
    if (found) return found.payload as { request_id: string; action_id: string }
    await delay(20)
  }
  return undefined
}

/** Poll until at least `n` grants have been promoted, or `withinMs` elapses. */
async function waitForGrants(
  logDir: string,
  sessionId: string,
  n: number,
  withinMs: number,
): Promise<boolean> {
  const reader = new EventLogReader(logDir)
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    const events = await reader.readSession(PROJECT_ID, sessionId)
    if (events.filter((e) => e.type === "approval.granted").length >= n) return true
    await delay(20)
  }
  return false
}

/**
 * S. A roster that could never satisfy the declared threshold is a DETERMINISTIC
 *    misconfiguration, not a runtime condition — `quorum: 3` with two fully
 *    configured approvers can never be met by any sequence of votes. Unchecked it
 *    presents as every governed L4 call stalling to an approval timeout with
 *    nothing explaining why. Both out-of-process hosts refuse to construct.
 */
function undersizedRosterCase(): string | undefined {
  const logDir = "/tmp/lodestar-probe-quorum-undersized"
  let threw = ""
  try {
    makeProxy(logDir, "probe-quorum-undersized", 4000, {
      // Two fully-configured approvers against the policy's quorum of 3.
      authorized_keys: new Map(["alice", "bob"].map((id) => [id, publicKeyOf(id)])),
      approvers: new Map(["alice", "bob"].map((id) => [id, actorFor(id)])),
    })
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  if (threw === "") {
    return "[S] a roster of 2 was accepted for a policy declaring quorum 3 — no sequence of votes could satisfy it, so every hold would stall to an approval timeout with nothing explaining why."
  }
  if (!/quorum 3/.test(threw) || !/only 2/.test(threw)) {
    return `[S] the refusal did not name the threshold and the actual capacity. Got: ${threw}`
  }
  // A key with no authority record does not add capacity: it can cast a
  // promotable vote that never counts. Three keys, two authorities, still short.
  let partialThrew = ""
  try {
    makeProxy(logDir, "probe-quorum-undersized-2", 4000, {
      authorized_keys: new Map(["alice", "bob", "carol"].map((id) => [id, publicKeyOf(id)])),
      approvers: new Map(["alice", "bob"].map((id) => [id, actorFor(id)])),
    })
  } catch (err) {
    partialThrew = err instanceof Error ? err.message : String(err)
  }
  if (partialThrew === "") {
    return "[S] a third PINNED KEY with no authority record was counted toward capacity — such an approver can cast a promotable vote but it can never be eligible."
  }
  return undefined
}

async function proxyCases(): Promise<string | undefined> {
  // K. Three votes cast ONE AT A TIME accumulate in the LOG until the third
  //    satisfies the threshold. The `.approvals/` channel is single-slot per
  //    request — it returns at most one resolution per poll — so this is the
  //    shape that proves accumulation does not need a transport change.
  {
    _resetToolsForTests()
    registry._resetForTests()
    _resetEventLogStateForTests()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-proxy-ok-"))
    const sessionId = "probe-quorum-proxy-ok"
    const { proxy, calls } = makeProxy(logDir, sessionId, 6000)
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: PROXY_TOOL, arguments: {} })
    const request = await waitForRequest(logDir, sessionId, 3000)
    if (request === undefined) return "[K] approval.requested never appeared in the proxy log."

    let cast = 0
    for (const approver of ["alice", "bob", "carol"]) {
      await writeApprovalResolution(logDir, PROJECT_ID, castVote(request, approver))
      cast += 1
      if (!(await waitForGrants(logDir, sessionId, cast, 3000))) {
        return `[K] vote ${cast} ('${approver}') was never promoted to an approval.granted@1 — the accumulating loop must promote each vote so it can be cited by the quorum record.`
      }
    }

    const result = await callPromise
    await proxy.stop()
    const types = (await new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)).map(
      (e) => e.type,
    )
    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[K] three accumulated eligible votes did not authorize the call (kind '${String(kind)}').`
    }
    if (calls() !== 1) {
      return `[K] downstream tool ran ${calls()}x after quorum; expected exactly 1.`
    }
    if (countOf(types, "approval.granted") !== 3) {
      return `[K] expected 3 promoted votes in the log; got ${countOf(types, "approval.granted")}.`
    }
    if (countOf(types, APPROVAL_QUORUM_REACHED_EVENT_TYPE) !== 1) {
      return `[K] expected exactly 1 '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}'; got ${countOf(types, APPROVAL_QUORUM_REACHED_EVENT_TYPE)}.`
    }
  }

  // T. An UNUSABLE vote in the single-slot channel must be CONSUMED, not left to
  //    block it. A resolution dated after the deadline (approver clock skew) can
  //    never become valid; because `lodestar approve` now refuses to clobber a
  //    queued peer vote, leaving it in place would stop every later approver and
  //    time the quorum out. The three genuine votes that follow must still land.
  {
    _resetToolsForTests()
    registry._resetForTests()
    _resetEventLogStateForTests()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-proxy-stale-"))
    const sessionId = "probe-quorum-proxy-stale"
    const { proxy, calls } = makeProxy(logDir, sessionId, 8000)
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: PROXY_TOOL, arguments: {} })
    const request = await waitForRequest(logDir, sessionId, 3000)
    if (request === undefined) return "[T] approval.requested never appeared in the proxy log."

    // A vote whose decision time is far past the hold's deadline.
    const skewed = castVote(request, "dave")
    await writeApprovalResolution(logDir, PROJECT_ID, {
      ...skewed,
      at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    // Wait for the proxy to see and clear the slot.
    const cleared = await waitFor(
      async () =>
        (await readApprovalResolution(logDir, PROJECT_ID, request.request_id)) === undefined,
      3000,
    )
    if (!cleared) {
      return "[T] an unusable (post-deadline) vote was left in the single-slot channel — every later approver would be refused and the quorum would time out."
    }

    let cast = 0
    for (const approver of ["alice", "bob", "carol"]) {
      await writeApprovalResolution(logDir, PROJECT_ID, castVote(request, approver))
      cast += 1
      if (!(await waitForGrants(logDir, sessionId, cast, 3000))) {
        return `[T] vote ${cast} ('${approver}') was not promoted after the stale vote was cleared.`
      }
    }
    const result = await callPromise
    await proxy.stop()
    if (result.isError === true) {
      return "[T] the quorum did not complete after an unusable vote was cleared from the channel."
    }
    if (calls() !== 1) return `[T] downstream tool ran ${calls()}x; expected exactly 1.`
  }

  // L. A PARTIALLY satisfied request that hits its deadline is a SOFT DENIAL.
  //    An accumulated 2-of-3 is not "nearly approved" — it is not approved.
  {
    _resetToolsForTests()
    registry._resetForTests()
    _resetEventLogStateForTests()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-proxy-partial-"))
    const sessionId = "probe-quorum-proxy-partial"
    const { proxy, calls } = makeProxy(logDir, sessionId, 1500)
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: PROXY_TOOL, arguments: {} })
    const request = await waitForRequest(logDir, sessionId, 1000)
    if (request === undefined) return "[L] approval.requested never appeared in the proxy log."

    let cast = 0
    for (const approver of ["alice", "bob"]) {
      await writeApprovalResolution(logDir, PROJECT_ID, castVote(request, approver))
      cast += 1
      await waitForGrants(logDir, sessionId, cast, 1000)
    }

    const result = await callPromise
    await proxy.stop()
    const types = (await new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)).map(
      (e) => e.type,
    )
    if (result.isError !== true) {
      return "[L] a partially satisfied quorum that hit its deadline was treated as an APPROVAL — 2 of 3 is not 3 of 3."
    }
    const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
    if (kind !== "approval_timeout") {
      return `[L] expected the partial quorum to time out as a soft denial ('approval_timeout'); got '${String(kind)}'.`
    }
    if (calls() !== 0) {
      return `[L] the downstream tool ran ${calls()}x under a partial quorum; expected 0.`
    }
    if (types.includes(APPROVAL_QUORUM_REACHED_EVENT_TYPE)) {
      return `[L] a '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}' was emitted for a partial quorum.`
    }
    if (!types.includes("approval.expired")) {
      return `[L] the partial quorum did not reach the 'approval.expired@1' terminal. Got: ${types.join(", ")}`
    }
  }

  // M. The documented `quorumRoster` OVERRIDE is the effective trust root. A host
  //    that pins its keys only through the override must be able to reach quorum
  //    — so signature verification on the accumulating path has to read the
  //    ROSTER, not `config.approvals.authorized_keys`. Config here pins only
  //    `dave`, who casts no vote; if verification consulted config the three real
  //    votes would every one be rejected before `evaluateQuorum` ever saw them,
  //    and the hold would time out looking like nobody voted.
  {
    _resetToolsForTests()
    registry._resetForTests()
    _resetEventLogStateForTests()
    const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-proxy-roster-"))
    const sessionId = "probe-quorum-proxy-roster"
    const { proxy, calls } = makeProxy(
      logDir,
      sessionId,
      6000,
      roster(EVERY_APPROVER, EVERY_ELIGIBLE),
    )
    await proxy.start()
    const callPromise = proxy.handleCallTool({ name: PROXY_TOOL, arguments: {} })
    const request = await waitForRequest(logDir, sessionId, 3000)
    if (request === undefined) return "[M] approval.requested never appeared in the proxy log."

    let cast = 0
    for (const approver of ["alice", "bob", "carol"]) {
      await writeApprovalResolution(logDir, PROJECT_ID, castVote(request, approver))
      cast += 1
      if (!(await waitForGrants(logDir, sessionId, cast, 3000))) {
        return `[M] vote ${cast} ('${approver}') was never promoted — the injected quorumRoster is not being used as the verification trust root, so a host that pins keys only there cannot satisfy a quorum.`
      }
    }

    const result = await callPromise
    await proxy.stop()
    const types = (await new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)).map(
      (e) => e.type,
    )
    if (result.isError === true) {
      const kind = (result._meta as { _lodestar?: { kind?: unknown } })?._lodestar?.kind
      return `[M] three eligible votes verified against the INJECTED roster did not authorize the call (kind '${String(kind)}').`
    }
    if (calls() !== 1) {
      return `[M] downstream tool ran ${calls()}x; expected exactly 1.`
    }
    if (countOf(types, APPROVAL_QUORUM_REACHED_EVENT_TYPE) !== 1) {
      return `[M] expected exactly 1 '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}'; got ${countOf(types, APPROVAL_QUORUM_REACHED_EVENT_TYPE)}.`
    }
  }

  return undefined
}

// ── Case N: the runtime gate accumulates across resumes ─────────────────────

type RpcMessage = Record<string, unknown> & { type?: string; id?: number }

/** A minimal in-process hook speaking the real NDJSON-RPC protocol. */
class GateHook {
  private idCounter = 0
  private readonly pending = new Map<number, (msg: RpcMessage) => void>()
  private readyResolve?: () => void
  /** Every remoted tool-body run the gate asked for. */
  readonly bodyRuns: string[] = []

  constructor(private readonly channel: ReturnType<typeof createLoopbackPair>["hook"]) {
    channel.onMessage((raw) => {
      const msg = raw as RpcMessage
      if (msg.type === "ready") {
        this.readyResolve?.()
        return
      }
      if (msg.type === "run_tool") {
        this.bodyRuns.push(String(msg.tool))
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
  govern(tool: string): Promise<RpcMessage> {
    return this.request({ type: "govern", tool, args: {} })
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

async function buildGate(
  sessionId: string,
  logDir: string,
  toolName: string,
  /**
   * Case Q pins the REAL voters in config too. Without that, the single-approver
   * fallback would reject their grants on the key roster anyway and the case
   * would pass for the wrong reason — it must fail because the gate REFUSES to
   * downgrade, not because a key happened not to match.
   */
  pinVotersInConfig = false,
) {
  _resetToolsForTests()
  registry._resetForTests()
  _resetEventLogStateForTests()
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
      [`runtime.${toolName}`]: {
        required_trust_level: 4,
        reversibility: "irreversible",
        sandbox: "read",
        permissions: [],
        blast_radius: "external",
      },
    },
    // As in case M, config pins only an unrelated approver: the injected roster
    // below must be what votes are verified against.
    approvals: {
      authorized_keys: pinVotersInConfig
        ? proxyAuthorizedKeys()
        : [{ actor_id: "dave", public_key: publicKeyOf("dave") }],
      allow_unsigned: false,
    },
  })
  const runtimePolicy: Policy = {
    ...QUORUM_POLICY,
    rules: [{ ...QUORUM_POLICY.rules[0], match: {} } as Policy["rules"][number]],
  }
  const gate = new RuntimeGate(config, {
    policyGate: compile(runtimePolicy, { decider_id: "probe-policy", allow_unsigned: true }),
    quorumRoster: roster(EVERY_APPROVER, EVERY_ELIGIBLE),
  })
  await gate.init()
  const pair = createLoopbackPair()
  const hook = new GateHook(pair.hook)
  void gate.serve(pair.gate)
  await hook.waitReady()
  await hook.register(toolName)
  return { gate, hook }
}

async function runtimeGateCase(): Promise<string | undefined> {
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-runtime-"))
  const sessionId = "probe-quorum-runtime"
  const toolName = "deploy"
  const { gate, hook } = await buildGate(sessionId, logDir, toolName)

  const held = await hook.govern(toolName)
  if (held.phase !== "pending_approval") {
    return `[N] the L4 call was not held (phase '${String(held.phase)}').`
  }
  const actionId = String(held.action_id)
  const requestId = String(held.request_id)

  let last: RpcMessage = held
  for (const approver of ["alice", "bob", "carol"]) {
    await writeApprovalResolution(
      logDir,
      PROJECT_ID,
      castVote({ request_id: requestId, action_id: actionId }, approver),
    )
    last = await hook.resume(actionId, requestId, 600)
    // Only the vote that completes the threshold may un-park the action.
    if (approver !== "carol" && last.phase !== "pending_approval") {
      return `[N] the hold left 'pending_approval' after only some of the votes (phase '${String(last.phase)}') — an accumulated M-1 is not an approval.`
    }
  }
  await gate.stop()

  if (last.phase !== "completed") {
    return `[N] three eligible votes accumulated across resumes did not complete the action (phase '${String(last.phase)}'). Votes were verified against the INJECTED quorumRoster, so a host that pins keys only there must be able to reach quorum.`
  }
  if (hook.bodyRuns.length !== 1) {
    return `[N] the remoted tool body ran ${hook.bodyRuns.length}x; expected exactly 1.`
  }
  const types = (await new EventLogReader(logDir).readSession(PROJECT_ID, sessionId)).map(
    (e) => e.type,
  )
  if (countOf(types, "approval.granted") !== 3) {
    return `[N] expected 3 promoted votes in the durable log; got ${countOf(types, "approval.granted")}.`
  }
  if (countOf(types, APPROVAL_QUORUM_REACHED_EVENT_TYPE) !== 1) {
    return `[N] expected exactly 1 '${APPROVAL_QUORUM_REACHED_EVENT_TYPE}'; got ${countOf(types, APPROVAL_QUORUM_REACHED_EVENT_TYPE)}.`
  }
  return undefined
}

/**
 * Q. A quorum hold whose durable `approval.requested@1` cannot be recovered must
 *    NOT resume down the single-approver path. That path keys on the
 *    HOOK-SUPPLIED `request_id`, so one valid signed grant would un-park an action
 *    the policy required three approvers for — the silent downgrade every other
 *    quorum surface refuses. Simulated by resuming a fresh gate against a log
 *    whose request record never landed.
 */
async function runtimeGateUnrecoveredRequestCase(): Promise<string | undefined> {
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-unrecovered-"))
  const sessionId = "probe-quorum-unrecovered"
  const toolName = "deploy"
  const { gate, hook } = await buildGate(sessionId, logDir, toolName, true)

  const held = await hook.govern(toolName)
  if (held.phase !== "pending_approval") {
    return `[Q] the L4 call was not held (phase '${String(held.phase)}').`
  }
  const actionId = String(held.action_id)
  const requestId = String(held.request_id)

  // Strip the durable request record: the state a torn write, a truncated log, or
  // a payload that fails strict parse leaves behind.
  await stripApprovalRequested(logDir, sessionId)

  // One valid signed grant. Under the single-approver fallback this alone would
  // un-park the action and run the tool.
  await writeApprovalResolution(
    logDir,
    PROJECT_ID,
    castVote({ request_id: requestId, action_id: actionId }, "alice"),
  )
  const resumed = await hook.resume(actionId, requestId, 600)
  await gate.stop()

  if (resumed.phase === "completed") {
    return "[Q] a single signed grant resumed a QUORUM hold into execution because the durable request could not be recovered — that is the silent downgrade the whole design refuses."
  }
  if (hook.bodyRuns.length !== 0) {
    return `[Q] the remoted tool body ran ${hook.bodyRuns.length}x on an unrecoverable quorum hold; expected 0.`
  }
  if (resumed.phase !== "rejected") {
    return `[Q] expected the unrecoverable quorum hold to fail closed as 'rejected'; got '${String(resumed.phase)}'.`
  }
  if (!/quorum/.test(String(resumed.reason ?? ""))) {
    return `[Q] the refusal did not explain that a quorum hold could not be resumed. Got: ${String(resumed.reason)}`
  }
  return undefined
}

/**
 * R. Replay classification: a promoted deny that never vetoed must not relabel a
 *    DOWNSTREAM failure as a human refusal. Hosts promote an *authentic* vote
 *    before knowing it is *eligible*, so a quorum log can hold an
 *    `approval.denied` from an approver who never had the standing to veto. If
 *    the quorum then succeeds and execution is rejected later (a revalidated
 *    precondition), an exactly-once replay that keyed on that deny would tell the
 *    hook "a human denied this" and send it re-planning around a refusal that
 *    never happened.
 */
async function runtimeGateReplayClassificationCase(): Promise<string | undefined> {
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-quorum-replay-"))
  const sessionId = "probe-quorum-replay"
  const { gate, hook } = await buildGate(sessionId, logDir, "deploy", true)
  const actionId = "act-replay"
  const requestId = "req-replay"

  // The log a satisfied quorum leaves when execution is rejected AFTERWARDS: an
  // ineligible approver's promoted vote, the authorization, then the terminal.
  const writer = new EventLogWriter(logDir)
  const seed = async (type: string, payload: unknown): Promise<void> => {
    await writer.append({
      id: `${type}-${actionId}`,
      type,
      schema_version: "1",
      project_id: PROJECT_ID,
      session_id: sessionId,
      actor_id: "host:probe",
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
  }
  await seed("approval.denied", {
    request_id: requestId,
    action_id: actionId,
    approver_id: "intern",
    at: new Date().toISOString(),
  })
  await seed("approval.quorum_reached", {
    request_id: requestId,
    action_id: actionId,
    quorum: 3,
    approvals: ["alice", "bob", "carol"].map((id) => ({
      approver_id: id,
      at: new Date().toISOString(),
      payload_hash: `h-${id}`,
      granted_event_id: `e-${id}`,
    })),
    at: new Date().toISOString(),
  })
  await seed("action.rejected", {
    id: actionId,
    phase: "rejected",
    audit: [
      {
        phase: "rejected",
        by_actor_id: "system",
        at: new Date().toISOString(),
        detail: "precondition 'branch is clean' no longer holds",
      },
    ],
  })

  const replayed = await hook.resume(actionId, requestId, 0)
  await gate.stop()

  if (replayed.phase !== "rejected") {
    return `[R] the replayed terminal was not 'rejected' (got '${String(replayed.phase)}').`
  }
  if (replayed.kind === "approval_denied") {
    return "[R] a NON-VETOING promoted deny relabelled a downstream rejection as 'approval_denied' — the hook would re-plan around a human refusal that never happened. Once the quorum was reached, that deny was definitionally a vote, not the verdict."
  }
  if (!/precondition/.test(String(replayed.reason ?? ""))) {
    return `[R] the replayed rejection lost the real reason. Got: ${String(replayed.reason)}`
  }
  return undefined
}

/** Rewrite the session log with every `approval.requested@1` removed. */
async function stripApprovalRequested(logDir: string, sessionId: string): Promise<void> {
  const dir = join(logDir, PROJECT_ID)
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ndjson")) continue
    const path = join(dir, name)
    const kept = (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.includes('"type":"approval.requested"'))
    await writeFile(path, kept.length > 0 ? `${kept.join("\n")}\n` : "")
  }
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))

  const guardFailure = await guardCases()
  if (guardFailure !== undefined) return { passed: false, details: guardFailure }

  const undersized = undersizedRosterCase()
  if (undersized !== undefined) return { passed: false, details: undersized }

  const proxyFailure = await proxyCases()
  if (proxyFailure !== undefined) return { passed: false, details: proxyFailure }

  const runtimeFailure = await runtimeGateCase()
  if (runtimeFailure !== undefined) return { passed: false, details: runtimeFailure }

  const unrecoveredFailure = await runtimeGateUnrecoveredRequestCase()
  if (unrecoveredFailure !== undefined) return { passed: false, details: unrecoveredFailure }

  const replayFailure = await runtimeGateReplayClassificationCase()
  if (replayFailure !== undefined) return { passed: false, details: replayFailure }

  return {
    passed: true,
    details:
      "Quorum is adjudicated by the kernel, never attested by a client. Through guard.wrap(): three distinct eligible signed grants satisfied quorum 3 (three approval.granted@1 votes, one approval.quorum_reached@1 authorization naming all three with their evidence pointers, tool run once); a collector-synthesized single grant could not satisfy 3; M-1 did not un-park; a duplicate actor_id counted once; a deny after M-1 was decisive; a revoked key's outstanding vote stopped counting (verify-time roster, no snapshot); an authentically-signed but INELIGIBLE pinned approver was promoted-but-not-counted (authenticity gates the log write, eligibility gates the count); an approver with no supplied authority record did not count (fail closed); the action's own proposer could not count toward its own quorum; a request with no quorum took the single-approver path byte-identically, emitting no quorum event; an INELIGIBLE approver's promoted deny left the hold VISIBLE in the read-side queue (a vote is not a verdict — otherwise any pinned approver could hide a live hold) while the host's own action.rejected DID close it; and a collector's validly-signed vote for a DIFFERENT request was never promoted into this session's log. Through the real MCP proxy over the real signed .approvals/ side-channel: three votes cast one at a time accumulated in the LOG until the third authorized the call (the single-slot channel needed no change), and a partially satisfied 2-of-3 that hit its deadline was a SOFT DENIAL with the tool never run; and a host pinning its keys only through the injected quorumRoster override reached quorum, so the override is the effective verification trust root rather than config. And through the real runtime gate over the real NDJSON-RPC loopback: votes accumulated across resumes without un-parking early, the third completed the action with the remoted body run exactly once, and the same injected roster was the trust root there too; a quorum hold whose durable request record was lost failed CLOSED rather than resuming on a single grant; a non-vetoing promoted deny did not relabel a downstream rejection as a human refusal on replay; a roster too small to ever satisfy the declared threshold was refused at construction; and an unusable post-deadline vote was cleared from the single-slot channel so the three real votes could still land.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: quorum_requires_distinct_eligible_approvers")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
