import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { type EventEnvelope, EventEnvelopeSchema } from "@qmilab/lodestar-core"

/**
 * Reader over the NDJSON event log.
 *
 * v0: simple sequential reads. v0.2 will add indexed reads, time-range
 * queries, and projection (read only certain event types).
 */
export class EventLogReader {
  constructor(private readonly rootDir: string) {}

  /**
   * Read all events for a project, in seq order.
   */
  async readAll(projectId: string): Promise<EventEnvelope[]> {
    const projectDir = join(this.rootDir, projectId)
    if (!existsSync(projectDir)) return []

    const files = (await readdir(projectDir)).filter((f) => f.endsWith(".ndjson")).sort()

    const events: EventEnvelope[] = []
    for (const file of files) {
      const content = await readFile(join(projectDir, file), "utf8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line)
        events.push(EventEnvelopeSchema.parse(parsed))
      }
    }
    events.sort((a, b) => a.seq - b.seq)
    return events
  }

  /**
   * Read events for a specific session, in logical_clock order.
   */
  async readSession(projectId: string, sessionId: string): Promise<EventEnvelope[]> {
    const all = await this.readAll(projectId)
    return all
      .filter((e) => e.session_id === sessionId)
      .sort((a, b) => a.logical_clock - b.logical_clock)
  }
}
