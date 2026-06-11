import {
  ActionSchema,
  BeliefSchema,
  ClaimSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  ObservationSchema,
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
 * The shipper receives RAW envelopes (`payload` is `unknown`), so it must not
 * trust a `sensitivity`-looking field on an arbitrary blob — a custom or
 * agent-emitted event (`ctx.emit("x", { sensitivity: "public", secret: … })`)
 * would otherwise exfiltrate content at the default ceiling. The field is
 * trusted ONLY when the payload VALIDATES against a known content schema:
 *
 *   1. a valid Claim / Belief / Observation → its own `sensitivity`;
 *   2. a valid Action → `contract.data_sensitivity`, mapped onto the content
 *      scale via {@link contentSensitivityForAction} (the same mapping the
 *      otel-exporter gates action intent/inputs by);
 *   3. otherwise FAIL CLOSED to `secret`.
 *
 * (3) is the load-bearing posture. Anything that does not validate as a known
 * content record — a decision, an outcome, an approval record, a forged/custom
 * event, a future event type — is treated as maximally sensitive and withheld
 * at every ceiling below `secret`. This mirrors `sensitivityRank`, which ranks
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

  // Trust a `sensitivity` field only on a payload that VALIDATES as one of the
  // content records whose schema defines it — never on a bare lookalike blob.
  const claim = ClaimSchema.safeParse(payload)
  if (claim.success) return claim.data.sensitivity
  const belief = BeliefSchema.safeParse(payload)
  if (belief.success) return belief.data.sensitivity
  const observation = ObservationSchema.safeParse(payload)
  if (observation.success) return observation.data.sensitivity

  // A validated Action's coarse `data_sensitivity`, mapped onto the content scale.
  const action = ActionSchema.safeParse(payload)
  if (action.success) return contentSensitivityForAction(action.data.contract.data_sensitivity)

  // Fail closed: anything we cannot positively validate is treated as `secret`.
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
