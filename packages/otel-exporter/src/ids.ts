import { createHash } from "node:crypto"

/**
 * Deterministic OpenTelemetry ids derived from Lodestar ids.
 *
 * OTLP trace ids are 16 bytes (32 hex chars); span ids are 8 bytes
 * (16 hex chars). We derive them by hashing the stable Lodestar
 * identifiers, so re-exporting the same log produces byte-identical ids:
 * the export is idempotent and a collector overwrites rather than
 * duplicates the trace. No randomness and no wall clock — which also
 * keeps the package replay-safe.
 *
 * The seed includes the **project id** as well as the session id: a session
 * id is only unique within a project (callers disambiguate cross-project
 * collisions with `--project`), so seeding on the session alone would make
 * two projects that reuse a session id collide on trace/span ids in the
 * backend. The seed is a JSON array so the components can never be confused
 * across a delimiter (`["a:b", "c"]` ≠ `["a", "b:c"]`).
 *
 * sha-256 of any input is never all-zero, so the OTLP "invalid id"
 * sentinel (all bytes zero) cannot be produced.
 */

function hashHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex")
}

/** 16-byte (32 hex char) trace id for a (project, session). */
export function traceIdFor(projectId: string, sessionId: string): string {
  return hashHex(`lodestar.trace:${JSON.stringify([projectId, sessionId])}`).slice(0, 32)
}

/** 8-byte (16 hex char) span id for a record within a (project, session). */
export function spanIdFor(projectId: string, sessionId: string, localId: string): string {
  return hashHex(`lodestar.span:${JSON.stringify([projectId, sessionId, localId])}`).slice(0, 16)
}

/**
 * Convert an ISO-8601 timestamp to a Unix-nanoseconds string (the OTLP
 * wire form). Returns "0" for a missing or unparseable timestamp.
 *
 * Uses `Date.parse` on the *given* string (never the wall clock), so it
 * is deterministic and replay-safe.
 */
export function isoToUnixNano(iso: string | undefined): string {
  if (!iso) return "0"
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return "0"
  return (BigInt(ms) * 1_000_000n).toString()
}
