import { randomUUID } from "node:crypto"
import {
  CALIBRATION_COMPUTED_EVENT_TYPE,
  CALIBRATION_COMPUTED_SCHEMA_VERSION,
  type CalibrationComputedPayload,
  CalibrationComputedPayloadSchema,
  type CalibrationCursor,
  type CalibrationReport,
  type CalibrationTrigger,
  type EventEnvelope,
} from "@qmilab/lodestar-core"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"

/**
 * Recording a calibration pass as a `calibration.computed@1` event.
 *
 * This is the **separate publish step** that keeps the Calibrator
 * measure-only (harness invariant 11): `calibrate()` returns a
 * `CalibrationReport` and never writes; a host that wants the verdict
 * durable hands the report to {@link buildCalibrationComputedPayload} and
 * appends it through {@link eventLogCalibrationSink}. Mirrors the sentinel
 * split exactly — a `Sentinel` returns findings; `eventLogAlertSink` writes
 * them — so the event-log I/O lives in one injected place and the runner /
 * calibrator core stay I/O-free. Design lock: `docs/architecture/calibrator.md`,
 * ADR-0011.
 */

/**
 * Derive the replay cursor for a set of events the calibration was computed
 * over. `from_seq` is the exclusive lower bound (lowest seq − 1, so the
 * window `(from_seq, to_seq]` contains exactly these events); `to_seq` is the
 * inclusive highest seq. An empty input yields `{ from_seq: -1, to_seq: -1 }`
 * — the pass ran but observed nothing.
 */
export function calibrationCursor(events: readonly EventEnvelope[]): CalibrationCursor {
  if (events.length === 0) return { from_seq: -1, to_seq: -1 }
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const e of events) {
    if (e.seq < min) min = e.seq
    if (e.seq > max) max = e.seq
  }
  // seq is a non-negative integer, so `min - 1 >= -1` always holds.
  return { from_seq: min - 1, to_seq: max }
}

export interface BuildCalibrationComputedInput {
  /** The verdict produced by `calibrate()`. */
  report: CalibrationReport
  /** The seq window the report was computed over (see {@link calibrationCursor}). */
  cursor: CalibrationCursor
  /** Wall-clock timestamp of the pass. Injected — the calibrator has no clock. */
  computed_at: string
  /** What invoked the pass. Defaults to `programmatic`. */
  triggered_by?: CalibrationTrigger
  /** Stable id for the pass. Defaults to a fresh UUID. */
  computation_id?: string
}

/**
 * Assemble and validate a `calibration.computed@1` payload from a report.
 * Pure — no I/O, no clock (the caller supplies `computed_at`). Validation
 * at the boundary means a malformed report surfaces here, not on the wire.
 */
export function buildCalibrationComputedPayload(
  input: BuildCalibrationComputedInput,
): CalibrationComputedPayload {
  return CalibrationComputedPayloadSchema.parse({
    computation_id: input.computation_id ?? randomUUID(),
    triggered_by: input.triggered_by ?? "programmatic",
    cursor: input.cursor,
    report: input.report,
    computed_at: input.computed_at,
  })
}

/** A calibration event ready to land in a partition/session slice. */
export interface CalibrationComputedEvent {
  project_id: string
  session_id: string
  payload: CalibrationComputedPayload
  /** Events that fed the calibration; become the envelope's causal parents. */
  causal_parent_ids?: string[]
}

/** Appends one `calibration.computed@1` event and returns its envelope id. */
export type CalibrationEventSink = (event: CalibrationComputedEvent) => Promise<string>

export interface EventLogCalibrationSinkConfig {
  /** Event-log root directory (the `.lodestar/events` convention). */
  root: string
  /**
   * `actor_id` for emitted calibration envelopes. Defaults to the harness
   * calibrator identity — a calibration verdict is neither a human nor an
   * agent action.
   */
  actor_id?: string
}

export const DEFAULT_CALIBRATOR_ACTOR = "lodestar-calibrator"

/**
 * Build a {@link CalibrationEventSink} that appends one
 * `calibration.computed@1` event per pass to the NDJSON event log.
 *
 * Mirrors `eventLogAlertSink` / `eventLogRecorder`: the harness owns
 * event-log I/O (per the package CLAUDE.md), so callers stay I/O-free and
 * receive this sink by injection. The payload's `computed_at` is the
 * envelope timestamp; the events the calibration read become the envelope's
 * `causal_parent_ids`, so `lodestar report` can walk from a verdict back to
 * the slice it scored.
 */
export function eventLogCalibrationSink(
  config: EventLogCalibrationSinkConfig,
): CalibrationEventSink {
  const writer = new EventLogWriter(config.root)
  const actorId = config.actor_id ?? DEFAULT_CALIBRATOR_ACTOR
  return async (event: CalibrationComputedEvent) => {
    // Re-validate at the sink boundary: a caller may have hand-built the
    // payload rather than going through buildCalibrationComputedPayload.
    const payload = CalibrationComputedPayloadSchema.parse(event.payload)
    const envelope = await writer.append({
      id: randomUUID(),
      type: CALIBRATION_COMPUTED_EVENT_TYPE,
      schema_version: CALIBRATION_COMPUTED_SCHEMA_VERSION,
      project_id: event.project_id,
      session_id: event.session_id,
      actor_id: actorId,
      timestamp: payload.computed_at,
      causal_parent_ids: event.causal_parent_ids ?? [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
    return envelope.id
  }
}
