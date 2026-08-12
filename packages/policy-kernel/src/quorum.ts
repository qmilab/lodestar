import type { Actor, ApprovalRequest, QuorumApprovalRef, Signature } from "@qmilab/lodestar-core"
import {
  type ApprovalResolutionDoc,
  ApprovalSignatureError,
  type AuthorizedApproverKeys,
  canonicalApprovalResolutionHash,
  verifyApprovalSignature,
} from "./approval-signature.js"
import { approverShortfall } from "./approval.js"

/**
 * M-of-N quorum adjudication — the kernel half of ADR-0041.
 *
 * ## Why this is a kernel function and not a client one
 *
 * The value of customer-held approver keys is that no intermediary can
 * manufacture authorization. If a coordinating client (a hosted control plane, a
 * desktop app, a CI collector) gathers N signatures and submits *one* synthesized
 * grant, the kernel records a **single-approver** decision and "quorum" degrades
 * into an unverifiable claim by that intermediary. So: **the client accumulates;
 * the kernel adjudicates.** A collector must never attest that quorum was met.
 *
 * This module is that adjudication, and it is **pure** — no I/O, no clock, no key
 * access of its own. Everything it needs is passed in, which is what keeps
 * `@qmilab/lodestar-policy-kernel` importable without `@qmilab/lodestar-guard`
 * (which drags `wrap` + memory-firewall + cognitive-core + harness): a read-side
 * consumer can re-adjudicate a logged quorum against its *own* pinned roster
 * without the write-side runtime.
 *
 * ## Two orthogonal checks, two inputs
 *
 * Counting signatures is **not** sufficient. Authenticity and eligibility are
 * separate properties with separate inputs, and conflating them silently weakens
 * every quorum:
 *
 * - **Authenticity** — "did an operator-pinned key sign this exact resolution?"
 *   Input: {@link EvaluateQuorumOptions.authorizedKeys}. Enforced by
 *   {@link verifyApprovalSignature}.
 * - **Eligibility** — "does this approver satisfy the request's
 *   `required_authority` (`min_trust_baseline` / `sensitivity_clearance` /
 *   `scope`)?" Input: {@link EvaluateQuorumOptions.approverAuthority}. Enforced by
 *   the same `approverShortfall` predicate `authorizeResolution` already applies.
 *
 * `authorizedKeys` cannot answer the second question, because **the signed
 * resolution carries no authority** — the canonical document is
 * `{ request_id, action_id, kind, approver_id, reason?, at }`, deliberately (see
 * `approval-signature.ts`; self-attested authority is not authority). Without the
 * second input, a rule reading `{ required_authority: { sensitivity_clearance:
 * "secret" }, quorum: 3 }` would be satisfied by *any three pinned approvers*.
 * That is not a corner case: `openApprovalRequest` runs every rule's authority
 * through `withActionSensitivity()`, which **always** stamps at least the action's
 * mapped sensitivity — so every `ApprovalRequest.required_authority` is non-empty
 * and the gap would bite on every quorum rather than only on explicitly-stricter
 * ones.
 *
 * The authority source must therefore be **operator-held**, never taken from the
 * resolution or from the resolver's self-declaration. Consistent with the
 * verify-time roster below, it is read at evaluation time, so a *demoted*
 * approver stops counting exactly as a *revoked key* does.
 *
 * ## The verify-time roster (no snapshot)
 *
 * Both rosters are the ones in force *when quorum is evaluated*; all constituent
 * resolutions are re-verified against them at that moment. Pinning a snapshot at
 * request time would mean a revoked or compromised key still authorizes every
 * in-flight request; evaluating against the current roster means a legitimate
 * mid-collection rotation stalls one vote and the approver re-signs. Prompt
 * revocation beats convenience, so we fail closed. Re-verification is cheap (M is
 * small; Ed25519 verify is microseconds) and it *is* the enforcement point.
 *
 * ## Deliberately no `allowUnsigned`
 *
 * {@link verifyApprovalSignature} offers an explicit unsigned opt-out for the
 * development / legacy in-process path. Quorum does **not** expose it: an unsigned
 * vote is exactly the collector-synthesized artifact this module exists to
 * refuse. A host wiring `quorum >= 2` must pin approver keys.
 *
 * ## Honest non-guarantee
 *
 * Distinctness is by `actor_id`, the only identity the kernel has. It cannot
 * detect one human holding two `actor_id`s — `authorized_keys` maps
 * `actor_id → public_key` one-to-one, so two identities for one person is an
 * **operator roster-hygiene** failure, stated here rather than papered over (the
 * same honest-boundary discipline as the OS-sandbox and TS-boundary concessions).
 */

/**
 * One accumulated vote: a resolution an approver signed, plus the log record it
 * was promoted into. ADR-0041's accumulation model is **incremental** — one
 * signed event per vote, never a bundle — so each element here is independently
 * attributable and independently re-verifiable.
 *
 * `event_id` is required rather than optional because a counted grant becomes a
 * `QuorumApprovalRef`, whose `granted_event_id` is what lets a later reader
 * re-fetch the signature from the log and check the claim against their own
 * pinned keys instead of trusting the emitter. A host always has it: it promotes
 * the resolution to `approval.granted@1` / `approval.denied@1` before
 * accumulating.
 */
export interface QuorumVote {
  /** The canonical resolution document, exactly as signed. */
  resolution: ApprovalResolutionDoc
  /** The detached signature. Absent is rejected — quorum has no unsigned path. */
  signature?: Signature
  /** Envelope id of the `approval.granted@1` / `approval.denied@1` carrying this vote. */
  event_id: string
}

export interface EvaluateQuorumOptions {
  /**
   * Operator-pinned approver public keys (`actor_id → SPKI PEM`) — the
   * **authenticity** trust root. A vote whose signer is not in this set does not
   * count, which is also how a *revoked* key's outstanding vote stops counting.
   */
  authorizedKeys: AuthorizedApproverKeys
  /**
   * Operator-supplied approver identities (`actor_id → Actor`) — the
   * **eligibility** input, checked against the request's `required_authority`.
   * Distinct from the result's `approvals`, which is the *outcome*.
   *
   * Fail closed: an approver with no entry here does not count. That is
   * deliberate — a host with no authority source cannot satisfy a `quorum >= 2`
   * rule, since the alternative is a quorum that counts ineligible approvers.
   */
  approverAuthority: ReadonlyMap<string, Actor>
  /**
   * The held action's `proposed_by`. At `quorum >= 2` this actor's own grant does
   * not count toward the quorum it triggered (four-eyes). Omitted, or at the
   * single-approver threshold, no exclusion applies — which is what keeps the
   * existing path byte-identical.
   */
  proposedBy?: string
}

/** Why a vote did not count. Audit-facing; each is a fail-closed outcome. */
export type QuorumRejectionCode =
  /** Bound to a different `request_id` / `action_id` — a vote for another hold. */
  | "not_for_request"
  /** `at` unparseable, before `requested_at`, or past the request's `deadline`. */
  | "out_of_window"
  /** Unsigned, tampered, lifted onto another approver, or signed by an unpinned key. */
  | "signature"
  /** No `Actor` supplied, so `required_authority` cannot be checked. */
  | "no_authority"
  /** `Actor` supplied but it does not clear `required_authority`. */
  | "shortfall"
  /** The action's own proposer, at `quorum >= 2`. */
  | "proposer"
  /** This actor already cast a counted vote — quorum counts DISTINCT approvers. */
  | "duplicate"

/** A vote that was seen and did not count, with why. */
export interface RejectedQuorumVote {
  approver_id: string
  at: string
  event_id: string
  code: QuorumRejectionCode
  reason: string
}

/**
 * The decisive deny. Any **one** valid deny rejects the action regardless of
 * grants collected: quorum exists to make *approval* harder, and making *denial*
 * harder would invert the safety property — a lone approver who spots an active
 * attack could not stop it while the remaining approvers reach the threshold.
 */
export interface QuorumVeto {
  approver_id: string
  at: string
  event_id: string
  /** sha-256 of the canonical resolution document this approver signed. */
  payload_hash: string
  reason?: string
}

export interface QuorumEvaluation {
  /**
   * `true` iff the threshold was met **and** nothing vetoed. This is the only
   * field a host may treat as authorization; a progress count derived from
   * `approvals.length` is advisory and never gates.
   */
  satisfied: boolean
  /** The threshold that had to be met — `request.quorum ?? 1`. */
  required: number
  /**
   * The verified, eligible, deduped, non-proposer **grants**, chronologically —
   * exactly the `approvals` of an `approval.quorum_reached@1` payload. Named for
   * what it holds, distinct from the `approverAuthority` *input*.
   *
   * Every verified grant is listed, not just the first `required` of them: the
   * record names its evidence rather than asserting a count.
   */
  approvals: QuorumApprovalRef[]
  /** Present iff a valid deny vetoed. Terminal — the host rejects the action. */
  vetoed?: QuorumVeto
  /** Every vote that did not count, with its reason. */
  rejected: RejectedQuorumVote[]
}

/**
 * Adjudicate an accumulated set of signed resolutions against a request's quorum.
 *
 * Votes are evaluated **chronologically** (by their signed `at`, ties broken by
 * input order). Each is checked for request binding, window, authenticity, and
 * eligibility — in that order, so the reported reason is the most specific one —
 * and only then counted. A valid deny is terminal and stops the scan: later votes
 * are moot, and a deny from an actor who earlier granted still vetoes.
 *
 * The proposer exclusion applies to **grants only**. A proposer withdrawing their
 * own action by denying it is the safe direction on both axes: excluding their
 * grant makes approval harder, and honouring their deny makes rejection easier.
 *
 * Note that a deny is decisive even when `approvals.length >= required` in the
 * same snapshot. In practice a host that had already seen the threshold met would
 * have resolved the action and stopped consulting this function; when both appear
 * together, rejecting is the fail-closed answer.
 *
 * Throws on a malformed `request` (an unparseable `requested_at` / `deadline`) —
 * that is a host bug, and it must be loud rather than masquerade as an attack, the
 * same posture as `assertValidApproverKeys` failing at startup. A malformed *vote*
 * is never a throw; it is a rejection.
 *
 * @param request The open request, whose `quorum`, `required_authority`,
 *   `requested_at` and `deadline` are the adjudication's terms.
 * @param resolutions The accumulated votes, in any order.
 */
export function evaluateQuorum(
  request: ApprovalRequest,
  resolutions: readonly QuorumVote[],
  options: EvaluateQuorumOptions,
): QuorumEvaluation {
  const required = request.quorum ?? 1
  const requestedAt = parseRequestTimestamp(request.requested_at, "requested_at", request)
  const deadline =
    request.deadline === undefined
      ? undefined
      : parseRequestTimestamp(request.deadline, "deadline", request)

  const approvals: QuorumApprovalRef[] = []
  const rejected: RejectedQuorumVote[] = []
  const counted = new Set<string>()
  let vetoed: QuorumVeto | undefined

  for (const vote of chronological(resolutions)) {
    const doc = vote.resolution
    const reject = (code: QuorumRejectionCode, reason: string): void => {
      rejected.push({
        approver_id: doc.approver_id,
        at: doc.at,
        event_id: vote.event_id,
        code,
        reason,
      })
    }

    // (1) Binding. A signature proves *who* signed; it does not prove the
    // resolution is for THIS request. `request_id` and `action_id` are inside the
    // signed bytes, so this is a cheap re-check of a property the signature
    // already carries — but it must be checked, or a valid vote lifted from
    // another hold would count here.
    if (doc.request_id !== request.request_id || doc.action_id !== request.action_id) {
      reject(
        "not_for_request",
        `resolution is bound to request '${doc.request_id}' / action '${doc.action_id}', not '${request.request_id}' / '${request.action_id}'`,
      )
      continue
    }

    // (2) Window. The `at >= requested_at` sanity bound, plus the deadline as its
    // companion upper bound when one is set (the request's terminal path is
    // `approval.expired@1`; a vote outside the window cannot revive it). Pure —
    // it compares two supplied timestamps and never reads a clock.
    const at = Date.parse(doc.at)
    if (Number.isNaN(at)) {
      reject("out_of_window", `resolution 'at' ('${doc.at}') is not a parseable timestamp`)
      continue
    }
    if (at < requestedAt) {
      reject(
        "out_of_window",
        `resolved at ${doc.at}, before the request was opened at ${request.requested_at}`,
      )
      continue
    }
    if (deadline !== undefined && at > deadline) {
      reject(
        "out_of_window",
        `resolved at ${doc.at}, after the request deadline ${request.deadline}`,
      )
      continue
    }

    // (3) Authenticity — against the roster in force NOW. No `allowUnsigned`:
    // an unsigned vote is the synthesized artifact this module refuses.
    //
    // Only a typed ApprovalSignatureError becomes a rejection. Anything else — a
    // malformed roster, a corrupt pinned key — is a host misconfiguration and is
    // rethrown, because silently recording it as a *rejected vote* would make an
    // operator error indistinguishable from a forgery and would time out every
    // real approval. Same reasoning as `assertValidApproverKeys` failing loudly
    // at startup rather than at verification time.
    try {
      verifyApprovalSignature(doc, vote.signature, { authorizedKeys: options.authorizedKeys })
    } catch (error) {
      if (!(error instanceof ApprovalSignatureError)) throw error
      reject("signature", error.message)
      continue
    }

    // (4) Eligibility — the orthogonal check. Authentic is not eligible.
    const approver = options.approverAuthority.get(doc.approver_id)
    if (approver === undefined) {
      reject(
        "no_authority",
        `no Actor was supplied for approver '${doc.approver_id}', so the request's required_authority cannot be checked`,
      )
      continue
    }
    if (approver.id !== doc.approver_id) {
      // A mis-keyed roster would otherwise lend one actor's authority to another.
      reject(
        "no_authority",
        `the supplied Actor for '${doc.approver_id}' identifies as '${approver.id}' — the approver roster is mis-keyed`,
      )
      continue
    }
    const shortfall = approverShortfall(approver, request.required_authority)
    if (shortfall !== null) {
      reject(
        "shortfall",
        `approver '${doc.approver_id}' does not clear the request's required_authority: ${shortfall}`,
      )
      continue
    }

    // (5) The verdict. A valid deny is decisive and terminal.
    if (doc.kind === "denied") {
      vetoed = {
        approver_id: doc.approver_id,
        at: doc.at,
        event_id: vote.event_id,
        payload_hash: canonicalApprovalResolutionHash(doc),
      }
      if (doc.reason !== undefined) vetoed.reason = doc.reason
      break
    }

    // Four-eyes, scoped to real quorum so the single-approver path is untouched.
    if (
      required >= 2 &&
      options.proposedBy !== undefined &&
      doc.approver_id === options.proposedBy
    ) {
      reject(
        "proposer",
        `approver '${doc.approver_id}' proposed action '${request.action_id}' and cannot count toward its own quorum of ${required}`,
      )
      continue
    }

    if (counted.has(doc.approver_id)) {
      reject(
        "duplicate",
        `approver '${doc.approver_id}' has already cast a counted vote — quorum counts DISTINCT approvers`,
      )
      continue
    }

    counted.add(doc.approver_id)
    approvals.push({
      approver_id: doc.approver_id,
      at: doc.at,
      payload_hash: canonicalApprovalResolutionHash(doc),
      granted_event_id: vote.event_id,
    })
  }

  const evaluation: QuorumEvaluation = {
    satisfied: vetoed === undefined && approvals.length >= required,
    required,
    approvals,
    rejected,
  }
  if (vetoed !== undefined) evaluation.vetoed = vetoed
  return evaluation
}

/**
 * Order votes by their signed `at`, ties (and unparseable timestamps, which are
 * rejected on arrival anyway) broken by input order so the walk is deterministic.
 */
function chronological(votes: readonly QuorumVote[]): QuorumVote[] {
  return votes
    .map((vote, index) => {
      const parsed = Date.parse(vote.resolution.at)
      return { vote, index, at: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed }
    })
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))
    .map((entry) => entry.vote)
}

function parseRequestTimestamp(value: string, field: string, request: ApprovalRequest): number {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new Error(
      `policy-kernel: request '${request.request_id}' has an unparseable ${field} ('${value}'); a malformed request cannot be adjudicated`,
    )
  }
  return parsed
}
