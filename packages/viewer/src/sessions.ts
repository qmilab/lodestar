import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import type { EventEnvelope } from "@qmilab/lodestar-core"
import { EventLogReader } from "@qmilab/lodestar-event-log"

// `pendingApprovals` + `PendingApproval` graduated to @qmilab/lodestar-trace
// (issue #138) — a pure projection in the same family as `projectChain`,
// so a read-side consumer need not depend on the viewer's HTTP server.
// Re-exported here unchanged for source compatibility.
export { pendingApprovals } from "@qmilab/lodestar-trace"
export type { PendingApproval } from "@qmilab/lodestar-trace"

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
