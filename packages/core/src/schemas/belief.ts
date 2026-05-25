import { z } from "zod"
import {
  DurationSchema,
  ResourceScopeSchema,
  SensitivitySchema,
  TimestampSchema,
} from "./common.js"

// -----------------------------------------------------------------------------
// Orthogonal lifecycle axes
//
// A belief's state is described by four independent dimensions. Collapsing
// them into a single enum is the wrong abstraction: a belief can be
// "supported but stale", "supported but quarantined", "contradicted but
// fresh", and so on. The axes are independently updated and independently
// gate retrieval.
// -----------------------------------------------------------------------------

export const TruthStatusSchema = z.enum(["unverified", "supported", "contradicted", "superseded"])
export type TruthStatus = z.infer<typeof TruthStatusSchema>

export const RetrievalStatusSchema = z.enum(["hidden", "restricted", "normal", "privileged_only", "blocked"])
export type RetrievalStatus = z.infer<typeof RetrievalStatusSchema>

export const SecurityStatusSchema = z.enum(["clean", "suspicious", "quarantined", "malicious"])
export type SecurityStatus = z.infer<typeof SecurityStatusSchema>

export const FreshnessStatusSchema = z.enum(["fresh", "stale", "expired"])
export type FreshnessStatus = z.infer<typeof FreshnessStatusSchema>

/**
 * How a belief came to be adopted.
 *
 * - observed: derived from tool observations
 * - inferred: derived by an LLM from other context
 * - user_asserted: user said so directly
 * - policy_asserted: policy configuration (e.g. "do not push to main")
 * - imported: from an external knowledge import
 * - synthetic: from a probe; never affects real reasoning
 *
 * user_asserted and policy_asserted beliefs do NOT decay like
 * observations. They expire only via explicit revision.
 */
export const BeliefAuthoritySchema = z.enum([
  "observed",
  "inferred",
  "user_asserted",
  "policy_asserted",
  "imported",
  "synthetic",
])
export type BeliefAuthority = z.infer<typeof BeliefAuthoritySchema>

/**
 * A claim the system has provisionally adopted.
 *
 * Every belief points to a claim (`claim_id`). The belief carries
 * lifecycle state, confidence, calibration class, scope, sensitivity,
 * and authority. The claim carries the statement itself.
 *
 * Confidence is the agent's stated confidence. The Calibrator measures
 * empirical accuracy per calibration_class and can require the Policy
 * Kernel to downweight confidence in classes where the agent is
 * historically overconfident.
 */
export const BeliefSchema = z.object({
  id: z.string(),
  claim_id: z.string(),

  confidence: z.number().min(0).max(1),
  calibration_class: z.string().describe("groups similar beliefs for calibrator"),
  scope: ResourceScopeSchema,
  sensitivity: SensitivitySchema,
  authority: BeliefAuthoritySchema,

  // Orthogonal lifecycle axes
  truth_status: TruthStatusSchema,
  retrieval_status: RetrievalStatusSchema,
  security_status: SecurityStatusSchema,
  freshness_status: FreshnessStatusSchema,

  observed_at: TimestampSchema,
  last_verified_at: TimestampSchema.optional(),
  expires_at: TimestampSchema.optional(),
  superseded_by: z.string().optional().describe("belief_id of successor"),
})
export type Belief = z.infer<typeof BeliefSchema>

// -----------------------------------------------------------------------------
// ContextPolicy
//
// What the cognitive core may load into model context. Without an explicit
// policy, "the planner used a stale belief" or "the explanation leaked a
// secret claim" become invisible bugs. With it, those become testable
// invariants.
// -----------------------------------------------------------------------------

export const ContextPolicySchema = z.object({
  // Which lifecycle states may be loaded
  allowed_truth_statuses: z.array(TruthStatusSchema),
  allowed_retrieval_statuses: z.array(RetrievalStatusSchema),
  allowed_security_statuses: z.array(SecurityStatusSchema),

  // Freshness gate
  freshness_max_age: DurationSchema.optional(),

  // Sensitivity ceiling for what can enter context
  sensitivity_ceiling: SensitivitySchema,

  // What the planner sees
  include_contradictions: z.boolean(),
  include_uncertainties: z.boolean(),
  require_evidence_for_decisions: z.boolean(),

  // Authority handling
  user_asserted_takes_priority: z.boolean(),
  policy_asserted_takes_priority: z.boolean(),
})
export type ContextPolicy = z.infer<typeof ContextPolicySchema>

/**
 * Conservative v0 default. Tightens up as the system proves itself.
 */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  allowed_truth_statuses: ["supported"],
  allowed_retrieval_statuses: ["normal"],
  allowed_security_statuses: ["clean"],
  freshness_max_age: "P30D",
  sensitivity_ceiling: "internal",
  include_contradictions: true,
  include_uncertainties: true,
  require_evidence_for_decisions: true,
  user_asserted_takes_priority: true,
  policy_asserted_takes_priority: true,
}
