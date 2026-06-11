/**
 * @qmilab/lodestar-ship
 *
 * The session shipper. A read-side, batch transfer of a session's *raw*
 * event-log envelopes to a remote collector as the versioned NDJSON wire
 * format `lodestar.session_ship@1`, with the locked v0.2 sensitivity ceiling
 * applied client-side before anything leaves the machine.
 *
 * The transfer sibling of `@qmilab/lodestar-otel-exporter` (spans for trace
 * tools): same read-only stance, but a lossless, hash-verifiable envelope
 * format meant to reconstruct the whole chain on the far side — not OTLP
 * spans.
 */

export {
  CREDENTIAL_HEADER_HINTS,
  DEFAULT_MAX_BODY_BYTES,
  looksLikeCredentialHeader,
  SessionNotFoundError,
  shipSession,
} from "./ship.js"
export type { ShipSessionOptions, ShipSummary } from "./ship.js"

export {
  buildShipBatch,
  payloadContentSensitivity,
  REDACTED_PAYLOAD,
  serializeBatch,
  SHIP_WIRE_KIND,
  SHIP_WIRE_VERSION,
  ShipManifestSchema,
  ShipRecordSchema,
} from "./wire.js"
export type { BuildShipBatchInput, ShipBatch, ShipManifest, ShipRecord } from "./wire.js"
