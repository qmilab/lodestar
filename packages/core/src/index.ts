/**
 * @qmilab/lodestar-core
 *
 * Epistemic chain primitives and schemas. Everything else in Lodestar
 * depends on this package.
 *
 * The chain:
 *   Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
 *
 * The governance surfaces (Memory Firewall, Policy Kernel, Action Kernel,
 * Harness) consume and protect these primitives.
 */

// Common
export * from "./schemas/common.js"

// Sensitivity gate — content-scale ordering + the export/egress ceiling helpers
export * from "./schemas/sensitivity.js"

// Identity
export * from "./schemas/actor.js"

// Epistemic chain
export * from "./schemas/observation.js"
export * from "./schemas/claim.js"
export * from "./schemas/belief.js"
export * from "./schemas/decision.js"
export * from "./schemas/action.js"
export * from "./schemas/revision.js"

// Event log envelope
export * from "./schemas/event.js"

// Reflection (Batch 4) — proposals and the reflection.completed@1 payload
export * from "./schemas/reflection.js"

// Calibration — the report wire format + the calibration.computed@1 payload
export * from "./schemas/calibration.js"

// Probe pack format (Batch 4) — the lodestar.probe-pack.json manifest contract
export * from "./schemas/probe-pack.js"

// Consumer registry formats (#90, ADR-0019) — the pack trust config + lockfile
export * from "./schemas/pack-registry.js"

// Sentinels (Batch 4) — the sentinel.alerted@1 alert wire format
export * from "./schemas/sentinel.js"

// Action policy (Policy Kernel) — the Policy / PolicyRule document wire format
export * from "./schemas/policy.js"

// Approval workflow (Policy Kernel) — ApprovalRequest + approval.* event payloads
export * from "./schemas/approval.js"

// Shared Ed25519 signing primitive + canonicalisation (ADR-0017) — pure compute
// over the Signature type, shared by the approval, pack-manifest, and badge paths
export * from "./crypto/canonical.js"
export * from "./crypto/signing.js"
export * from "./crypto/probe-pack-signing.js"

// Schema registry
export * as registry from "./registry.js"
