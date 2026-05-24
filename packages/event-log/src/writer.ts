import { mkdir, appendFile, readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { type EventEnvelope, EventEnvelopeSchema } from "@orrery/core"

/**
 * Append-only NDJSON event log.
 *
 * - One file per (project_id, day).
 * - Lines are valid JSON; the file as a whole is NDJSON.
 * - The writer maintains a monotonic `seq` per project partition,
 *   loaded from the most recent file on first write.
 * - Payload hash is computed by the writer if not supplied; the
 *   serialized payload is hashed canonically (sorted keys).
 *
 * v0: process-local writer with a single in-memory partition state.
 * Multi-process safety is a v0.2 concern (file locking, advisory
 * sequence reservation).
 */
export class EventLogWriter {
  private nextSeq: Map<string, number> = new Map()
  private nextLogicalClock: Map<string, number> = new Map()
  /** Project ids whose on-disk state has been scanned into the seq map. */
  private hydrated: Set<string> = new Set()

  constructor(private readonly rootDir: string) {}

  async append(input: Omit<EventEnvelope, "seq" | "logical_clock" | "payload_hash"> & {
    seq?: number
    logical_clock?: number
    payload_hash?: string
  }): Promise<EventEnvelope> {
    // Hydrate the per-project sequence + per-session logical clock from
    // disk the first time we see a project_id in this process. Without
    // this, a second `EventLogWriter` instance writing to a project
    // whose NDJSON files already contain `seq: 0, 1, …` would restart
    // at 0 and produce duplicate sequence numbers, breaking
    // `EventLogReader.readAll`'s monotonic ordering invariant. Two
    // common ways to land here:
    //  - long-running process that creates a new writer per session
    //  - `runGuarded` / `runGuarded` chained for the same project_id
    await this.hydrate(input.project_id)

    const seq = input.seq ?? this.advanceSeq(input.project_id)
    const logical_clock = input.logical_clock ?? this.advanceLogicalClock(input.session_id)
    const payload_hash = input.payload_hash ?? canonicalHash(input.payload)

    const envelope: EventEnvelope = {
      ...input,
      seq,
      logical_clock,
      payload_hash,
    }

    // Validate before write — never write malformed events
    const validated = EventEnvelopeSchema.parse(envelope)

    const path = this.filePathFor(validated)
    if (!existsSync(dirname(path))) {
      await mkdir(dirname(path), { recursive: true })
    }
    await appendFile(path, `${JSON.stringify(validated)}\n`, "utf8")

    return validated
  }

  /**
   * Scan existing NDJSON files for a project and seed `nextSeq` /
   * `nextLogicalClock` from the highest values found. Runs at most
   * once per project per writer instance.
   *
   * Tolerant: malformed lines are skipped. The goal is not to validate
   * the log (the reader does that) — only to find a safe starting
   * sequence number. If the project directory doesn't exist or is
   * empty, the maps stay at their defaults (seq starts at 0).
   */
  private async hydrate(projectId: string): Promise<void> {
    if (this.hydrated.has(projectId)) return
    this.hydrated.add(projectId)

    const projectDir = join(this.rootDir, projectId)
    if (!existsSync(projectDir)) return

    let maxSeq = -1
    const sessionMax = new Map<string, number>()

    const files = (await readdir(projectDir))
      .filter((f) => f.endsWith(".ndjson"))
      .sort()
    for (const file of files) {
      const content = await readFile(join(projectDir, file), "utf8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        let parsed: { seq?: unknown; logical_clock?: unknown; session_id?: unknown }
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof parsed.seq === "number" && parsed.seq > maxSeq) {
          maxSeq = parsed.seq
        }
        if (
          typeof parsed.session_id === "string" &&
          typeof parsed.logical_clock === "number"
        ) {
          const current = sessionMax.get(parsed.session_id) ?? -1
          if (parsed.logical_clock > current) {
            sessionMax.set(parsed.session_id, parsed.logical_clock)
          }
        }
      }
    }

    if (maxSeq >= 0) {
      this.nextSeq.set(projectId, maxSeq + 1)
    }
    for (const [sessionId, value] of sessionMax.entries()) {
      this.nextLogicalClock.set(sessionId, value + 1)
    }
  }

  private advanceSeq(projectId: string): number {
    const current = this.nextSeq.get(projectId) ?? 0
    this.nextSeq.set(projectId, current + 1)
    return current
  }

  private advanceLogicalClock(sessionId: string): number {
    const current = this.nextLogicalClock.get(sessionId) ?? 0
    this.nextLogicalClock.set(sessionId, current + 1)
    return current
  }

  private filePathFor(envelope: EventEnvelope): string {
    const day = envelope.timestamp.slice(0, 10) // YYYY-MM-DD
    return join(this.rootDir, envelope.project_id, `${day}.ndjson`)
  }
}

/**
 * Canonical sha-256 hash of a value with sorted object keys.
 *
 * Used by the writer when the caller does not supply payload_hash.
 * Replay-safe: identical payloads produce identical hashes regardless
 * of key insertion order.
 */
export function canonicalHash(value: unknown): string {
  const canonical = stringifyCanonical(value)
  return createHash("sha256").update(canonical).digest("hex")
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonical).join(",")}]`
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const entries = keys.map((k) =>
      `${JSON.stringify(k)}:${stringifyCanonical((value as Record<string, unknown>)[k])}`,
    )
    return `{${entries.join(",")}}`
  }
  // undefined, function, etc.
  return "null"
}
