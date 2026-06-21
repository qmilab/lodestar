import {
  APPROVAL_DENIED_EVENT_TYPE,
  APPROVAL_EXPIRED_EVENT_TYPE,
  APPROVAL_GRANTED_EVENT_TYPE,
  APPROVAL_REQUESTED_EVENT_TYPE,
  ApprovalRequestSchema,
  type EventEnvelope,
  GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE,
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

  const resolved = new Set<string>()
  for (const event of events) {
    const requestId = (event.payload as { request_id?: unknown } | undefined)?.request_id
    if (typeof requestId !== "string") continue
    if (event.type === APPROVAL_GRANTED_EVENT_TYPE || event.type === APPROVAL_DENIED_EVENT_TYPE) {
      // A grant/deny the guard rejected (this specific forged event, or — for a
      // legacy audit with no event id — any rejection for this request) is not a
      // real resolution.
      if (rejectedEventIds.has(event.id)) continue
      if (conservativelyTaintedRequestIds.has(requestId)) continue
      resolved.add(requestId)
    } else if (event.type === APPROVAL_EXPIRED_EVENT_TYPE) {
      // `approval.expired@1` is proxy-authored and always definitive.
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
    pending.push(item)
  }

  // Oldest request first — the queue head is what's been waiting longest.
  pending.sort((a, b) => a.requested_at.localeCompare(b.requested_at))
  return pending
}
