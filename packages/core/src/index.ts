/**
 * @qmilab/lodestar-core
 *
 * Epistemic chain primitives and schemas. Everything else in Orrery
 * depends on this package.
 *
 * The chain:
 *   Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
 *
 * The governance surfaces (Memory Firewall, Policy Kernel, Action Kernel,
 * Harness) consume and protect these primitives.
 */

// Common
export * from "./schemas/common"

// Identity
export * from "./schemas/actor"

// Epistemic chain
export * from "./schemas/observation"
export * from "./schemas/claim"
export * from "./schemas/belief"
export * from "./schemas/decision"
export * from "./schemas/action"
export * from "./schemas/revision"

// Event log envelope
export * from "./schemas/event"

// Schema registry
export * as registry from "./registry"
