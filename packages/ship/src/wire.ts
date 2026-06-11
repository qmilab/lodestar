import {
  type EventEnvelope,
  EventEnvelopeSchema,
  SENSITIVITY_ORDER,
  type Sensitivity,
  SensitivitySchema,
  contentSensitivityForAction,
  isAboveCeiling,
  isSensitivity,
} from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * The `lodestar.session_ship@1` wire format — pure, no I/O.
 *
 * This module turns a session's raw {@link EventEnvelope}s into the NDJSON
 * transfer format and applies the locked v0.2 sensitivity gate. Keeping it
 * pure (like the otel-exporter's `project-spans`) puts the redaction
 * discipline in one testable place; `ship.ts` owns the network/file edge.
 *
 * Two invariants shape the format (ADR-0014):
 *  1. **The envelope schema is never grown for shipping.** Each event ships
 *     inside a *wrapper* record (`{ v, redacted, envelope }`); the redaction
 *     flag lives on the wrapper, not the envelope.
 *  2. **Redaction preserves tamper evidence.** A redacted record replaces
 *     only the envelope's `payload` (with {@link REDACTED_PAYLOAD}) and keeps
 *     the original `payload_hash`, so a receiver can verify the withheld
 *     content later under higher clearance — and can always tell
 *     "redacted by the sender" from "tampered in transit".
 */

export const SHIP_WIRE_KIND = "lodestar.session_ship" as const
export const SHIP_WIRE_VERSION = 1 as const

/**
 * The marker a redacted record's `payload` is replaced with. The envelope's
 * original `payload_hash` is preserved next to it. Mirrors the otel-exporter's
 * `{ "lodestar.redacted": true }` redaction marker.
 */
export const REDACTED_PAYLOAD = { "lodestar.redacted": true } as const

/** Line 1 of the body: what this batch is and how it was gated. */
export const ShipManifestSchema = z
  .object({
    kind: z.literal(SHIP_WIRE_KIND),
    version: z.literal(SHIP_WIRE_VERSION),
    project_id: z.string(),
    session_id: z.string(),
    event_count: z.number().int().nonnegative(),
    ceiling: SensitivitySchema,
    redacted_count: z.number().int().nonnegative(),
  })
  .describe("lodestar.session_ship@1 manifest record (the first NDJSON line)")
export type ShipManifest = z.infer<typeof ShipManifestSchema>

/**
 * Lines 2..N+1: one wrapper record per event, in `seq` order. A `redacted`
 * record additionally carries the `payload_sensitivity` that triggered the
 * gate and replaces the envelope's payload with {@link REDACTED_PAYLOAD}
 * while keeping the original `payload_hash`.
 */
export const ShipRecordSchema = z
  .discriminatedUnion("redacted", [
    z.object({
      v: z.literal(SHIP_WIRE_VERSION),
      redacted: z.literal(false),
      envelope: EventEnvelopeSchema,
    }),
    z.object({
      v: z.literal(SHIP_WIRE_VERSION),
      redacted: z.literal(true),
      payload_sensitivity: SensitivitySchema,
      envelope: EventEnvelopeSchema,
    }),
  ])
  .describe("lodestar.session_ship@1 per-event wrapper record")
export type ShipRecord = z.infer<typeof ShipRecordSchema>

/** A built batch: the manifest plus its seq-ordered records. */
export interface ShipBatch {
  manifest: ShipManifest
  records: ShipRecord[]
}

export interface BuildShipBatchInput {
  project_id: string
  session_id: string
  /** Raw envelopes for the session; re-sorted by `seq` here. */
  events: EventEnvelope[]
  /** Content whose source sensitivity outranks this is withheld. Default `internal`. */
  sensitivityCeiling?: Sensitivity
}

/**
 * The content sensitivity used to gate a single envelope's payload.
 *
 * Source order, most-specific first:
 *   1. the payload's own `sensitivity` (observations / claims / beliefs /
 *      memories carry it directly);
 *   2. an Action contract's `data_sensitivity`, mapped onto the content scale
 *      via {@link contentSensitivityForAction} — the same mapping the
 *      otel-exporter gates action intent/inputs by;
 *   3. otherwise FAIL CLOSED to `secret`.
 *
 * (3) is the load-bearing posture. An event type we cannot positively place on
 * the scale — a decision, an outcome, an approval record, a future event type —
 * is treated as maximally sensitive, so it is withheld at every ceiling below
 * `secret`. This mirrors {@link isAboveCeiling}/`sensitivityRank`, which rank
 * unknown *source* values above every real level (fail closed).
 *
 * It defaults to `secret` rather than an above-`secret` sentinel deliberately:
 * the whole session still becomes portable at `--sensitivity-ceiling secret`
 * (ADR-0014's headline consequence). An operator who explicitly clears `secret`
 * is cleared for the events we could not prove safe — not blocked from them
 * forever — and every shipped payload's hash still re-verifies on receipt.
 */
export function payloadContentSensitivity(envelope: EventEnvelope): Sensitivity {
  const payload = envelope.payload
  if (payload !== null && typeof payload === "object") {
    const direct = (payload as { sensitivity?: unknown }).sensitivity
    if (isSensitivity(direct)) return direct
    const ds = (payload as { contract?: { data_sensitivity?: unknown } }).contract?.data_sensitivity
    if (ds === "public" || ds === "private" || ds === "secret") {
      return contentSensitivityForAction(ds)
    }
  }
  return "secret"
}

/**
 * Build the seq-ordered, sensitivity-gated batch for a session.
 *
 * Pure: no I/O, no wall clock. Validates the ceiling at runtime and fails
 * closed — see {@link payloadContentSensitivity} for the per-event posture.
 */
export function buildShipBatch(input: BuildShipBatchInput): ShipBatch {
  // Only an *omitted* ceiling takes the default. A present-but-invalid value
  // (null / "" / a typo from a JS or config caller) must reach validation and
  // fail loud — a ceiling that ranked above every real level would fail OPEN
  // and ship even `secret` content (see `sensitivityRank`). A `??` default
  // would swallow `null`, so test for `undefined` explicitly.
  const ceiling = input.sensitivityCeiling === undefined ? "internal" : input.sensitivityCeiling
  if (!isSensitivity(ceiling)) {
    throw new Error(
      `invalid sensitivity ceiling: ${JSON.stringify(ceiling)} ` +
        `(expected one of ${SENSITIVITY_ORDER.join(", ")})`,
    )
  }

  // The wire format is seq-ordered (the receiver contract: `seq` strictly
  // increasing within a POST). `loadSessionEvents` returns logical-clock order,
  // so re-sort by seq here — over a *copy*, never mutating the caller's array.
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq)

  const records: ShipRecord[] = []
  let redacted_count = 0
  for (const envelope of ordered) {
    const source = payloadContentSensitivity(envelope)
    if (isAboveCeiling(source, ceiling)) {
      records.push({
        v: SHIP_WIRE_VERSION,
        redacted: true,
        payload_sensitivity: source,
        // Replace ONLY the payload. payload_hash — and every other structural
        // field — is preserved verbatim, so tamper evidence survives redaction.
        envelope: { ...envelope, payload: REDACTED_PAYLOAD },
      })
      redacted_count++
    } else {
      records.push({ v: SHIP_WIRE_VERSION, redacted: false, envelope })
    }
  }

  return {
    manifest: {
      kind: SHIP_WIRE_KIND,
      version: SHIP_WIRE_VERSION,
      project_id: input.project_id,
      session_id: input.session_id,
      event_count: records.length,
      ceiling,
      redacted_count,
    },
    records,
  }
}

/**
 * Serialize a batch to the NDJSON wire body: the manifest line, then one
 * record per event in seq order, with a trailing newline.
 */
export function serializeBatch(batch: ShipBatch): string {
  const lines = [JSON.stringify(batch.manifest)]
  for (const record of batch.records) lines.push(JSON.stringify(record))
  return `${lines.join("\n")}\n`
}
