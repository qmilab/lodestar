import { z } from "zod"
import { PredicateSchema, ResourceScopeSchema, SensitivitySchema, TimestampSchema } from "./common.js"

/**
 * How a claim was extracted from observation(s).
 */
export const ExtractionMethodSchema = z.enum(["tool", "llm", "human", "import"])
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>

/**
 * Lifecycle of a claim before it becomes a belief.
 */
export const ClaimStatusSchema = z.enum(["extracted", "contested", "accepted", "rejected"])
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>

/**
 * Dissent recorded against a claim. Reserved for multi-agent futures;
 * v0 captures it but the resolution algorithm is deferred.
 */
export const DissentSchema = z.object({
  by_actor_id: z.string(),
  reason: z.string(),
  at: TimestampSchema,
})
export type Dissent = z.infer<typeof DissentSchema>

/**
 * A statement extracted from one or more observations.
 *
 * Claims are the second link in the epistemic chain. Every claim
 * records its extraction method and the actor that extracted it,
 * so the source of an eventual belief can always be traced back to
 * the original observation(s).
 */
export const ClaimSchema = z.object({
  id: z.string(),
  statement: z.string().describe("human-readable claim"),
  structured_predicate: PredicateSchema.optional().describe("for queryable claims"),
  source_observation_ids: z.array(z.string()).min(1, "a claim must reference at least one observation"),
  extraction_method: ExtractionMethodSchema,
  extracted_by: z.string().describe("actor_id of the extractor"),
  status: ClaimStatusSchema,
  scope: ResourceScopeSchema,
  sensitivity: SensitivitySchema,
  authors: z.array(z.string()).describe("actor_ids; usually one in v0, multi for v1.5+"),
  dissent: z.array(DissentSchema).optional(),
  created_at: TimestampSchema,
})
export type Claim = z.infer<typeof ClaimSchema>

// -----------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------

/**
 * Quality of a single piece of evidence.
 *
 * v0 uses a categorical taxonomy. A scalar evidence strength is
 * deferred to later versions once enough data exists to calibrate
 * a scoring function.
 */
export const EvidenceQualitySchema = z.enum([
  "direct_observation",   // tool output describing world state
  "tool_result",          // computed result from a tool
  "human_assertion",      // user said so
  "model_inference",      // an LLM concluded so from other context
  "external_document",    // file, webpage, email — high risk for poisoning
  "synthetic_probe",      // from a Harness probe; never affects real beliefs
])
export type EvidenceQuality = z.infer<typeof EvidenceQualitySchema>

/**
 * One piece of evidence for or against a claim.
 *
 * `independence_group` is used by aggregators: items in the same group
 * are NOT independent. This matters because three citations to the same
 * source are not three independent supporting items.
 */
export const EvidenceItemSchema = z.object({
  source_id: z.string().describe("observation_id, belief_id, or external ref"),
  relation: z.enum(["supports", "contradicts", "contextualizes"]),
  quality: EvidenceQualitySchema,
  independence_group: z.string().optional(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  notes: z.string().optional(),
})
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>

/**
 * Set of evidence assessed against a claim.
 *
 * No scalar `strength` field in v0. Strength is computed lazily by
 * an aggregator that may evolve as data accumulates.
 */
export const EvidenceSetSchema = z.object({
  id: z.string(),
  claim_id: z.string(),
  items: z.array(EvidenceItemSchema),
  assessed_by: z.string().describe("actor_id of the assessor"),
  assessed_at: TimestampSchema,
})
export type EvidenceSet = z.infer<typeof EvidenceSetSchema>
