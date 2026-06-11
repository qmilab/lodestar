import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import {
  APPROVAL_DENIED_EVENT_TYPE,
  APPROVAL_EXPIRED_EVENT_TYPE,
  APPROVAL_GRANTED_EVENT_TYPE,
  APPROVAL_REQUESTED_EVENT_TYPE,
  ApprovalRequestSchema,
  type EventEnvelope,
} from "@qmilab/lodestar-core"
import { EventLogReader } from "@qmilab/lodestar-event-log"

/**
 * Read-side enumeration over the event log: list the sessions present and
 * derive the pending-approval queue. Pure reads — nothing here writes the
 * log.
 *
 * The event log is laid out as `<root>/<project_id>/<YYYY-MM-DD>.ndjson`
 * (see `@qmilab/lodestar-event-log`). v0 has no index, so listing reads
 * each project's log in full — fine for local logs, the same whole-log
 * scan `findProjectForSession` already does in `@qmilab/lodestar-trace`.
 */

export interface SessionSummary {
  project_id: string
  session_id: string
  event_count: number
  first_event_at?: string
  last_event_at?: string
  actor_ids: string[]
}

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

/** List every `(project_id, session_id)` present under the log root. */
export async function listSessions(logRoot: string): Promise<SessionSummary[]> {
  if (!existsSync(logRoot)) return []
  const entries = await readdir(logRoot, { withFileTypes: true })
  const reader = new EventLogReader(logRoot)
  const summaries: SessionSummary[] = []

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue
    const projectId = dirent.name
    let events: EventEnvelope[]
    try {
      events = await reader.readAll(projectId)
    } catch {
      continue // tolerate a project dir that isn't a readable log
    }

    const bySession = new Map<string, EventEnvelope[]>()
    for (const event of events) {
      const list = bySession.get(event.session_id)
      if (list) list.push(event)
      else bySession.set(event.session_id, [event])
    }

    for (const [sessionId, sessionEvents] of bySession) {
      const ordered = [...sessionEvents].sort((a, b) => a.logical_clock - b.logical_clock)
      const actorIds = new Set<string>()
      for (const event of ordered) actorIds.add(event.actor_id)
      const first = ordered[0]
      const last = ordered[ordered.length - 1]
      const summary: SessionSummary = {
        project_id: projectId,
        session_id: sessionId,
        event_count: ordered.length,
        actor_ids: [...actorIds],
      }
      if (first) summary.first_event_at = first.timestamp
      if (last) summary.last_event_at = last.timestamp
      summaries.push(summary)
    }
  }

  // Most-recently-active session first.
  summaries.sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""))
  return summaries
}

/** Read every event under the log root, across all projects. */
export async function readAllEvents(logRoot: string): Promise<EventEnvelope[]> {
  if (!existsSync(logRoot)) return []
  const entries = await readdir(logRoot, { withFileTypes: true })
  const reader = new EventLogReader(logRoot)
  const all: EventEnvelope[] = []
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue
    try {
      all.push(...(await reader.readAll(dirent.name)))
    } catch {
      // skip unreadable project dirs
    }
  }
  return all
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
  const resolved = new Set<string>()
  for (const event of events) {
    if (
      event.type === APPROVAL_GRANTED_EVENT_TYPE ||
      event.type === APPROVAL_DENIED_EVENT_TYPE ||
      event.type === APPROVAL_EXPIRED_EVENT_TYPE
    ) {
      const requestId = (event.payload as { request_id?: unknown } | undefined)?.request_id
      if (typeof requestId === "string") resolved.add(requestId)
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
