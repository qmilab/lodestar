import { createHash } from "node:crypto"
import type { Policy } from "@qmilab/lodestar-core"

/**
 * Deterministic JSON serialization with object keys sorted recursively.
 *
 * A policy signature is computed over the *canonical document* — the same
 * bytes the signer signed must be reproduced byte-for-byte at verify time, so
 * key order cannot be allowed to drift. Arrays preserve order (rule order is
 * semantic — first-decisive evaluation); only object keys are sorted.
 *
 * Kept local rather than importing the event-log writer's `canonicalHash`:
 * this package is otherwise pure logic with no NDJSON/fs dependency, and the
 * policy hash only needs to be *internally* consistent (sign-time === verify-
 * time), not identical to the event-log's per-event hash.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  // Skip keys whose value is `undefined`, matching JSON.stringify: a policy
  // built with an explicit `approval: undefined` (e.g. a config merge) must
  // hash identically to one that omits the key, or a JSON round-trip during
  // persistence would change the hash and the signed policy would be wrongly
  // rejected as tampered at reload.
  const entries = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  return `{${entries.join(",")}}`
}

/**
 * The signable content of a policy: everything *except* the detached
 * signature fields. A document cannot sign over its own signature, so
 * `signature` and `signed_by` are excluded; `Decision.policy_dependencies`
 * pins the resulting hash.
 */
export function canonicalPolicyDocument(policy: Policy): {
  id: string
  version: string
  rules: Policy["rules"]
} {
  return { id: policy.id, version: policy.version, rules: policy.rules }
}

/** sha-256 hex of the canonical policy document `{ id, version, rules }`. */
export function canonicalPolicyHash(policy: Policy): string {
  return createHash("sha256")
    .update(stableStringify(canonicalPolicyDocument(policy)))
    .digest("hex")
}
