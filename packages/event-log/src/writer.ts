import { mkdir, appendFile, readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { type EventEnvelope, EventEnvelopeSchema } from "@qmilab/lodestar-core"

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
 * v0: process-local writer with module-scoped partition state. Two
 * EventLogWriter instances pointing at the same `rootDir`/`project_id`
 * share the same hydration and seq counter — necessary for
 * `runGuarded`-per-session use cases where multiple writer instances
 * live in the same process. Cross-process safety (file locking) is a
 * Batch 3 concern.
 */

// ── Process-wide partition state ───────────────────────────────────────────
// Keyed by `${rootDir}::${project_id}` so writers pointed at different
// root dirs (e.g. tests with isolated log directories) stay independent
// while writers sharing the same physical log share their counters.

const sharedHydrations = new Map<string, Promise<void>>()
const sharedNextSeq = new Map<string, number>()
const sharedNextLogicalClock = new Map<string, number>()

function partitionKey(rootDir: string, projectId: string): string {
  return `${rootDir}::${projectId}`
}

function sessionKey(rootDir: string, sessionId: string): string {
  return `${rootDir}::${sessionId}`
}

/**
 * Reset the module-level writer state. For tests/probes that need
 * isolation between scenarios. Not part of the public API.
 */
export function _resetEventLogStateForTests(): void {
  sharedHydrations.clear()
  sharedNextSeq.clear()
  sharedNextLogicalClock.clear()
}

export class EventLogWriter {
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
   * Concurrent first appends for the same project all await the same
   * in-flight scan; without this, two appends could both see an
   * empty seq map and allocate `seq=0` simultaneously, breaking the
   * monotonic-ordering invariant.
   *
   * Tolerant: malformed lines are skipped. The goal is not to validate
   * the log (the reader does that) — only to find a safe starting
   * sequence number. If the project directory doesn't exist or is
   * empty, the maps stay at their defaults (seq starts at 0).
   */
  private hydrate(projectId: string): Promise<void> {
    const key = partitionKey(this.rootDir, projectId)
    const existing = sharedHydrations.get(key)
    if (existing) return existing
    const promise = this.scanForHydration(projectId, key)
    sharedHydrations.set(key, promise)
    return promise
  }

  private async scanForHydration(projectId: string, key: string): Promise<void> {
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

    // Only raise the shared counters — never lower them. A concurrent
    // writer may have already started allocating from a higher base,
    // and that higher value reflects the true tip of the log.
    if (maxSeq >= 0) {
      const current = sharedNextSeq.get(key) ?? 0
      if (maxSeq + 1 > current) {
        sharedNextSeq.set(key, maxSeq + 1)
      }
    }
    for (const [sessionId, value] of sessionMax.entries()) {
      const sk = sessionKey(this.rootDir, sessionId)
      const current = sharedNextLogicalClock.get(sk) ?? 0
      if (value + 1 > current) {
        sharedNextLogicalClock.set(sk, value + 1)
      }
    }
  }

  private advanceSeq(projectId: string): number {
    const key = partitionKey(this.rootDir, projectId)
    const current = sharedNextSeq.get(key) ?? 0
    sharedNextSeq.set(key, current + 1)
    return current
  }

  private advanceLogicalClock(sessionId: string): number {
    const key = sessionKey(this.rootDir, sessionId)
    const current = sharedNextLogicalClock.get(key) ?? 0
    sharedNextLogicalClock.set(key, current + 1)
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
