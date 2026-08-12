import {
  APPROVAL_DENIED_EVENT_TYPE,
  APPROVAL_EXPIRED_EVENT_TYPE,
  APPROVAL_GRANTED_EVENT_TYPE,
  APPROVAL_QUORUM_REACHED_EVENT_TYPE,
  APPROVAL_REQUESTED_EVENT_TYPE,
  ApprovalQuorumReachedPayloadSchema,
  ApprovalRequestSchema,
  type EventEnvelope,
  GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE,
  type QuorumApprovalRef,
} from "@qmilab/lodestar-core"

/**
 * The pending-approval queue, projected from a flat event stream.
 *
 * This is a pure projection over `EventEnvelope[]`, in the same family
 * as `projectChain` — no I/O, no writes. It graduated here from
 * `@qmilab/lodestar-viewer` (which re-exports it unchanged) so a
 * read-side consumer that only wants the set of open holds need not
 * depend on the viewer's HTTP server.
 */

/** A parked approval request with no terminal resolution in the log. */
export interface PendingApproval {
  project_id: string
  session_id: string
  request_id: string
  action_id: string
  /** The matched rule's reason, verbatim. */
  reason: string
  /** What an approver must be; rendered read-only — resolving is the write-side surface. */
  required_authority: unknown
  requested_at: string
  /** ISO 8601 hold timeout (MCP-proxy path); absent for in-process holds. */
  deadline?: string
  status: "pending"
  /**
   * How many *distinct* approvers this hold needs (ADR-0041). Absent for the
   * single-approver path, where the first valid grant is the authorization.
   */
  quorum?: number
  /**
   * **Advisory progress only — never authorization.** The distinct approvers whose
   * `approval.granted@1` is in the log and was not rejected by the guard's
   * signature audit, present only when `quorum` is.
   *
   * This is a *count of votes seen*, not a count of votes that COUNT. The
   * projection deliberately holds no pinned approver keys and no approver
   * authority records (the same boundary that stops it re-verifying signatures),
   * so it cannot apply the two checks adjudication turns on: whether each approver
   * clears the request's `required_authority`, and whether the action's own
   * proposer is among them. It can therefore only ever **overstate** — a UI that
   * renders "2 of 3" from this must present it as progress, never as "one more and
   * it's approved".
   *
   * The authoritative statement is `approval.quorum_reached@1`, projected by
   * {@link quorumRecords}: the emitting host held the keys and the roster, and that
   * record names its evidence so a reader can re-check it. The gate never reads
   * this field. Same posture as the trust-pack badges (advisory, never a gate) and
   * `corroborationStrength` (feeds no gate).
   */
  approvers_so_far?: string[]
}

/**
 * The authoritative record that a quorum was met: **M distinct verified approvals
 * satisfied the threshold, and here they are** (ADR-0041).
 *
 * Unlike {@link PendingApproval.approvers_so_far}, this is not derived by the
 * projection — it is the host's `approval.quorum_reached@1`, emitted by the one
 * component that held the operator-pinned approver keys *and* the approver
 * authority roster. The projection surfaces it verbatim rather than recomputing
 * it, which is the same boundary that keeps `pendingApprovals` from re-verifying
 * signatures.
 *
 * It is *checkable*, not merely assertable: each constituent carries the
 * `payload_hash` of the canonical resolution its approver signed and the
 * `granted_event_id` of the promoted grant, so a consumer holding its own pinned
 * keys can re-fetch every vote from the log and re-verify the claim rather than
 * trust the emitter.
 */
export interface QuorumRecord {
  project_id: string
  session_id: string
  request_id: string
  action_id: string
  /** The threshold that had to be met (always >= 2). */
  quorum: number
  /** The verified constituent votes, in the order they were counted. */
  approvals: QuorumApprovalRef[]
  /** When the threshold was satisfied. */
  at: string
  /** Envelope id of the `approval.quorum_reached@1` event itself. */
  event_id: string
}

/**
 * Derive the pending-approval queue from a flat event stream: every
 * `approval.requested@1` whose `request_id` has no matching
 * `approval.granted@1` / `approval.denied@1` / `approval.expired@1`.
 *
 * Read-only by construction — this surfaces *what is waiting*, never
 * resolves it. Resolution is the separate write-side surface (the
 * `lodestar approve` CLI, or a separate write-side product).
 */
export function pendingApprovals(events: EventEnvelope[]): PendingApproval[] {
  // The guard records every out-of-band resolution it refused to promote (a
  // forged / unsigned / tampered grant or deny whose Ed25519 signature did not
  // verify against the pinned approver keys, planted in the log or side-channel)
  // as a `guard.approval.signature_rejected` audit event. Such an
  // `approval.granted@1` / `approval.denied@1` is NOT a real resolution, so it
  // must not drop a still-held request from the queue. We exclude it *precisely*:
  //   - `source: "log"` rejections carry `rejected_event_id` (the forged log
  //     event's envelope id), so we exclude that one event and still honour a
  //     genuine grant the operator submits afterwards;
  //   - `source: "side_channel"` rejections promote no log event, so there is
  //     nothing to exclude;
  //   - a legacy rejection (no `source`/`rejected_event_id`) can't be tied to a
  //     specific event, so we fall back to the conservative, ungameable
  //     per-request exclusion (never resolve from a tainted request) — this keeps
  //     old logs from regressing the forged-grant-masks-a-pending-request bound.
  // The projection deliberately does NOT re-verify signatures — it has no access
  // to the operator's pinned approver keys (the correct boundary) — so it trusts
  // the guard's audit. Mirrors `collectResolvedRequestIds` in the approve CLI.
  const rejectedEventIds = new Set<string>()
  const conservativelyTaintedRequestIds = new Set<string>()
  for (const event of events) {
    if (event.type !== GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE) continue
    const payload = event.payload as
      | { request_id?: unknown; source?: unknown; rejected_event_id?: unknown }
      | undefined
    const rejectedId = payload?.rejected_event_id
    if (typeof rejectedId === "string" && rejectedId.length > 0) {
      rejectedEventIds.add(rejectedId)
    } else if (payload?.source === "side_channel") {
      // promotes no log event — nothing to exclude
    } else {
      const rid = payload?.request_id
      if (typeof rid === "string" && rid.length > 0) conservativelyTaintedRequestIds.add(rid)
    }
  }

  // Which requests carry a quorum, and what it is. This is what decides whether a
  // lone `approval.granted@1` resolves a request at all (ADR-0041): at the
  // single-approver threshold a grant IS the authorization, but at `quorum >= 2`
  // it is only ONE APPROVER'S VOTE and the request stays open until the
  // host-authored `approval.quorum_reached@1` lands. Without this split, a 3-of-3
  // hold would vanish from the queue on its first vote — the queue would report an
  // action as resolved while the kernel still had it parked.
  const quorumFor = new Map<string, number>()
  for (const event of events) {
    if (event.type !== APPROVAL_REQUESTED_EVENT_TYPE) continue
    const parsed = ApprovalRequestSchema.safeParse(event.payload)
    if (!parsed.success) continue
    if (parsed.data.quorum !== undefined) quorumFor.set(parsed.data.request_id, parsed.data.quorum)
  }

  const resolved = new Set<string>()
  // Advisory only: distinct approvers seen granting, per request. See
  // `PendingApproval.approvers_so_far` for why this can only ever overstate.
  const votesSeen = new Map<string, string[]>()
  for (const event of events) {
    const payload = event.payload as { request_id?: unknown; approver_id?: unknown } | undefined
    const requestId = payload?.request_id
    if (typeof requestId !== "string") continue
    if (event.type === APPROVAL_GRANTED_EVENT_TYPE || event.type === APPROVAL_DENIED_EVENT_TYPE) {
      // A grant/deny the guard rejected (this specific forged event, or — for a
      // legacy audit with no event id — any rejection for this request) is not a
      // real resolution.
      if (rejectedEventIds.has(event.id)) continue
      if (conservativelyTaintedRequestIds.has(requestId)) continue
      const quorum = quorumFor.get(requestId)
      if (quorum !== undefined && event.type === APPROVAL_GRANTED_EVENT_TYPE) {
        // One vote toward a threshold, not a resolution.
        const seen = votesSeen.get(requestId) ?? []
        const approverId = payload?.approver_id
        if (typeof approverId === "string" && !seen.includes(approverId)) seen.push(approverId)
        votesSeen.set(requestId, seen)
        continue
      }
      // A deny still resolves a quorum request: one valid deny is decisive
      // regardless of grants collected, so the host rejects the action on it.
      resolved.add(requestId)
    } else if (
      event.type === APPROVAL_EXPIRED_EVENT_TYPE ||
      event.type === APPROVAL_QUORUM_REACHED_EVENT_TYPE
    ) {
      // Both are host-authored and definitive: `approval.expired@1` is the
      // deadline terminal (which for a quorum request expires a *partially*
      // satisfied hold too), and `approval.quorum_reached@1` is the authorization.
      resolved.add(requestId)
    }
  }

  const pending: PendingApproval[] = []
  for (const event of events) {
    if (event.type !== APPROVAL_REQUESTED_EVENT_TYPE) continue
    const parsed = ApprovalRequestSchema.safeParse(event.payload)
    if (!parsed.success) continue
    const request = parsed.data
    if (resolved.has(request.request_id)) continue

    const item: PendingApproval = {
      project_id: event.project_id,
      session_id: event.session_id,
      request_id: request.request_id,
      action_id: request.action_id,
      reason: request.reason,
      required_authority: request.required_authority,
      requested_at: request.requested_at,
      status: "pending",
    }
    if (request.deadline !== undefined) item.deadline = request.deadline
    if (request.quorum !== undefined) {
      item.quorum = request.quorum
      item.approvers_so_far = votesSeen.get(request.request_id) ?? []
    }
    pending.push(item)
  }

  // Oldest request first — the queue head is what's been waiting longest.
  pending.sort((a, b) => a.requested_at.localeCompare(b.requested_at))
  return pending
}

/**
 * Project every `approval.quorum_reached@1` in the stream — the authoritative
 * record of a satisfied M-of-N threshold (ADR-0041), oldest first.
 *
 * Surfaced **verbatim**, not recomputed. The projection has no access to the
 * operator's pinned approver keys or approver authority roster (the correct
 * boundary — the same one that stops `pendingApprovals` re-verifying signatures),
 * so it cannot itself decide whether a set of grants meets a threshold. The
 * emitting host could, and did.
 *
 * That is not a request to trust the emitter blindly: each constituent names its
 * evidence (`payload_hash` + `granted_event_id`), so a consumer holding its own
 * pinned keys can re-fetch every vote from the same log and re-verify the claim.
 * The record makes the assertion *checkable*; it does not make it true.
 *
 * Schema-parsed on the way out, so the two structural invariants (at least
 * `quorum` approvals, all distinct) are re-checked here rather than assumed — a
 * malformed record is skipped, never surfaced as a partial quorum.
 */
export function quorumRecords(events: EventEnvelope[]): QuorumRecord[] {
  const records: QuorumRecord[] = []
  for (const event of events) {
    if (event.type !== APPROVAL_QUORUM_REACHED_EVENT_TYPE) continue
    const parsed = ApprovalQuorumReachedPayloadSchema.safeParse(event.payload)
    if (!parsed.success) continue
    const p = parsed.data
    records.push({
      project_id: event.project_id,
      session_id: event.session_id,
      request_id: p.request_id,
      action_id: p.action_id,
      quorum: p.quorum,
      approvals: p.approvals,
      at: p.at,
      event_id: event.id,
    })
  }
  records.sort((a, b) => a.at.localeCompare(b.at))
  return records
}
