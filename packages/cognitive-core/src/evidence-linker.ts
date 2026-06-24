import type { Belief, Claim, EvidenceItem, EvidenceSet, Observation } from "@qmilab/lodestar-core"
import { stableStringify } from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"
import { predicateKey } from "@qmilab/lodestar-memory-firewall"

/**
 * The input an evidence linker assesses for a single claim.
 */
export interface LinkForClaimInput {
  claim: Claim
  source_observations: Observation[]
  assessor_actor_id: string
}

/**
 * The minimal contract the {@link CognitiveCore} needs from an evidence
 * linker: turn a claim + its source observations into a persisted
 * {@link EvidenceSet}.
 *
 * Exposing this as an interface (rather than binding the core to the
 * concrete {@link EvidenceLinker} class) is the seam that lets hosts
 * inject document-aware, MCP-aware, or LLM-driven linkers. The default
 * {@link EvidenceLinker} and subclasses like `MCPAwareEvidenceLinker`
 * and `DocAwareEvidenceLinker` all satisfy it.
 */
export interface EvidenceLinkerLike {
  linkForClaim(input: LinkForClaimInput): Promise<EvidenceSet>
}

/**
 * Quality ranking, strongest first. Mirrors `strongestEvidenceQuality`
 * in `core.ts` (the auto-observation gate reads the same order) — keep
 * them in sync.
 */
const QUALITY_RANK: EvidenceItem["quality"][] = [
  "direct_observation",
  "tool_result",
  "human_assertion",
  "model_inference",
  "external_document",
  "synthetic_probe",
]

/**
 * Whether a prior belief is still lifecycle-valid enough to lend cross-belief
 * evidence to a new claim.
 *
 * The Memory Firewall isolates or invalidates beliefs through its lifecycle
 * axes; the join must honour that, or a quarantined / invalidated memory could
 * lend support to a NEW belief and reach future retrieval despite the gates
 * that block the original — the firewall's "quarantine is one-way" invariant
 * leaking through a side channel. So a peer is eligible only if it is:
 *   - `security_status: "clean"` — never `suspicious` / `quarantined` / `malicious`;
 *   - not `contradicted` / `superseded` — an invalidated belief lends nothing;
 *   - not `freshness_status: "expired"` — a dead belief lends nothing;
 *   - `retrieval_status` is `restricted` or `normal` — the two in-play states.
 *     This **excludes** `blocked` (a sentinel/policy hard-demote), `hidden`, and
 *     `privileged_only`, so an explicitly-suppressed or access-restricted belief
 *     can't launder its evidence into a freshly-adopted (planner-retrievable) one.
 * `unverified` peers ARE kept (two `external_document` beliefs corroborate each
 * other without promoting — the Parallax case); `stale` is kept (aging, not
 * invalid). `restricted` must stay eligible — it is the default adopted state,
 * so gating it out would exclude every freshly-adopted peer. The retrieval check
 * is an allowlist (fail-closed: a future retrieval state is excluded until
 * reviewed), matching the firewall's bias-to-stricter posture.
 */
function isEligibleJoinPeer(belief: Belief): boolean {
  return (
    belief.security_status === "clean" &&
    belief.truth_status !== "contradicted" &&
    belief.truth_status !== "superseded" &&
    belief.freshness_status !== "expired" &&
    (belief.retrieval_status === "restricted" || belief.retrieval_status === "normal")
  )
}

/**
 * The EvidenceLinker constructs an EvidenceSet for a newly extracted Claim.
 *
 * v0 is deliberately simple:
 * - Always adds an EvidenceItem for each source observation as "supports / direct_observation".
 * - Joins the new claim against prior beliefs in scope that share its
 *   `structured_predicate.(subject, relation)`, adding a cross-belief
 *   `supports` (same object) or `contradicts` (different object) item — see
 *   {@link EvidenceLinker.crossBeliefItems}.
 * - Does NOT call an LLM. v0.2 will add LLM-driven evidence discovery.
 *
 * The linker is stateless apart from the stores it consults; it is safe
 * to call concurrently.
 */
export class EvidenceLinker implements EvidenceLinkerLike {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly beliefs: BeliefStore,
    private readonly claims: ClaimStore,
  ) {}

  async linkForClaim(input: LinkForClaimInput): Promise<EvidenceSet> {
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

    // 2. Cross-belief join: corroboration / contradiction from prior
    //    beliefs whose claim shares this claim's (subject, relation).
    items.push(...(await this.crossBeliefItems(input.claim)))

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

  /**
   * Cross-belief join (#157, ADR-0032).
   *
   * For a claim with a `structured_predicate`, walk the prior beliefs in
   * the same scope back to their claims (`belief.claim_id → ClaimStore`),
   * skip any the firewall has invalidated or isolated (see
   * {@link isEligibleJoinPeer}), and emit a cross-belief evidence item for
   * every remaining belief whose claim shares this claim's `(subject, relation)`:
   *   - same `object`      → `supports`  (independent corroboration)
   *   - different `object`  → `contradicts`
   *
   * **Quality inheritance.** A `Belief` carries no source/independence
   * pointer, so the cross-belief item inherits the *quality* and
   * *independence_group* of the prior belief's own strongest supporting
   * evidence (read via the already-held `EvidenceStore`). A corroborator
   * can therefore never lend more confidence than its own basis: two
   * `external_document` beliefs keep `strongest = external_document` (the
   * Parallax / auto-observation gate still blocks promotion), while a
   * genuinely stronger independent source clears it. Inheriting the prior
   * group means a *same-source* re-read dedups in `aggregateStrength` and
   * lends nothing.
   *
   * The linker stays **pure**: it records items only on the *new* claim's
   * evidence. It never transitions the prior belief — that is reflection's
   * job (epic child B). Shared by all four linker bodies (the base and the
   * three `*Aware` subclasses) so the join cannot live in only one of them.
   *
   * v0 simplifications: a prior belief contributes only its strongest
   * item's group; the join is O(beliefs-in-scope) per ingest.
   */
  protected async crossBeliefItems(claim: Claim): Promise<EvidenceItem[]> {
    const pred = claim.structured_predicate
    if (!pred) return [] // claims without a structured_predicate are excluded from the join

    const key = predicateKey(pred.subject, pred.relation)
    const newObject = stableStringify(pred.object)
    const items: EvidenceItem[] = []

    const candidates = await this.beliefs.list({ scope: claim.scope })
    for (const belief of candidates) {
      if (belief.claim_id === claim.id) continue // never join a claim against itself
      if (!isEligibleJoinPeer(belief)) continue // exclude firewall-invalidated / isolated beliefs
      const priorClaim = await this.claims.get(belief.claim_id)
      const priorPred = priorClaim?.structured_predicate
      if (!priorPred) continue // prior claim has no predicate to join on
      if (predicateKey(priorPred.subject, priorPred.relation) !== key) continue

      const basis = await this.strongestSupportingBasis(belief.claim_id)
      if (!basis) continue // a prior belief with no supporting evidence lends nothing

      const agrees = stableStringify(priorPred.object) === newObject
      items.push({
        source_id: belief.id,
        relation: agrees ? "supports" : "contradicts",
        quality: basis.quality,
        ...(basis.independence_group !== undefined
          ? { independence_group: basis.independence_group }
          : {}),
        freshness: basis.freshness,
        notes: `cross-belief ${agrees ? "corroboration" : "contradiction"} of (${pred.subject}, ${pred.relation}) from belief ${belief.id}`,
      })
    }
    return items
  }

  /**
   * The strongest *supporting* evidence basis recorded for a prior claim:
   * its quality (highest rank in {@link QUALITY_RANK}) plus that item's
   * `independence_group` and `freshness`, which a cross-belief item
   * inherits. Returns `undefined` when the prior claim has no supporting
   * evidence at all.
   */
  private async strongestSupportingBasis(
    claim_id: string,
  ): Promise<Pick<EvidenceItem, "quality" | "independence_group" | "freshness"> | undefined> {
    const sets = await this.evidence.forClaim(claim_id)
    let best: EvidenceItem | undefined
    let bestRank = Number.POSITIVE_INFINITY
    for (const set of sets) {
      for (const item of set.items) {
        if (item.relation !== "supports") continue
        const rank = QUALITY_RANK.indexOf(item.quality)
        if (rank === -1) continue
        if (rank < bestRank) {
          bestRank = rank
          best = item
        }
      }
    }
    if (!best) return undefined
    return {
      quality: best.quality,
      independence_group: best.independence_group,
      freshness: best.freshness,
    }
  }
}
