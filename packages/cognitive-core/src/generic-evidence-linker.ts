import type { EvidenceItem, EvidenceSet, Observation } from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"
import { EvidenceLinker, type LinkForClaimInput } from "./evidence-linker.js"

/**
 * Evidence linker that downgrades an **LLM-extracted** claim's source-evidence
 * quality to `model_inference` — the partner linker for
 * {@link createGenericLLMExtractor} (epic #154 child C-2, #163, ADR-0035).
 *
 * A claim with `extraction_method: "llm"` is, by construction, the model's
 * *inference about* an observation rather than the observation itself: the link
 * from the bytes to the claim is a model inference. So its supporting evidence
 * can be no stronger than `model_inference`, which is exactly what trips the
 * Round 5 auto-observation (Parallax) gate inside {@link CognitiveCore} —
 * keeping a generically-extracted belief at `truth_status: unverified` until a
 * reflection pass or a human promotes it. This is the safety property that
 * makes a generic extractor acceptable at all; an LLM extraction must never
 * silently self-promote to `supported`.
 *
 * The downgrade lives here (an **opt-in** sibling of `DocAwareEvidenceLinker`),
 * not in the base {@link EvidenceLinker}, on purpose: the base linker treats
 * `extraction_method` as non-load-bearing (the source observation's own trust
 * sets quality), and several first-party flows rely on that. Opting into the
 * generic extractor therefore means opting into this linker too — register one
 * with the other.
 *
 * Non-`llm` claims fall straight through to the base linker, so a single
 * `CognitiveCore` can mix generic-LLM observations with schema-bound
 * (`tool`) ones without disturbing the latter. The same `synthetic`-trust
 * floor the sibling linkers apply holds here: an LLM claim over a synthetic
 * probe observation stays `synthetic_probe` (never affects real beliefs),
 * never upgraded.
 */
export class GenericAwareEvidenceLinker extends EvidenceLinker {
  constructor(
    private readonly evidenceStore: EvidenceStore,
    beliefs: BeliefStore,
    claims: ClaimStore,
  ) {
    super(evidenceStore, beliefs, claims)
  }

  override async linkForClaim(input: LinkForClaimInput): Promise<EvidenceSet> {
    // Only LLM-extracted claims are downgraded; everything else keeps the base
    // linker's observation-trust-derived quality.
    if (input.claim.extraction_method !== "llm") {
      return super.linkForClaim(input)
    }

    // Re-implement the base body with the model_inference quality rather than
    // calling super and overwriting — EvidenceStore.put is a strict insert and
    // would throw on a second write (the same reason the MCP/Doc/Runtime-aware
    // linkers re-implement it).
    const items: EvidenceItem[] = input.source_observations.map((obs: Observation) => ({
      source_id: obs.id,
      relation: "supports",
      // Never upgrade a synthetic-probe observation: an LLM claim over a
      // synthetic source must not affect real strength.
      quality: obs.trust === "synthetic" ? "synthetic_probe" : "model_inference",
      independence_group: `obs:${obs.source.tool}`,
      freshness: "fresh",
      notes: `llm_inference from ${obs.schema}`,
    }))

    // Same cross-belief join the base linker runs (#157): corroboration /
    // contradiction from prior beliefs sharing this claim's (subject, relation).
    items.push(...(await this.crossBeliefItems(input.claim)))

    const evidenceSet: EvidenceSet = {
      id: crypto.randomUUID(),
      claim_id: input.claim.id,
      items,
      assessed_by: input.assessor_actor_id,
      assessed_at: new Date().toISOString(),
    }
    await this.evidenceStore.put(evidenceSet)
    return evidenceSet
  }
}
