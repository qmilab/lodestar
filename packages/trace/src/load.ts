import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { EventEnvelope } from "@orrery/core"
import { EventLogReader } from "@orrery/event-log"

/**
 * Locate the project directory under a log root that contains events
 * for the requested session, returning the first match.
 *
 * The event log root is laid out as `<root>/<project_id>/<YYYY-MM-DD>.ndjson`.
 * Callers usually know the project_id; when they don't, this helper scans
 * the root for any project whose log contains the session.
 */
export async function findProjectForSession(
  logRoot: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!existsSync(logRoot)) return undefined
  const entries = await readdir(logRoot, { withFileTypes: true })
  const reader = new EventLogReader(logRoot)
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue
    const events = await reader.readSession(dirent.name, sessionId)
    if (events.length > 0) return dirent.name
  }
  return undefined
}

/**
 * Read all events for a session from the standard log root, scanning
 * project directories if the project_id is not supplied.
 */
export async function loadSessionEvents(input: {
  logRoot: string
  session_id: string
  project_id?: string
}): Promise<{ project_id: string; events: EventEnvelope[] }> {
  const reader = new EventLogReader(input.logRoot)
  let projectId = input.project_id
  if (!projectId) {
    projectId = await findProjectForSession(input.logRoot, input.session_id)
  }
  if (!projectId) {
    return { project_id: "", events: [] }
  }
  const events = await reader.readSession(projectId, input.session_id)
  return { project_id: projectId, events }
}

/**
 * Default log root: `<cwd>/.orrery/events`. Centralised so the CLI and
 * the example use the same convention.
 */
export function defaultLogRoot(cwd: string = process.cwd()): string {
  return join(cwd, ".orrery", "events")
}
