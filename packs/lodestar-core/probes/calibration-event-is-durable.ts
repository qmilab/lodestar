#!/usr/bin/env bun
/**
 * Probe: calibration_event_is_durable
 *
 * The forcing function for the durable `calibration.computed@1` event
 * (ADR-0011 — P3 slice 2). The `confidence-drift` probe proves the
 * Calibrator *measures* correctly; this one proves a measurement can be
 * *recorded* as a governed chain event without the Calibrator ever growing
 * a write path — so calibration drift becomes auditable and replayable, the
 * way a probe run or a sentinel finding already is.
 *
 * The invariants, exercised over a real NDJSON log written through
 * `EventLogWriter` and read back through `EventLogReader` (the same I/O path
 * the sibling probes use):
 *
 *   1. MEASURE ≠ WRITE — running `calibrate()` over the log writes nothing.
 *      The count of `calibration.computed` events is 0 before AND after the
 *      pure measurement; it becomes 1 only after the explicit publish step
 *      (`eventLogCalibrationSink`). This is harness invariant 11 in force:
 *      the Calibrator is return-value-only; emission is a separate step.
 *
 *   2. DURABLE + WELL-FORMED — the emitted event is a single
 *      `calibration.computed@1` envelope whose payload validates against the
 *      core `CalibrationComputedPayloadSchema`, and whose verdict carries the
 *      flagged class. The agent's miscalibration is now on the record.
 *
 *   3. TAMPER-EVIDENT — the persisted `payload_hash` equals
 *      `canonicalHash(payload)` recomputed after the JSON round-trip. The
 *      event inherits the log's canonical-hash tamper-evidence (no separate
 *      signature in v0 — see ADR-0011).
 *
 *   4. REPLAYABLE — re-running `calibrate()` over exactly the events in the
 *      recorded `cursor` window `(from_seq, to_seq]` reproduces the persisted
 *      verdict (same flagged classes, same flagged-class metrics). The cursor
 *      is a faithful replay key: drift recorded today can be recomputed and
 *      diffed tomorrow.
 *
 *   5. HONEST WINDOW — that replay key is only honest if the window is valid
 *      AND consistent with the report. An inverted cursor (`to_seq < from_seq`)
 *      is rejected; and empty window ⟺ zero samples is enforced at the payload
 *      boundary, so an empty window carrying a populated report (it replays to
 *      nothing) and a populated window carrying a zero-sample report are both
 *      rejected — only the matched pairs validate.
 *
 * What the probe deliberately does NOT assert:
 *
 *   - That any action was held or any belief downweighted. Recording a
 *     calibration verdict does not enforce it — the Policy Kernel's arbitrate
 *     hook reads an in-process `CalibrationReport` snapshot, not this event
 *     (see `calibration-flag-escalates-action`). This event is audit/replay,
 *     not a runtime intercept. Same line `confidence-drift` draws.
 *
 * Design lock: `docs/architecture/calibrator.md`, ADR-0011.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CALIBRATION_COMPUTED_EVENT_TYPE,
  CALIBRATION_COMPUTED_SCHEMA_VERSION,
  CalibrationComputedPayloadSchema,
  type EventEnvelope,
} from "@qmilab/lodestar-core"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import {
  type BuildCalibrationComputedInput,
  buildCalibrationComputedPayload,
  calibrate,
  calibrationCursor,
  eventLogCalibrationSink,
} from "@qmilab/lodestar-harness"

interface ProbeResult {
  passed: boolean
  details: string[]
}

const PROJECT_ID = "probe-project-calibration-durable-4b2c"
const SESSION_ID = "probe-session-calibration-durable-8e7d"
const ACTOR_ID = "agent:probe-calibration-durable"
const TS = "2026-06-07T12:00:00.000Z"
const COMPUTED_AT = "2026-06-07T12:05:00.000Z"

// Overconfident class: 6 failing actions @0.92 — ≥ min_samples (5), so flagged.
const DRIFT_CLASS = "payments-api-shape"
const DRIFT_CONFIDENCE = 0.92
const DRIFT_FAILURES = 6

let evCounter = 0
const nextId = (prefix: string): string => {
  evCounter += 1
  return `${prefix}-${evCounter}`
}

async function append(writer: EventLogWriter, type: string, payload: unknown): Promise<void> {
  await writer.append({
    id: nextId("ev"),
    type,
    schema_version: "0.1.0",
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    actor_id: ACTOR_ID,
    timestamp: TS,
    causal_parent_ids: [],
    payload,
    versions: {},
  })
}

/** One belief @`confidence`, leaned on across `results.length` actions. */
async function driftSequence(
  writer: EventLogWriter,
  calibration_class: string,
  confidence: number,
  results: boolean[],
): Promise<void> {
  const beliefId = nextId("belief")
  await append(writer, "belief.adopted", {
    id: beliefId,
    confidence,
    calibration_class,
    authority: "inferred",
    truth_status: "unverified",
  })
  for (const ok of results) {
    const decisionId = nextId("decision")
    const actionId = nextId("action")
    await append(writer, "decision.made", { id: decisionId, belief_dependencies: [beliefId] })
    await append(writer, ok ? "action.completed" : "action.failed", {
      id: actionId,
      decision_id: decisionId,
      phase: ok ? "completed" : "failed",
    })
  }
}

const countCalibrationEvents = (events: EventEnvelope[]): number =>
  events.filter((e) => e.type === CALIBRATION_COMPUTED_EVENT_TYPE).length

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps

async function run(): Promise<ProbeResult> {
  _resetEventLogStateForTests()
  const details: string[] = []
  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-calibration-durable-"))

  try {
    const writer = new EventLogWriter(logDir)
    await driftSequence(writer, DRIFT_CLASS, DRIFT_CONFIDENCE, arrayOf(DRIFT_FAILURES, false))

    const reader = new EventLogReader(logDir)
    const events0 = await reader.readSession(PROJECT_ID, SESSION_ID)
    if (events0.length === 0) {
      return { passed: false, details: ["event log read back empty — nothing was written"] }
    }
    const fixtureCount = events0.length
    details.push(`wrote and replayed ${fixtureCount} fixture events from a real NDJSON log`)

    // ── Assertion 1a: no calibration event exists before measuring. ──────
    if (countCalibrationEvents(events0) !== 0) {
      return { passed: false, details: [...details, "a calibration event existed before any run."] }
    }

    // ── Measure (pure). ──────────────────────────────────────────────────
    const report = calibrate(events0)
    if (!report.flagged_classes.includes(DRIFT_CLASS)) {
      return {
        passed: false,
        details: [
          ...details,
          `fixture should flag '${DRIFT_CLASS}' so the recorded verdict is non-trivial; flagged: [${report.flagged_classes.join(", ")}].`,
        ],
      }
    }

    // ── Assertion 1b: measuring wrote nothing (harness invariant 11). ────
    const eventsAfterMeasure = await reader.readSession(PROJECT_ID, SESSION_ID)
    if (eventsAfterMeasure.length !== fixtureCount || countCalibrationEvents(eventsAfterMeasure)) {
      return {
        passed: false,
        details: [
          ...details,
          `calibrate() wrote to the log (was ${fixtureCount} events, now ${eventsAfterMeasure.length}). The Calibrator must be return-value-only.`,
        ],
      }
    }
    details.push("measure ≠ write: calibrate() flagged the class and wrote zero events")

    // ── Publish step: the separate, explicit emit. ───────────────────────
    const cursor = calibrationCursor(events0)
    const payload = buildCalibrationComputedPayload({
      report,
      cursor,
      computed_at: COMPUTED_AT,
      triggered_by: "programmatic",
      computation_id: "calib-probe-0001",
    })
    // Highest-seq fixture event = the "computed as of" anchor (reduce on a
    // non-empty array narrows away `undefined`, unlike an index access).
    const anchor = events0.reduce((a, b) => (b.seq > a.seq ? b : a))
    const sink = eventLogCalibrationSink({ root: logDir })
    const emittedId = await sink({
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      payload,
      causal_parent_ids: [anchor.id],
    })

    // ── Assertion 2: exactly one well-formed calibration.computed@1. ─────
    const events1 = await reader.readSession(PROJECT_ID, SESSION_ID)
    const calibEvents = events1.filter((e) => e.type === CALIBRATION_COMPUTED_EVENT_TYPE)
    if (calibEvents.length !== 1) {
      return {
        passed: false,
        details: [...details, `expected exactly 1 calibration event, found ${calibEvents.length}.`],
      }
    }
    const calibEvent = calibEvents[0]
    if (!calibEvent) {
      return { passed: false, details: [...details, "calibration event vanished on read-back."] }
    }
    if (calibEvent.id !== emittedId) {
      return {
        passed: false,
        details: [...details, "emitted id does not match the read-back event."],
      }
    }
    if (calibEvent.schema_version !== CALIBRATION_COMPUTED_SCHEMA_VERSION) {
      return {
        passed: false,
        details: [
          ...details,
          `schema_version ${calibEvent.schema_version}, expected ${CALIBRATION_COMPUTED_SCHEMA_VERSION}.`,
        ],
      }
    }
    const parsed = CalibrationComputedPayloadSchema.safeParse(calibEvent.payload)
    if (!parsed.success) {
      return {
        passed: false,
        details: [
          ...details,
          `persisted payload failed schema validation: ${parsed.error.message}`,
        ],
      }
    }
    const persisted = parsed.data
    if (!persisted.report.flagged_classes.includes(DRIFT_CLASS)) {
      return {
        passed: false,
        details: [...details, `persisted verdict lost the flagged class '${DRIFT_CLASS}'.`],
      }
    }
    details.push(
      `durable: 1 calibration.computed@1 (${persisted.computation_id}) carrying the flagged verdict`,
    )

    // ── Assertion 3: tamper-evident across the JSON round-trip. ──────────
    const recomputed = canonicalHash(calibEvent.payload)
    if (calibEvent.payload_hash !== recomputed) {
      return {
        passed: false,
        details: [
          ...details,
          `payload_hash diverged after round-trip: stored ${calibEvent.payload_hash.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}….`,
        ],
      }
    }
    details.push("tamper-evident: stored payload_hash equals the recomputed canonical hash")

    // ── Assertion 4: replayable from the recorded cursor window. ─────────
    const inWindow = events1.filter(
      (e) => e.seq > persisted.cursor.from_seq && e.seq <= persisted.cursor.to_seq,
    )
    // The window must re-select exactly the fixture events — not the
    // calibration event itself (appended after to_seq).
    if (inWindow.length !== fixtureCount || countCalibrationEvents(inWindow) !== 0) {
      return {
        passed: false,
        details: [
          ...details,
          `cursor window (${persisted.cursor.from_seq}, ${persisted.cursor.to_seq}] selected ${inWindow.length} events, expected the ${fixtureCount} fixture events.`,
        ],
      }
    }
    const replay = calibrate(inWindow)
    if (replay.flagged_classes.join("|") !== persisted.report.flagged_classes.join("|")) {
      return {
        passed: false,
        details: [
          ...details,
          `replay flagged [${replay.flagged_classes.join(", ")}] ≠ persisted [${persisted.report.flagged_classes.join(", ")}].`,
        ],
      }
    }
    const persistedDrift = persisted.report.classes.find((c) => c.calibration_class === DRIFT_CLASS)
    const replayDrift = replay.classes.find((c) => c.calibration_class === DRIFT_CLASS)
    if (
      !persistedDrift ||
      !replayDrift ||
      !close(persistedDrift.metrics.calibration_gap, replayDrift.metrics.calibration_gap) ||
      !close(persistedDrift.metrics.ece, replayDrift.metrics.ece) ||
      persistedDrift.metrics.n !== replayDrift.metrics.n
    ) {
      return {
        passed: false,
        details: [...details, "replayed metrics diverged from the persisted verdict."],
      }
    }
    details.push(
      `replayable: re-running calibrate over (${persisted.cursor.from_seq}, ${persisted.cursor.to_seq}] reproduced the verdict`,
    )

    // ── Assertion 5: the recorded cursor must be an honest replay key. ───
    // (a) An inverted window selects no events; reject it. (b) Empty window
    // ⟺ zero samples: an empty window `(n, n]` carrying a populated report
    // can't be replayed (it yields nothing), and a populated window carrying
    // a zero-sample report is equally inconsistent. Only the matched pairs —
    // populated window + samples, or empty window + zero samples — are honest.
    const rejects = (input: BuildCalibrationComputedInput): boolean => {
      try {
        buildCalibrationComputedPayload(input)
        return false
      } catch {
        return true
      }
    }
    const emptyReport = calibrate([]) // sample_count 0, no classes
    const edgeCases: Array<{
      name: string
      input: BuildCalibrationComputedInput
      mustReject: boolean
    }> = [
      {
        name: "inverted window",
        input: { report, cursor: { from_seq: 5, to_seq: 2 }, computed_at: COMPUTED_AT },
        mustReject: true,
      },
      {
        name: "empty window with a populated report (non-replayable)",
        input: { report, cursor: { from_seq: 3, to_seq: 3 }, computed_at: COMPUTED_AT },
        mustReject: true,
      },
      {
        name: "populated window with a zero-sample report (inconsistent)",
        input: {
          report: emptyReport,
          cursor: { from_seq: -1, to_seq: 5 },
          computed_at: COMPUTED_AT,
        },
        mustReject: true,
      },
      {
        name: "empty window with a zero-sample report (honest empty pass)",
        input: {
          report: emptyReport,
          cursor: { from_seq: -1, to_seq: -1 },
          computed_at: COMPUTED_AT,
        },
        mustReject: false,
      },
      {
        name: "populated window with samples (the real pass)",
        input: { report, cursor, computed_at: COMPUTED_AT },
        mustReject: false,
      },
    ]
    for (const c of edgeCases) {
      if (rejects(c.input) !== c.mustReject) {
        return {
          passed: false,
          details: [
            ...details,
            `cursor/report consistency: '${c.name}' should ${c.mustReject ? "be rejected" : "be accepted"} but was not.`,
          ],
        }
      }
    }
    details.push(
      "cursor invariant held: inverted rejected, empty window ⟺ zero samples enforced (5 edge cases)",
    )

    return { passed: true, details }
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

function arrayOf(n: number, value: boolean): boolean[] {
  return Array.from({ length: n }, () => value)
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: calibration_event_is_durable")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
