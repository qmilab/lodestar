import { canonicalHashHex, stableStringify } from "@qmilab/lodestar-core"
import type { Policy } from "@qmilab/lodestar-core"

/**
 * Deterministic JSON serialization with object keys sorted recursively.
 *
 * Graduated to `@qmilab/lodestar-core` (ADR-0017) so the policy signature, the
 * approval-resolution signature, and the pack-manifest signature share one
 * canonicalisation. Re-exported here (byte-identical to the original) so existing
 * importers keep working and existing signed policies / approvals still verify.
 */
export { stableStringify }

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
  return canonicalHashHex(canonicalPolicyDocument(policy))
}
