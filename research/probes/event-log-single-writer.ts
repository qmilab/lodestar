#!/usr/bin/env bun
/**
 * Probe: event_log_single_writer
 *
 * Verifies the Round 5 fix: concurrent `EventLogWriter.append()` calls
 * (within a single process, across multiple writer instances pointing
 * at the same partition) serialize through one logical writer.
 *
 * Pre-fix: two concurrent `appendFile` calls with payloads > PIPE_BUF
 * (~4 KiB on Linux) can interleave on disk and produce torn NDJSON
 * lines, breaking the reader's one-event-per-line invariant. The seq
 * counter was unique-across-instances via module state, but the disk
 * writes were not serialized.
 *
 * Approach chosen: single-process invariant via a per-partition async
 * mutex (`sharedAppendLocks`). Multiple writer instances at the same
 * partition share the queue; cross-process safety stays a Batch 3+
 * concern because the MCP proxy is single-process. See
 * `packages/event-log/CLAUDE.md` for the rationale and trade-offs.
 *
 * Pass conditions:
 *   1. No duplicate `seq` numbers
 *   2. Monotonic `seq` preserved (no gaps after sorting)
 *   3. Every line in the NDJSON file is a complete, parseable JSON
 *      envelope — no torn writes, even for payloads > 4 KiB
 *   4. Even with multiple writer instances and a high concurrency
 *      fan-out, the on-disk line count matches the number of appends
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
} from "@qmilab/lodestar-event-log"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT_ID = "probe-singlewriter-project"

// Payload that exceeds PIPE_BUF on Linux. Without serialization,
// concurrent appendFile calls of >4 KiB payloads can interleave on
// disk. With serialization, every line stays atomic.
const LARGE_PAYLOAD_FILLER = "x".repeat(8 * 1024) // 8 KiB

async function run(): Promise<ProbeResult> {
  _resetEventLogStateForTests()

  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-singlewriter-"))
  try {
    // Two writer instances pointing at the same root + project.
    // Both share module-level seq + the new mutex.
    const writerA = new EventLogWriter(logDir)
    const writerB = new EventLogWriter(logDir)

    const APPENDS_PER_WRITER = 50 // 100 appends total
    const sessionId = "probe-singlewriter-session"

    const enqueue = (writer: EventLogWriter, idx: number, source: "A" | "B") =>
      writer.append({
        id: `event-${source}-${idx}`,
        type: "probe.singlewriter",
        schema_version: "0.1.0",
        session_id: sessionId,
        project_id: PROJECT_ID,
        actor_id: "probe.singlewriter",
        timestamp: new Date().toISOString(),
        causal_parent_ids: [],
        payload: {
          source,
          idx,
          filler: LARGE_PAYLOAD_FILLER,
        },
        versions: {},
      })

    // Fan out all appends without sequential awaits — maximum
    // concurrency from a single event loop.
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < APPENDS_PER_WRITER; i++) {
      pending.push(enqueue(writerA, i, "A"))
      pending.push(enqueue(writerB, i, "B"))
    }
    await Promise.all(pending)

    // ── Check 1+2: monotonic seq via the reader's schema-validated path ──
    const reader = new EventLogReader(logDir)
    const envelopes = await reader.readAll(PROJECT_ID)

    if (envelopes.length !== pending.length) {
      return {
        passed: false,
        details:
          `Expected ${pending.length} envelopes from the reader, got ` +
          `${envelopes.length}. The reader either failed to parse some ` +
          `lines (torn writes?) or some appends were lost.`,
      }
    }

    const seqs = envelopes.map((e) => e.seq).sort((a, b) => a - b)
    const seqSet = new Set(seqs)
    if (seqSet.size !== seqs.length) {
      const dup = seqs.find((s, i) => i > 0 && s === seqs[i - 1])
      return {
        passed: false,
        details:
          `Duplicate seq detected (e.g. ${dup}). Module-level seq counter ` +
          `is not serialized correctly across writer instances.`,
      }
    }
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== i) {
        return {
          passed: false,
          details:
            `seq is not contiguous from 0. seqs[${i}] = ${seqs[i]}, ` +
            `expected ${i}. Some seq value was allocated but not written.`,
        }
      }
    }

    // ── Check 3: every NDJSON line is complete + parseable ──
    const files = (await readdir(join(logDir, PROJECT_ID))).filter((f) =>
      f.endsWith(".ndjson"),
    )
    if (files.length === 0) {
      return { passed: false, details: "No NDJSON file produced." }
    }

    let totalLines = 0
    let tornLines = 0
    let nonEnvelopeLines = 0
    for (const file of files) {
      const content = await readFile(join(logDir, PROJECT_ID, file), "utf8")
      const lines = content.split("\n").filter((l) => l.trim())
      for (const line of lines) {
        totalLines++
        try {
          const parsed = JSON.parse(line)
          if (
            typeof parsed.seq !== "number" ||
            typeof parsed.session_id !== "string" ||
            typeof parsed.id !== "string"
          ) {
            nonEnvelopeLines++
          }
        } catch {
          tornLines++
        }
      }
    }

    if (tornLines > 0) {
      return {
        passed: false,
        details:
          `Found ${tornLines} unparseable NDJSON line(s) out of ${totalLines}. ` +
          `Torn writes detected — the append serialization is not effective.`,
      }
    }
    if (nonEnvelopeLines > 0) {
      return {
        passed: false,
        details:
          `Found ${nonEnvelopeLines} parseable but non-envelope lines. ` +
          `Two writes likely interleaved into a single line that happened ` +
          `to JSON-parse.`,
      }
    }
    if (totalLines !== pending.length) {
      return {
        passed: false,
        details:
          `On-disk line count ${totalLines} ≠ appends ${pending.length}. ` +
          `Either a write was lost or two appends collapsed into one line.`,
      }
    }

    return {
      passed: true,
      details:
        `${pending.length} concurrent appends across 2 writer instances, ` +
        `large payloads (>${LARGE_PAYLOAD_FILLER.length} bytes/event). ` +
        `All persisted, unique contiguous seq 0..${seqs.length - 1}, ` +
        `every line a complete envelope. Per-partition append mutex ` +
        `serializes correctly under fan-out.`,
    }
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: event_log_single_writer")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
