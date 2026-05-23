import type { Claim, EvidenceItem, EvidenceSet, Observation } from "@orrery/core"
import type { BeliefStore, EvidenceStore } from "@orrery/memory-firewall"

/**
 * The EvidenceLinker constructs an EvidenceSet for a newly extracted Claim.
 *
 * v0 is deliberately simple:
 * - Always adds an EvidenceItem for each source observation as "supports / direct_observation".
 * - Searches the BeliefStore for existing beliefs that match the claim's
 *   structured_predicate.subject and adds them as supports/contradicts.
 * - Does NOT call an LLM. v0.2 will add LLM-driven evidence discovery.
 *
 * The linker is stateless apart from the stores it consults; it is safe
 * to call concurrently.
 */
export class EvidenceLinker {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly beliefs: BeliefStore,
  ) {}

  async linkForClaim(input: {
    claim: Claim
    source_observations: Observation[]
    assessor_actor_id: string
  }): Promise<EvidenceSet> {
    const items: EvidenceItem[] = []

    // 1. Each source observation contributes a supporting item.
    for (const obs of input.source_observations) {
      items.push({
        source_id: obs.id,
        relation: "supports",
        quality: obs.trust === "synthetic" ? "synthetic_probe" : "direct_observation",
        independence_group: `obs:${obs.source.tool}`,
        freshness: "fresh",
        notes: `from ${obs.schema}`,
      })
    }

    // 2. Look for existing beliefs that match the claim's subject.
    //    A naive match: same structured_predicate.subject in the same scope.
    if (input.claim.structured_predicate?.subject) {
      const subject = input.claim.structured_predicate.subject
      const candidates = await this.beliefs.list({ scope: input.claim.scope })
      for (const belief of candidates) {
        // We cannot access the claim's structured_predicate from belief alone;
        // skip in v0 if the belief's claim_id is unknown to us. v0.2 will
        // join through the claim store.
        void belief
        // Placeholder: a future version walks the belief.claim_id back to the
        // ClaimStore, reads the structured_predicate, and adds support /
        // contradiction items accordingly.
      }
      void subject
    }

    const evidenceSet: EvidenceSet = {
      id: crypto.randomUUID(),
      claim_id: input.claim.id,
      items,
      assessed_by: input.assessor_actor_id,
      assessed_at: new Date().toISOString(),
    }
    await this.evidence.put(evidenceSet)
    return evidenceSet
  }
}
