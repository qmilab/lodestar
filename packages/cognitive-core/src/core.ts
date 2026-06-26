import type {
  Belief,
  Claim,
  EvidenceItem,
  EvidenceSet,
  Observation,
  ResourceScope,
} from "@qmilab/lodestar-core"
import type { MemoryFirewall } from "@qmilab/lodestar-memory-firewall"
import { aggregateStrength } from "@qmilab/lodestar-memory-firewall"
import type { EvidenceLinkerLike } from "./evidence-linker.js"
import type { ExplanationGenerator } from "./explanation.js"
import { lookupExtractor } from "./extractors/base.js"
import type { WorldModel } from "./world-model/index.js"

/**
 * The CognitiveCore orchestrates the epistemic chain steps:
 *
 *   Observation → Claim → EvidenceSet → Belief
 *
 * It is the layer above the MemoryFirewall: the firewall enforces what
 * is allowed; the cognitive core decides what to attempt.
 *
 * The core does NOT make decisions or propose actions. Those live in
 * the planner. The core's job ends when an Observation has been
 * fully ingested into the system's epistemic state.
 */
export class CognitiveCore {
  constructor(
    private readonly firewall: MemoryFirewall,
    private readonly evidenceLinker: EvidenceLinkerLike,
    private readonly explanationGenerator: ExplanationGenerator,
    private readonly worldModel: WorldModel,
  ) {}

  /**
   * Ingest a single Observation. Walks the epistemic chain end-to-end:
   *
   * 1. Look up an extractor for the observation's schema (or generic).
   * 2. Extract claims.
   * 3. Submit each claim to the firewall (status='extracted').
   * 4. For each claim, build an EvidenceSet from this observation plus
   *    any related prior beliefs.
   * 5. If the evidence has positive net strength, propose adoption as
   *    a belief at truth_status='unverified' or 'supported' depending
   *    on strength.
   * 6. Update the world model with any structured_predicate the claims expose.
   *
   * Returns a structured summary of what happened.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const { observation, context } = input
    const extractor = lookupExtractor(observation.schema)
    if (!extractor) {
      return {
        observation_id: observation.id,
        claims: [],
        beliefs: [],
        worldModelUpdates: [],
        worldModelWithheld: [],
        reason: `no extractor registered for schema '${observation.schema}'`,
      }
    }

    // 1-2. Extract claims
    const claims = await extractor.extract({
      observation,
      context: {
        actor_id: context.actor_id,
        project_id: context.project_id,
        session_id: context.session_id,
        default_scope: context.default_scope,
        default_sensitivity: context.default_sensitivity,
      },
    })

    // 3. Submit claims to firewall
    const claimsAccepted: Claim[] = []
    for (const claim of claims) {
      await this.firewall.acceptClaim(claim)
      claimsAccepted.push(claim)
    }

    // 4-5. Build evidence and propose belief adoption
    const beliefsAdopted: Belief[] = []
    // Claims whose evidence nets positive AND clears the auto-observation gate —
    // the only ones that may update the world model (step 6). Two kinds of claim
    // are kept OUT of current state:
    //   - net-NEGATIVE: the cross-belief join found it contradicts a held belief,
    //     so it is refused as a belief here and must not silently overwrite
    //     observed state with the losing value (#157 review, ADR-0032 P2#1).
    //   - auto-observation-GATED: a positive claim whose strongest support is
    //     `model_inference` / `external_document`. The firewall keeps it at
    //     `unverified` (Parallax); the world model is the ungated store a planner
    //     reads blindly, so an unverified value here is a poisoning side door.
    //     We WITHHOLD the write (recorded below) rather than write-and-flag,
    //     because the world model has no read-time gate to enforce a flag and a
    //     flagged write would shadow a previously gate-cleared value (#165,
    //     ADR-0037). The unverified belief still carries the full record.
    const worldModelEligibleClaimIds = new Set<string>()
    // Positive-strength claims withheld from current state purely by the
    // auto-observation gate — surfaced in IngestResult so the audit trail shows
    // the gate held on the world-model path too, keyed by claim id → quality.
    const gateWithheldQualityByClaimId = new Map<string, EvidenceItem["quality"]>()
    for (const claim of claimsAccepted) {
      const evidence = await this.evidenceLinker.linkForClaim({
        claim,
        source_observations: [observation],
        assessor_actor_id: context.actor_id,
      })

      const strength = aggregateStrength(evidence)
      if (strength <= 0) continue // no (or net-contradicting) evidence: stays 'extracted'

      // The auto-observation gate enforces the Parallax principle:
      // a claim sourced from a single piece of `model_inference` or
      // `external_document` evidence cannot auto-promote to
      // `truth_status: supported`. Promotion requires either independent
      // corroboration (multiple sources with different
      // `independence_group` values) or explicit reflection authority.
      //
      // When the strongest available evidence is one of those qualities,
      // the gate downgrades the transition authority from
      // `auto_observation` to `reflection`, which keeps the belief at
      // `unverified` until a reflection pass or user promotes it
      // further. (Originally specified in the Round 5 review under the
      // codename Orrery; see docs/architecture/v02-delta.md.)
      const strongestQuality = strongestEvidenceQuality(evidence)
      const autoObservationBlocked =
        strongestQuality === "external_document" || strongestQuality === "model_inference"

      // World-model eligibility (step 6): a claim updates current state only if
      // its evidence nets positive (checked above) AND clears the gate. A
      // positive-but-gated claim is withheld from the world model — the same
      // Parallax principle the belief gate applies, extended to the ungated
      // current-state store (#165, ADR-0037).
      if (autoObservationBlocked) {
        gateWithheldQualityByClaimId.set(claim.id, strongestQuality)
      } else {
        worldModelEligibleClaimIds.add(claim.id)
      }

      // Strong evidence (>= 0.7) earns an immediate 'supported' adoption
      // under the 'auto_observation' transition authority. Weaker evidence
      // stays 'unverified' until reflection or user promotes it.
      //
      // Note: BeliefAuthority describes where the BELIEF came from
      // (observed/inferred/user_asserted/...). TransitionAuthority describes
      // who is allowed to PERFORM a lifecycle change. They are different
      // concepts. For observations ingested by the core, the belief's
      // authority is always "observed"; the transition authority varies
      // by evidence strength.
      const initialTruthStatus =
        strength >= 0.7 && !autoObservationBlocked ? "supported" : "unverified"
      const initialConfidence = Math.min(0.95, Math.max(0.1, strength))
      const transitionAuthority =
        initialTruthStatus === "supported" ? "auto_observation" : "reflection"

      const explanation = this.explanationGenerator.forBeliefAdoption({
        belief_id: "pending",
        claim_id: claim.id,
        evidence_id: evidence.id,
        confidence: initialConfidence,
        rationale_text:
          `Adopted from observation ${observation.id} via schema-bound extractor for ${observation.schema}. ` +
          `Evidence strength ${strength.toFixed(2)} under transition authority '${transitionAuthority}'.`,
      })

      try {
        const belief = await this.firewall.adoptBelief({
          candidate: {
            claim_id: claim.id,
            confidence: initialConfidence,
            calibration_class: calibrationClassFor(observation.schema, claim),
            scope: claim.scope,
            sensitivity: claim.sensitivity,
            authority: "observed", // belief provenance: from a tool observation
            truth_status: initialTruthStatus,
            retrieval_status: "restricted", // never go straight to 'normal'
            security_status: "clean",
            freshness_status: "fresh",
            observed_at: observation.source.captured_at,
            last_verified_at: observation.source.captured_at,
          },
          evidence_id: evidence.id,
          by_authority: transitionAuthority, // who is performing the transition
          rationale: explanation,
        })
        beliefsAdopted.push(belief)
      } catch (err) {
        // Adoption rejected by firewall: leave the claim at 'extracted'
        // and continue with the next claim. Reflection or user may try
        // again later.
        void err
      }
    }

    // 6. Update world model from structured_predicate fields
    const worldModelUpdates: string[] = []
    // Positive-strength predicated claims withheld from current state by the
    // auto-observation gate (not the net-contradiction rule). Surfaced so a host
    // can show the gate held on the world-model side door too (#165, ADR-0037).
    const worldModelWithheld: WorldModelWithheld[] = []
    for (const claim of claimsAccepted) {
      if (!claim.structured_predicate) continue
      const key = `${claim.structured_predicate.subject}.${claim.structured_predicate.relation}`
      // A positive claim the gate blocked is withheld and recorded — never
      // written. The world model is read blindly by a planner, so an unverified
      // value here is a poisoning side door; the unverified belief still carries
      // the full record (#165, ADR-0037).
      const withheldQuality = gateWithheldQualityByClaimId.get(claim.id)
      if (withheldQuality) {
        worldModelWithheld.push({ key, quality: withheldQuality })
        continue
      }
      // Skip claims whose evidence did not net positive — in particular a claim
      // the cross-belief join found to contradict a held belief, which we
      // already refused to adopt above. Propagating its value would let a
      // rejected claim overwrite observed state (#157 review).
      if (!worldModelEligibleClaimIds.has(claim.id)) continue
      await this.worldModel.set({
        key,
        value: claim.structured_predicate.object,
        scope: claim.scope,
        source_observation_id: observation.id,
        confidence: 0.8, // world model entries are observations; not the same as belief confidence
        observed_at: observation.source.captured_at,
      })
      worldModelUpdates.push(key)
    }

    return {
      observation_id: observation.id,
      claims: claimsAccepted,
      beliefs: beliefsAdopted,
      worldModelUpdates,
      worldModelWithheld,
    }
  }
}

export interface IngestInput {
  observation: Observation
  context: {
    actor_id: string
    project_id: string
    session_id: string
    default_scope: ResourceScope
    default_sensitivity: import("@qmilab/lodestar-core").Sensitivity
  }
}

export interface IngestResult {
  observation_id: string
  claims: Claim[]
  beliefs: Belief[]
  worldModelUpdates: string[]
  /**
   * Positive-strength predicated claims that were withheld from the world
   * model purely by the auto-observation gate (strongest support is
   * `model_inference` / `external_document`). Empty unless the gate blocked a
   * current-state write. The full record survives as the `unverified` belief;
   * this is the audit receipt that the gate held on the world-model side door
   * too (#165, ADR-0037). Net-contradicted claims (strength ≤ 0) are excluded —
   * those are governed by the separate #157 rule and appear nowhere.
   */
  worldModelWithheld: WorldModelWithheld[]
  reason?: string
}

/** A world-model write withheld by the auto-observation gate (#165). */
export interface WorldModelWithheld {
  /** The `subject.relation` current-state key the claim would have written. */
  key: string
  /** The strongest supporting evidence quality that triggered the gate. */
  quality: EvidenceItem["quality"]
}

/**
 * Derive a calibration_class from the observation schema and claim subject.
 *
 * Groups similar claims so the Calibrator can compute per-class ECE/Brier.
 */
function calibrationClassFor(schema: string, claim: Claim): string {
  const subj = claim.structured_predicate?.subject ?? "untyped"
  return `${schema}::${subj}`
}

/**
 * Return the quality of the highest-quality supporting evidence item in
 * the set. Used by the auto-observation gate (Parallax principle) to
 * refuse silent promotion when the strongest evidence is too indirect.
 *
 * Order of quality (best to worst):
 *   direct_observation > tool_result > human_assertion >
 *   model_inference > external_document > synthetic_probe
 *
 * Returns "synthetic_probe" if the set has no supporting items at all
 * (which the firewall will catch separately, but defensively this
 * conservatively prevents auto-promotion).
 */
function strongestEvidenceQuality(evidence: EvidenceSet): EvidenceItem["quality"] {
  const ORDER: EvidenceItem["quality"][] = [
    "direct_observation",
    "tool_result",
    "human_assertion",
    "model_inference",
    "external_document",
    "synthetic_probe",
  ]
  for (const q of ORDER) {
    if (evidence.items.some((i) => i.relation === "supports" && i.quality === q)) {
      return q
    }
  }
  return "synthetic_probe"
}
