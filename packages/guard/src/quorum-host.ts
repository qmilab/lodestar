import type { ApprovalOutcome } from "@qmilab/lodestar-action-kernel"
import {
  APPROVAL_DENIED_EVENT_TYPE,
  APPROVAL_GRANTED_EVENT_TYPE,
  APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  APPROVAL_QUORUM_REACHED_SCHEMA_VERSION,
  type Actor,
  type ApprovalGrantedPayload,
  type ApprovalQuorumReachedPayload,
  ApprovalQuorumReachedPayloadSchema,
  type ApprovalRequest,
} from "@qmilab/lodestar-core"
import {
  ApprovalSignatureError,
  type AuthorizedApproverKeys,
  type EvaluateQuorumOptions,
  type QuorumEvaluation,
  type QuorumVote,
  verifyApprovalSignature,
} from "@qmilab/lodestar-policy-kernel"
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
   * `actor_id → Actor`. Eligibility, checked against the request's
   * `required_authority`. This is a **new operator input**, not a roster schema
   * change: `authorized_keys` keeps its shape and the `Actor` map is supplied
   * alongside it, exactly as `authorizeResolution` already takes one.
   *
   * A host with no authority source cannot satisfy a `quorum >= 2` rule —
   * deliberately, since the alternative is a quorum that counts ineligible
   * approvers (see {@link assertQuorumRoster}).
   */
  approvers: ReadonlyMap<string, Actor>
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
    `approval request '${request.request_id}' requires a quorum of ${request.quorum} distinct approvers, but this host has no approver roster configured. Quorum needs BOTH the pinned approver keys (authenticity) and an operator-supplied actor_id → Actor map (eligibility against required_authority); keys alone would let any ${request.quorum} pinned approvers satisfy it. ${hostHint}`,
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
