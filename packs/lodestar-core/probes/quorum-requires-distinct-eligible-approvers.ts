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
 *
 * Why this matters: quorum is the control an operator reaches for when one
 * approver is not enough — an irreversible payment, a production deploy, a key
 * rotation. Every failure mode here degrades it back to single-approver
 * authorization while still *looking* like quorum in the log. A silent downgrade
 * is worse than no feature.
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult, Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import { _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import {
  APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  type ApprovalQuorumReachedPayload,
  type EventEnvelope,
  type Policy,
  registry,
} from "@qmilab/lodestar-core"
import { EventLogReader, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
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
  writeApprovalResolution,
} from "@qmilab/lodestar-guard-mcp"
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
    ...(record !== undefined
      ? { quorumRecord: record.payload as ApprovalQuorumReachedPayload }
      : {}),
  }
}

function countOf(types: string[], type: string): number {
  return types.filter((t) => t === type).length
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

function makeProxy(logDir: string, sessionId: string, approvalTimeoutMs: number) {
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
    approvals: { authorized_keys: proxyAuthorizedKeys(), allow_unsigned: false },
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
  return undefined
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))

  const guardFailure = await guardCases()
  if (guardFailure !== undefined) return { passed: false, details: guardFailure }

  const proxyFailure = await proxyCases()
  if (proxyFailure !== undefined) return { passed: false, details: proxyFailure }

  return {
    passed: true,
    details:
      "Quorum is adjudicated by the kernel, never attested by a client. Through guard.wrap(): three distinct eligible signed grants satisfied quorum 3 (three approval.granted@1 votes, one approval.quorum_reached@1 authorization naming all three with their evidence pointers, tool run once); a collector-synthesized single grant could not satisfy 3; M-1 did not un-park; a duplicate actor_id counted once; a deny after M-1 was decisive; a revoked key's outstanding vote stopped counting (verify-time roster, no snapshot); an authentically-signed but INELIGIBLE pinned approver was promoted-but-not-counted (authenticity gates the log write, eligibility gates the count); an approver with no supplied authority record did not count (fail closed); the action's own proposer could not count toward its own quorum; and a request with no quorum took the single-approver path byte-identically, emitting no quorum event. Through the real MCP proxy over the real signed .approvals/ side-channel: three votes cast one at a time accumulated in the LOG until the third authorized the call (the single-slot channel needed no change), and a partially satisfied 2-of-3 that hit its deadline was a SOFT DENIAL with the tool never run.",
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
