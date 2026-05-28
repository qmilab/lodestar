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

// Probe pack format (Batch 4) — the lodestar.probe-pack.json manifest contract
export * from "./schemas/probe-pack.js"

// Schema registry
export * as registry from "./registry.js"
