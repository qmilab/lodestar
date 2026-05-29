import type { Explanation, ExplanationAudience, ExplanationSubject } from "@qmilab/lodestar-core"

/**
 * Generates structured Explanation records.
 *
 * v0 produces deterministic, template-based explanations. v0.2 will add
 * an LLM-driven mode for nuanced reasoning rationales, but template
 * explanations remain available because they are replay-stable and
 * cheap.
 *
 * Audience-aware redaction: explanations targeting 'human' must respect
 * the recipient's sensitivity clearance. The generator does not perform
 * the redaction itself — it accepts pre-filtered claim/evidence ids
 * from the caller. The caller (typically the firewall or planner) is
 * responsible for applying the redaction policy.
 */
export class ExplanationGenerator {
  constructor(private readonly generator_actor_id: string) {}

  build(input: BuildExplanationInput): Explanation {
    return {
      id: crypto.randomUUID(),
      subject_type: input.subject_type,
      subject_id: input.subject_id,
      audience: input.audience,
      summary: input.summary,
      full_text: input.full_text,
      claims_used: input.claims_used,
      evidence_used: input.evidence_used,
      uncertainties: input.uncertainties ?? [],
      counterarguments: input.counterarguments ?? [],
      generated_by: this.generator_actor_id,
      at: new Date().toISOString(),
    }
  }

  /**
   * Convenience: build an explanation for a belief adoption.
   */
  forBeliefAdoption(input: {
    belief_id: string
    claim_id: string
    evidence_id: string
    confidence: number
    audience?: ExplanationAudience
    rationale_text: string
  }): Explanation {
    return this.build({
      subject_type: "decision_rationale",
      subject_id: input.belief_id,
      audience: input.audience ?? "audit",
      summary: `Belief adopted at confidence ${input.confidence.toFixed(2)}`,
      full_text: input.rationale_text,
      claims_used: [input.claim_id],
      evidence_used: [input.evidence_id],
    })
  }

  /**
   * Convenience: build an explanation for a memory quarantine.
   */
  forQuarantine(input: {
    belief_id: string
    reason: string
    triggered_by_event_id: string
  }): Explanation {
    return this.build({
      subject_type: "memory_quarantine",
      subject_id: input.belief_id,
      audience: "audit",
      summary: `Belief quarantined: ${input.reason}`,
      full_text: `Belief ${input.belief_id} was quarantined. Reason: ${input.reason}. Triggering event: ${input.triggered_by_event_id}.`,
      claims_used: [],
      evidence_used: [],
    })
  }
}

export interface BuildExplanationInput {
  subject_type: ExplanationSubject
  subject_id: string
  audience: ExplanationAudience
  summary: string
  full_text: string
  claims_used: string[]
  evidence_used: string[]
  uncertainties?: string[]
  counterarguments?: string[]
}
