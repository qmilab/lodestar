import { z } from "zod"
import { TimestampSchema } from "./common"

/**
 * One option in a decision.
 */
export const DecisionOptionSchema = z.object({
  id: z.string(),
  description: z.string(),
  expected_outcome: z.string().optional(),
  estimated_cost: z.string().optional().describe("free-form for v0; e.g. 'low', 'medium', 'high'"),
  estimated_risk: z.string().optional(),
})
export type DecisionOption = z.infer<typeof DecisionOptionSchema>

/**
 * A choice among options, justified by beliefs.
 *
 * Decisions sit between Belief and Action in the epistemic chain.
 * Every Decision records its belief_dependencies — the policy can
 * reject Decisions that lack supporting beliefs (governed by
 * ContextPolicy.require_evidence_for_decisions).
 *
 * The rationale_id points to an Explanation generated alongside
 * the decision. This is how the system stays auditable: every
 * decision has a stored reasoning trail, not just a regenerable one.
 */
export const DecisionSchema = z.object({
  id: z.string(),
  question: z.string().describe("human-readable question this decision answers"),
  options: z.array(DecisionOptionSchema).min(1),
  selected_option_id: z.string(),
  rationale_id: z.string().describe("Explanation id"),
  belief_dependencies: z.array(z.string()).describe("belief_ids consulted"),
  policy_dependencies: z.array(z.string()).describe("policy versions consulted"),
  outcome_id: z.string().optional().describe("populated after Action completes"),
  made_by: z.string().describe("actor_id"),
  made_at: TimestampSchema,
})
export type Decision = z.infer<typeof DecisionSchema>
