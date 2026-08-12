import type { ApprovalOutcome } from "@qmilab/lodestar-action-kernel"
import {
  APPROVAL_DENIED_EVENT_TYPE,
  APPROVAL_GRANTED_EVENT_TYPE,
  APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  APPROVAL_QUORUM_REACHED_SCHEMA_VERSION,
  type ApprovalGrantedPayload,
  type ApprovalQuorumReachedPayload,
  ApprovalQuorumReachedPayloadSchema,
  type ApprovalRequest,
  type Policy,
  ResourceScopeSchema,
  SensitivitySchema,
} from "@qmilab/lodestar-core"
import {
  ApprovalSignatureError,
  type ApproverAuthority,
  type AuthorizedApproverKeys,
  type EvaluateQuorumOptions,
  type QuorumEvaluation,
  type QuorumVote,
  verifyApprovalSignature,
} from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"
import type { ApprovalResolution } from "./approvals-channel.js"

/**
 * The host-side half of M-of-N quorum approvals (ADR-0041).
 *
 * `evaluateQuorum` in `@qmilab/lodestar-policy-kernel` is the pure adjudicator;
 * this module is the vocabulary the three governance hosts — `guard.wrap()`, the
 * MCP proxy, and the runtime gate — share so they cannot drift on the parts that
 * matter: what a host must be configured with before it may adjudicate, how a
 * satisfied quorum becomes an `ApprovalOutcome`, and what the authoritative
 * `approval.quorum_reached@1` record says.
 *
 * ## The load-bearing separation, restated for hosts
 *
 * `approval.granted@1` is **one approver's vote** — unchanged shape, unchanged
 * meaning. `approval.quorum_reached@1` is the **authorization**. At the
 * single-approver threshold the two coincide, which is why a request with no
 * `quorum` emits no quorum event and takes exactly today's path.
 *
 * So the host flow at `quorum >= 2` is **promote, then adjudicate**:
 *
 *   1. obtain a signed resolution (channel / log / in-process collector);
 *   2. verify its signature and promote it to `approval.granted@1` /
 *      `approval.denied@1` in the host's own log — the host is the sole writer,
 *      and this is what gives each vote a durable, citable `event_id`;
 *   3. run `evaluateQuorum` over every vote accumulated so far;
 *   4. on `satisfied`, emit `approval.quorum_reached@1` and drive
 *      `ActionKernel.resolve()` with {@link quorumGrantedOutcome}.
 *
 * Accumulated votes therefore live in the **log**, not in the transport. That is
 * why no `ApprovalChannel` change was needed: `fetch(ref)` still returns at most
 * one resolution per poll, the host promotes it and consumes it, and the next
 * approver's vote arrives on the next poll.
 *
 * A vote promoted at step 2 has cleared *authenticity* but not yet *eligibility*
 * — that is deliberate. An authentic vote from an approver who does not clear
 * `required_authority` is still a real vote and belongs in the log; it simply
 * does not count toward the threshold, which is what step 3 decides.
 */

/**
 * The two operator-held rosters a host must have before it can adjudicate a
 * quorum — the same pair `evaluateQuorum` takes, named for host configuration.
 *
 * Both are read at **evaluation time**, never snapshotted at request time, so a
 * revoked key or a demoted approver stops counting immediately.
 */
export interface QuorumRoster {
  /** `actor_id → SPKI PEM`. Authenticity. Typically the host's existing pinned
   *  `approvals.authorized_keys` — quorum introduces no second trust root. */
  authorized_keys: AuthorizedApproverKeys
  /**
   * `actor_id → ApproverAuthority`. Eligibility, checked against the request's
   * `required_authority`. This is a **new operator input**, not a roster schema
   * change: `authorized_keys` keeps its shape and the authority map is supplied
   * alongside it, exactly as `authorizeResolution` already takes an approver.
   * A full core `Actor` is structurally assignable.
   *
   * A host with no authority source cannot satisfy a `quorum >= 2` rule —
   * deliberately, since the alternative is a quorum that counts ineligible
   * approvers (see {@link assertQuorumRoster}).
   */
  approvers: ReadonlyMap<string, ApproverAuthority>
}

/**
 * The config shape of one approver's authority. Host config — it lives here
 * beside {@link ApprovalChannelConfigSchema} rather than in
 * `@qmilab/lodestar-core` for the same reason: it is meaningless without the
 * adjudication it drives, and both the MCP proxy and the runtime gate consume it.
 *
 * Exactly the fields `approverShortfall` reads, and no more. `id` is absent
 * because the roster entry already carries `actor_id` — the host supplies it, so
 * the two can never disagree. `authority_scope` defaults to `[]` ("holds no
 * named scope"), which is the fail-closed direction: a defaulted value here can
 * only make approval harder, never easier.
 */
export const ApproverAuthoritySchema = z.object({
  trust_baseline: z.number().min(0).max(1).describe("default credibility [0,1]"),
  sensitivity_clearance: SensitivitySchema.describe("max sensitivity this approver may handle"),
  authority_scope: z
    .array(ResourceScopeSchema)
    .default([])
    .describe("scopes this approver may operate within; empty holds none"),
})
export type ApproverAuthorityConfig = z.infer<typeof ApproverAuthoritySchema>

/** One roster entry as an operator writes it: key (authenticity) + optional authority (eligibility). */
export interface ApproverRosterEntry {
  actor_id: string
  public_key: string
  authority?: ApproverAuthorityConfig
}

/**
 * Build the {@link QuorumRoster} from a host's pinned-approver config, or
 * `undefined` when **no** entry declares an `authority` — in which case the host
 * genuinely cannot adjudicate a quorum and should say so rather than silently
 * rejecting every vote as ineligible (which would look like a stalled approval,
 * not a misconfiguration).
 *
 * A *partial* roster is fine and deliberate: an approver with a pinned key but no
 * declared authority can still cast a real, promotable vote — it just does not
 * count toward a threshold. Fail closed, per approver.
 */
export function approverRosterFrom(
  entries: readonly ApproverRosterEntry[],
): QuorumRoster | undefined {
  const approvers = new Map<string, ApproverAuthority>()
  for (const entry of entries) {
    if (entry.authority === undefined) continue
    approvers.set(entry.actor_id, { id: entry.actor_id, ...entry.authority })
  }
  if (approvers.size === 0) return undefined
  return {
    authorized_keys: entries.map((e) => ({ actor_id: e.actor_id, public_key: e.public_key })),
    approvers,
  }
}

/**
 * Does this policy contain a rule that would open a `quorum >= 2` hold? Hosts
 * call this at construction so a config that declares quorum but pins no approver
 * *authority* fails loudly at startup — the same "no silent non-enforcement"
 * posture as the proxy's sentinel guards. Catching it at construction is much
 * better than at hold time, where the first governed L4 call of a real session
 * would be the thing that discovers the gap.
 */
export function policyDeclaresQuorum(policy: Policy): boolean {
  return maxDeclaredQuorum(policy) >= 2
}

/** The largest threshold any rule in this policy can open. `1` when none does. */
export function maxDeclaredQuorum(policy: Policy): number {
  return policy.rules.reduce((max, rule) => Math.max(max, rule.approval?.quorum ?? 1), 1)
}

/**
 * How many *distinct* approvers this roster could ever contribute to a quorum:
 * those holding **both** a pinned key (so their vote can be authentic) and an
 * authority record (so it can be eligible). Either alone is useless — a key with
 * no authority casts a promotable vote that never counts, and an authority record
 * with no key cannot produce a vote at all.
 *
 * This is a strict upper bound, not a promise: an approver may still fail the
 * request's `required_authority` at evaluation time, and the action's proposer is
 * excluded from its own quorum. It exists so a host can reject the case that is
 * *provably* unsatisfiable before it accepts any traffic.
 */
export function quorumCapacity(roster: QuorumRoster): number {
  const pinned = new Set(
    roster.authorized_keys instanceof Map
      ? roster.authorized_keys.keys()
      : roster.authorized_keys.map((k) => k.actor_id),
  )
  let capacity = 0
  for (const actorId of roster.approvers.keys()) {
    if (pinned.has(actorId)) capacity += 1
  }
  return capacity
}

/**
 * The construction-time guard both out-of-process hosts share: `null` when this
 * roster could satisfy every threshold `policy` can open, else the operator-facing
 * reason it cannot.
 *
 * A roster smaller than the threshold is a **deterministic misconfiguration**, not
 * a runtime condition — `quorum: 3` with two eligible approvers can never be
 * satisfied by any sequence of votes. Left unchecked it presents as every governed
 * L4 call stalling to `approval_timeout` with nothing in the log explaining why,
 * which is the failure mode the whole no-silent-non-enforcement family exists to
 * prevent. Better to refuse to start.
 */
export function quorumRosterShortfall(
  policy: Policy,
  roster: QuorumRoster | undefined,
): string | null {
  const required = maxDeclaredQuorum(policy)
  if (required < 2) return null
  if (roster === undefined) {
    return `the policy declares a require_approval rule with quorum ${required}, but no pinned approver carries an \`authority\` record. Quorum checks TWO orthogonal things: a pinned public_key proves a vote is authentic, and an authority record ({ trust_baseline, sensitivity_clearance, authority_scope }) proves the approver is eligible against the rule's required_authority. Keys alone would let ANY pinned approvers satisfy the threshold, so a quorum with no authority records can never be satisfied. Declare \`authority\` on the approvers who may vote, or drop \`quorum\` from the rule.`
  }
  const capacity = quorumCapacity(roster)
  if (capacity < required) {
    return `the policy declares a require_approval rule with quorum ${required}, but only ${capacity} approver(s) hold BOTH a pinned key and an \`authority\` record. No sequence of votes could ever satisfy it, so every held action would stall to an approval timeout with nothing explaining why. Pin at least ${required} fully-configured approvers, or lower the rule's quorum.`
  }
  return null
}

/**
 * Is this resolution bound to *this* request and action?
 *
 * A signature proves **who** signed; it does not prove **what for**. The
 * `request_id` and `action_id` are inside the signed bytes, so `evaluateQuorum`
 * re-checks them — but a host must check *before promoting*, not only before
 * counting. A collector or channel that returns a stale-but-validly-signed
 * resolution for a different hold would otherwise have it written into this
 * session's log as an `approval.granted@1` for that other request: adjudication
 * would correctly refuse to count it, yet the read side would see a terminal-
 * looking approval for a hold that was never resolved.
 *
 * The MCP proxy and the runtime gate already check both ids on their channel
 * path; this is the shared predicate so the in-process path cannot forget.
 */
export function voteIsBoundTo(resolution: ApprovalResolution, request: ApprovalRequest): boolean {
  return resolution.request_id === request.request_id && resolution.action_id === request.action_id
}

/** Does this request need quorum adjudication rather than the single-approver path? */
export function needsQuorum(request: ApprovalRequest): boolean {
  return request.quorum !== undefined && request.quorum >= 2
}

/**
 * Fail loudly when a host is asked to adjudicate a quorum it is not configured
 * for. There is deliberately **no fallback to the single-approver path**: a
 * silent downgrade would turn a policy that says "three approvers" into one that
 * un-parks on the first grant — the worst possible failure direction, and exactly
 * the "no silent defaults for security-relevant settings" rule. Same posture as
 * `guard.callTool` throwing when a hold has no configured resolver.
 */
export function assertQuorumRoster(
  request: ApprovalRequest,
  roster: QuorumRoster | undefined,
  hostHint: string,
): asserts roster is QuorumRoster {
  if (roster !== undefined) return
  throw new Error(
    `approval request '${request.request_id}' requires a quorum of ${request.quorum} distinct approvers, but this host has no approver roster configured. Quorum needs BOTH the pinned approver keys (authenticity) and an operator-supplied actor_id → authority map (eligibility against required_authority); keys alone would let any ${request.quorum} pinned approvers satisfy it. ${hostHint}`,
  )
}

/** Spread into an `evaluateQuorum` options object from a host's roster + action. */
export function quorumOptions(roster: QuorumRoster, proposedBy?: string): EvaluateQuorumOptions {
  const options: EvaluateQuorumOptions = {
    authorizedKeys: roster.authorized_keys,
    approverAuthority: roster.approvers,
  }
  if (proposedBy !== undefined) options.proposedBy = proposedBy
  return options
}

/**
 * The `approval.granted@1` / `approval.denied@1` payload a vote is promoted to.
 *
 * **The signature rides along, and that is load-bearing.** A
 * `approval.quorum_reached@1` record names each constituent by its
 * `granted_event_id` precisely so a later reader can re-fetch that event and
 * re-verify it against *their own* pinned keys rather than trusting the emitter.
 * Drop the signature here and the record degrades into an unverifiable assertion
 * — the intermediary-attests-quorum failure this whole design refuses. Same
 * reason the MCP proxy's `emitCanonicalResolution` carries it.
 */
export function promotedVotePayload(resolution: ApprovalResolution): ApprovalGrantedPayload {
  const payload: ApprovalGrantedPayload = {
    request_id: resolution.request_id,
    action_id: resolution.action_id,
    approver_id: resolution.approver_id,
    at: resolution.at,
  }
  if (resolution.reason !== undefined) payload.reason = resolution.reason
  if (resolution.signature !== undefined) payload.signature = resolution.signature
  return payload
}

/** The event type a promoted vote is written under. */
export function promotedVoteEventType(resolution: ApprovalResolution): string {
  return resolution.kind === "granted" ? APPROVAL_GRANTED_EVENT_TYPE : APPROVAL_DENIED_EVENT_TYPE
}

/**
 * Turn a signed resolution the host has already promoted into the log into the
 * vote `evaluateQuorum` counts. `eventId` is the promoted envelope's id — the
 * pointer that lets a later reader re-fetch the signature and check the quorum
 * claim against their own pinned keys instead of trusting the emitter.
 */
export function voteFromResolution(resolution: ApprovalResolution, eventId: string): QuorumVote {
  const vote: QuorumVote = {
    resolution: {
      request_id: resolution.request_id,
      action_id: resolution.action_id,
      kind: resolution.kind,
      approver_id: resolution.approver_id,
      at: resolution.at,
      ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
    },
    event_id: eventId,
  }
  if (resolution.signature !== undefined) vote.signature = resolution.signature
  return vote
}

/**
 * The `ApprovalOutcome` a **satisfied** quorum drives `ActionKernel.resolve()`
 * with. No `ApprovalOutcome` schema change: the outcome's `approver_id` is the
 * approver whose counted vote *completed* the threshold, so the action's audit
 * still points at one real, signed, individually-verifiable vote — and the
 * `reason` names every constituent, with the full evidence in the
 * `approval.quorum_reached@1` event beside it.
 *
 * Throws if the evaluation is not satisfied: minting a grant from an unsatisfied
 * quorum is the one mistake this whole design exists to prevent, so it is a hard
 * error rather than a caller's `if`.
 */
export function quorumGrantedOutcome(
  request: ApprovalRequest,
  evaluation: QuorumEvaluation,
  at: string,
): ApprovalOutcome {
  if (!evaluation.satisfied) {
    throw new Error(
      `quorumGrantedOutcome called for an UNSATISFIED quorum on request '${request.request_id}' ` +
        `(${evaluation.approvals.length} of ${evaluation.required}${evaluation.vetoed ? ", vetoed" : ""})`,
    )
  }
  const completing = evaluation.approvals[evaluation.required - 1]
  if (completing === undefined) {
    // Unreachable: `satisfied` implies `approvals.length >= required >= 1`.
    throw new Error(`quorum on request '${request.request_id}' is satisfied but names no approvals`)
  }
  const named = evaluation.approvals.map((a) => a.approver_id).join(", ")
  return {
    kind: "granted",
    action_id: request.action_id,
    request_id: request.request_id,
    approver_id: completing.approver_id,
    reason: `quorum of ${evaluation.required} reached — ${evaluation.approvals.length} verified approval(s): ${named}`,
    at,
  }
}

/** The `ApprovalOutcome` a vetoing deny drives `resolve()` with. */
export function quorumDeniedOutcome(
  request: ApprovalRequest,
  evaluation: QuorumEvaluation,
  at: string,
): ApprovalOutcome {
  if (evaluation.vetoed === undefined) {
    throw new Error(
      `quorumDeniedOutcome called for a request with no veto ('${request.request_id}')`,
    )
  }
  return {
    kind: "denied",
    action_id: request.action_id,
    request_id: request.request_id,
    approver_id: evaluation.vetoed.approver_id,
    reason:
      evaluation.vetoed.reason ??
      `approver '${evaluation.vetoed.approver_id}' denied; a single valid deny is decisive`,
    at,
  }
}

/**
 * The authoritative `approval.quorum_reached@1` payload — "M distinct verified
 * approvals satisfy the threshold, and here they are". Schema-parsed on the way
 * out, so the two structural invariants (at least `quorum` approvals, all
 * distinct) are enforced before the event can reach the log rather than trusted
 * from the emitter.
 */
export function quorumReachedPayload(
  request: ApprovalRequest,
  evaluation: QuorumEvaluation,
  at: string,
): ApprovalQuorumReachedPayload {
  return ApprovalQuorumReachedPayloadSchema.parse({
    request_id: request.request_id,
    action_id: request.action_id,
    quorum: evaluation.required,
    approvals: evaluation.approvals,
    at,
  })
}

/** Event type + schema version for {@link quorumReachedPayload}, re-exported so a
 *  host emits the versioned pair without importing two constants separately. */
export const QUORUM_REACHED_EVENT = {
  type: APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  schema_version: APPROVAL_QUORUM_REACHED_SCHEMA_VERSION,
} as const

/**
 * The pre-promotion authenticity gate: may this resolution be written into the
 * host's log as an `approval.granted@1` / `approval.denied@1` at all?
 *
 * Deliberately narrower than the single-approver path's `resolutionVerified`,
 * which honours a no-keys + explicit `allow_unsigned` legacy mode. Quorum has no
 * unsigned path — an unsigned vote is exactly the synthesized artifact ADR-0041
 * exists to refuse — so this always requires a valid signature from a pinned key.
 *
 * Authenticity only. *Eligibility* against `required_authority` is
 * `evaluateQuorum`'s decision, and it is right that the two are separated: an
 * authentic vote from an approver who does not clear the authority is still a
 * real vote and belongs in the log; it simply does not count.
 */
export function resolutionIsAuthentic(
  resolution: ApprovalResolution,
  authorizedKeys: AuthorizedApproverKeys,
): boolean {
  try {
    verifyApprovalSignature(
      {
        request_id: resolution.request_id,
        action_id: resolution.action_id,
        kind: resolution.kind,
        approver_id: resolution.approver_id,
        at: resolution.at,
        ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
      },
      resolution.signature,
      { authorizedKeys, allowUnsigned: false },
    )
    return true
  } catch (error) {
    if (error instanceof ApprovalSignatureError) return false
    throw error
  }
}

/** A human-legible account of why a quorum has not (yet) been satisfied. */
export function quorumShortfallReason(evaluation: QuorumEvaluation): string {
  if (evaluation.vetoed !== undefined) {
    return `approver '${evaluation.vetoed.approver_id}' denied — a single valid deny is decisive regardless of the ${evaluation.approvals.length} approval(s) collected`
  }
  const counted = `${evaluation.approvals.length} of ${evaluation.required} required approvals verified`
  if (evaluation.rejected.length === 0) return counted
  const why = evaluation.rejected.map((r) => `${r.approver_id} (${r.code})`).join(", ")
  return `${counted}; not counted: ${why}`
}
