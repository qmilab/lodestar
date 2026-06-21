import {
  APPROVAL_DENIED_EVENT_TYPE,
  APPROVAL_EXPIRED_EVENT_TYPE,
  APPROVAL_GRANTED_EVENT_TYPE,
  APPROVAL_REQUESTED_EVENT_TYPE,
  ApprovalRequestSchema,
  type EventEnvelope,
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
  // request_ids the guard refused to promote because the resolution's signature
  // did not verify against the pinned approver keys (a forged / unsigned /
  // tampered / unpinned-signer grant or deny a local writer planted in the log
  // or side-channel). Such an `approval.granted@1` / `approval.denied@1` is NOT a
  // real resolution — the action stays held so an operator can still submit a
  // valid signed grant. Excluding these keeps a forgery from dropping a
  // genuinely-pending request out of the queue (mirrors `collectResolvedRequestIds`
  // in the `lodestar approve` CLI).
  const signatureRejected = new Set<string>()
  for (const event of events) {
    if (event.type !== "guard.approval.signature_rejected") continue
    const requestId = (event.payload as { request_id?: unknown } | undefined)?.request_id
    if (typeof requestId === "string" && requestId.length > 0) signatureRejected.add(requestId)
  }

  const resolved = new Set<string>()
  for (const event of events) {
    const requestId = (event.payload as { request_id?: unknown } | undefined)?.request_id
    if (typeof requestId !== "string") continue
    if (event.type === APPROVAL_GRANTED_EVENT_TYPE || event.type === APPROVAL_DENIED_EVENT_TYPE) {
      // A grant/deny the guard signature-rejected is not terminal — skip it.
      if (!signatureRejected.has(requestId)) resolved.add(requestId)
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
