import type {
  Belief,
  Claim,
  EvidenceSet,
  Explanation,
  FreshnessStatus,
  RetrievalStatus,
  SecurityStatus,
  TruthStatus,
} from "@orrery/core"
import type { BeliefStore, LifecycleAxis } from "./stores/belief-store"
import type { ClaimStore } from "./stores/claim-store"
import type { EvidenceStore } from "./stores/evidence-store"
import { aggregateStrength } from "./stores/evidence-store"
import {
  type TransitionAuthority,
  isTransitionAllowed,
} from "./transitions"

/**
 * The MemoryFirewall enforces the promotion gates and lifecycle transitions
 * on claims and beliefs.
 *
 * It does NOT:
 * - extract claims (that's @orrery/cognitive-core)
 * - decide retrieval results (see retrieval.ts in this package)
 * - generate explanations (the caller supplies an Explanation id)
 *
 * It DOES:
 * - enforce the no-self-promotion rule
 * - enforce per-axis transition tables
 * - call the audit sink for every transition
 * - reject transitions from unauthorised actors
 */
export class MemoryFirewall {
  constructor(
    private readonly claims: ClaimStore,
    private readonly beliefs: BeliefStore,
    private readonly evidence: EvidenceStore,
    private readonly auditSink: (event: FirewallAuditEvent) => Promise<void>,
  ) {}

  /**
   * Accept a newly extracted claim. The claim enters status "extracted"
   * and is NOT yet adopted as a belief. Adoption requires a separate
   * promotion call with evidence.
   */
  async acceptClaim(claim: Claim): Promise<void> {
    if (claim.status !== "extracted") {
      throw new Error(
        `MemoryFirewall: new claims must enter at status='extracted'; got '${claim.status}'`,
      )
    }
    await this.claims.put(claim)
    await this.auditSink({
      kind: "claim.accepted",
      claim_id: claim.id,
      at: new Date().toISOString(),
      by_actor_id: claim.extracted_by,
    })
  }

  /**
   * Adopt a claim as a belief. This is the promotion gate.
   *
   * Critical rule: a claim CANNOT become a belief from agent success alone.
   * The caller must supply evidence and an explanation. The firewall verifies:
   * - the claim exists and is in 'extracted' or 'accepted' state
   * - the evidence references the claim
   * - the evidence quality is non-trivial (not all synthetic, not empty)
   * - the proposed truth_status is reachable under the supplied authority
   */
  async adoptBelief(input: {
    candidate: Omit<Belief, "id"> & { id?: string }
    evidence_id: string
    by_authority: TransitionAuthority
    rationale: Explanation
  }): Promise<Belief> {
    const claim = await this.claims.get(input.candidate.claim_id)
    if (!claim) {
      throw new Error(`MemoryFirewall: cannot adopt belief for unknown claim ${input.candidate.claim_id}`)
    }
    if (claim.status === "rejected") {
      throw new Error(`MemoryFirewall: cannot adopt a rejected claim ${claim.id}`)
    }

    const evidence = await this.evidence.get(input.evidence_id)
    if (!evidence) {
      throw new Error(`MemoryFirewall: evidence ${input.evidence_id} not found`)
    }
    if (evidence.claim_id !== claim.id) {
      throw new Error(`MemoryFirewall: evidence ${evidence.id} does not support claim ${claim.id}`)
    }
    this.assertEvidenceIsRealistic(evidence)

    // The proposed initial truth_status must be reachable from 'unverified'
    // under the supplied authority. We never allow direct insertion at
    // truth_status='supported' without authority justification.
    const proposedTruth = input.candidate.truth_status
    if (proposedTruth !== "unverified") {
      if (!isTransitionAllowed("truth_status", "unverified", proposedTruth, input.by_authority)) {
        throw new Error(
          `MemoryFirewall: authority '${input.by_authority}' cannot insert belief directly at truth_status='${proposedTruth}'`,
        )
      }
    }

    // Initial retrieval_status defaults to 'restricted' unless authority
    // is sufficient to set it higher. New beliefs do not become 'normal'
    // retrievable without explicit promotion.
    const proposedRetrieval = input.candidate.retrieval_status
    if (proposedRetrieval !== "hidden" && proposedRetrieval !== "restricted") {
      if (!isTransitionAllowed("retrieval_status", "restricted", proposedRetrieval, input.by_authority)) {
        throw new Error(
          `MemoryFirewall: authority '${input.by_authority}' cannot insert belief at retrieval_status='${proposedRetrieval}'`,
        )
      }
    }

    // Strength threshold: net evidence strength must be > 0 to adopt as
    // 'supported'. Beliefs entering at 'unverified' have no such gate.
    if (proposedTruth === "supported") {
      const strength = aggregateStrength(evidence)
      if (strength <= 0) {
        throw new Error(
          `MemoryFirewall: cannot adopt at truth_status='supported' with net evidence strength ${strength.toFixed(3)} ≤ 0`,
        )
      }
    }

    const id = input.candidate.id ?? crypto.randomUUID()
    const belief: Belief = { ...input.candidate, id }
    await this.beliefs.put(belief)
    await this.auditSink({
      kind: "belief.adopted",
      belief_id: belief.id,
      claim_id: claim.id,
      evidence_id: evidence.id,
      rationale_id: input.rationale.id,
      by_authority: input.by_authority,
      at: new Date().toISOString(),
      by_actor_id: input.rationale.generated_by,
    })
    return belief
  }

  /**
   * Transition a belief along one lifecycle axis.
   *
   * - Verifies the transition is allowed for the supplied authority.
   * - Records the transition through the BeliefStore (which mirrors
   *   the change onto the belief record).
   * - Emits a FirewallAuditEvent.
   */
  async transitionAxis(input: {
    belief_id: string
    axis: LifecycleAxis
    to_value: TruthStatus | RetrievalStatus | SecurityStatus | FreshnessStatus
    by_authority: TransitionAuthority
    by_actor_id: string
    rationale: Explanation
  }): Promise<void> {
    const belief = await this.beliefs.get(input.belief_id)
    if (!belief) {
      throw new Error(`MemoryFirewall: belief ${input.belief_id} not found`)
    }
    const fromValue = belief[input.axis] as string
    if (!isTransitionAllowed(input.axis, fromValue, input.to_value, input.by_authority)) {
      throw new Error(
        `MemoryFirewall: transition ${input.axis}: ${fromValue} → ${input.to_value} not allowed for authority '${input.by_authority}'`,
      )
    }
    await this.beliefs.transition({
      belief_id: input.belief_id,
      axis: input.axis,
      from_value: fromValue,
      to_value: input.to_value,
      by_actor_id: input.by_actor_id,
      rationale_id: input.rationale.id,
    })
    await this.auditSink({
      kind: "belief.transitioned",
      belief_id: input.belief_id,
      axis: input.axis,
      from_value: fromValue,
      to_value: input.to_value,
      by_authority: input.by_authority,
      rationale_id: input.rationale.id,
      at: new Date().toISOString(),
      by_actor_id: input.by_actor_id,
    })
  }

  /**
   * Quarantine a belief. Shortcut for a security_status transition;
   * verifies the actor's authority and records why.
   */
  async quarantine(input: {
    belief_id: string
    by_authority: TransitionAuthority
    by_actor_id: string
    rationale: Explanation
  }): Promise<void> {
    const belief = await this.beliefs.get(input.belief_id)
    if (!belief) {
      throw new Error(`MemoryFirewall: belief ${input.belief_id} not found`)
    }
    if (belief.security_status === "quarantined") return

    const path: SecurityStatus[] = belief.security_status === "clean"
      ? ["quarantined"]
      : ["quarantined"]

    let current: SecurityStatus = belief.security_status
    for (const next of path) {
      await this.transitionAxis({
        belief_id: input.belief_id,
        axis: "security_status",
        to_value: next,
        by_authority: input.by_authority,
        by_actor_id: input.by_actor_id,
        rationale: input.rationale,
      })
      current = next
    }
    void current
  }

  private assertEvidenceIsRealistic(evidence: EvidenceSet): void {
    if (evidence.items.length === 0) {
      throw new Error("MemoryFirewall: cannot adopt belief from empty EvidenceSet")
    }
    const realCount = evidence.items.filter(
      (i) => i.quality !== "synthetic_probe",
    ).length
    if (realCount === 0) {
      throw new Error(
        "MemoryFirewall: EvidenceSet contains only synthetic_probe items; cannot adopt real belief from probe evidence",
      )
    }
  }
}

// -----------------------------------------------------------------------------
// Audit events emitted by the firewall
// -----------------------------------------------------------------------------

export type FirewallAuditEvent =
  | {
      kind: "claim.accepted"
      claim_id: string
      at: string
      by_actor_id: string
    }
  | {
      kind: "belief.adopted"
      belief_id: string
      claim_id: string
      evidence_id: string
      rationale_id: string
      by_authority: TransitionAuthority
      at: string
      by_actor_id: string
    }
  | {
      kind: "belief.transitioned"
      belief_id: string
      axis: LifecycleAxis
      from_value: string
      to_value: string
      by_authority: TransitionAuthority
      rationale_id: string
      at: string
      by_actor_id: string
    }
