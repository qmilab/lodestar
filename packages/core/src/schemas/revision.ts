import { z } from "zod"
import { TimestampSchema } from "./common.js"

/**
 * Update to a claim, belief, or decision when evidence shifts.
 *
 * Revisions are the eighth (and cyclic) link in the epistemic chain.
 * They make beliefs defeasible: when new observations contradict an
 * adopted belief, a Revision event records the change and points to
 * the Explanation that justifies it.
 */
export const RevisionSchema = z.object({
  id: z.string(),
  target_type: z.enum(["claim", "belief", "decision"]),
  target_id: z.string(),
  changes: z.array(z.object({
    field: z.string(),
    old_value: z.unknown(),
    new_value: z.unknown(),
  })),
  triggered_by: z.string().describe("actor_id or event_id"),
  rationale_id: z.string().describe("Explanation id"),
  at: TimestampSchema,
})
export type Revision = z.infer<typeof RevisionSchema>

// -----------------------------------------------------------------------------
// Explanation
// -----------------------------------------------------------------------------

/**
 * Subject types an Explanation can address.
 *
 * Every governance event in the system produces an Explanation.
 * This is what makes the system auditable in a way that traces alone
 * cannot match: traces show what happened, explanations show why.
 */
export const ExplanationSubjectSchema = z.enum([
  "action_approval",
  "action_rejection",
  "memory_promotion",
  "memory_quarantine",
  "confidence_downweight",
  "decision_rationale",
  "claim_acceptance",
  "claim_rejection",
  "belief_revision",
])
export type ExplanationSubject = z.infer<typeof ExplanationSubjectSchema>

/**
 * Audience an Explanation is generated for. Affects redaction:
 * an Explanation targeting `human` redacts content above the
 * recipient's sensitivity clearance.
 */
export const ExplanationAudienceSchema = z.enum(["human", "agent", "audit", "research"])
export type ExplanationAudience = z.infer<typeof ExplanationAudienceSchema>

/**
 * Structured rationale for any governance event.
 *
 * An Explanation must reference its inputs (claims_used, evidence_used)
 * so that a replay can verify the rationale was grounded in real data
 * rather than post-hoc fabrication.
 */
export const ExplanationSchema = z.object({
  id: z.string(),
  subject_type: ExplanationSubjectSchema,
  subject_id: z.string(),
  audience: ExplanationAudienceSchema,
  summary: z.string().describe("one-sentence summary"),
  full_text: z.string().describe("multi-paragraph rationale"),
  claims_used: z.array(z.string()).describe("claim_ids referenced"),
  evidence_used: z.array(z.string()).describe("evidence_set_ids referenced"),
  uncertainties: z.array(z.string()).describe("known unknowns acknowledged"),
  counterarguments: z.array(z.string()).describe("opposing considerations"),
  generated_by: z.string().describe("actor_id"),
  at: TimestampSchema,
})
export type Explanation = z.infer<typeof ExplanationSchema>
