import { createHash } from "node:crypto"

/**
 * Deterministic JSON serialization with object keys sorted recursively.
 *
 * A signature is computed over the *canonical document* — the same bytes the
 * signer signed must be reproduced byte-for-byte at verify time, so key order
 * cannot be allowed to drift. Arrays preserve order (it is often semantic — a
 * policy's rule order is first-decisive; a content digest's file list is
 * pre-sorted by the producer); only object keys are sorted.
 *
 * Graduated to `@qmilab/lodestar-core` from `policy-kernel/hash.ts` (ADR-0017) so
 * the policy signature, the approval-resolution signature, and the pack-manifest
 * signature share one canonicalisation. The implementation is byte-identical to
 * the policy-kernel original — existing signed policies / approvals must still
 * verify after the move. `policy-kernel/hash.ts` now re-exports this.
 *
 * Kept distinct from the event-log writer's per-event `canonicalHash`: a
 * signature hash only needs to be *internally* consistent (sign-time ===
 * verify-time), not identical to the event-log's hash, and core must stay
 * free of the NDJSON/fs writer.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  // Skip keys whose value is `undefined`, matching JSON.stringify: a document
  // built with an explicit `field: undefined` (e.g. a config merge) must hash
  // identically to one that omits the key, or a JSON round-trip during
  // persistence would change the hash and the signed document would be wrongly
  // rejected as tampered at reload.
  const entries = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  return `{${entries.join(",")}}`
}

/** sha-256 hex of the canonical (stably stringified) serialisation of `value`. */
export function canonicalHashHex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}
