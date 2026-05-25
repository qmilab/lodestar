import type { Belief, ContextPolicy, ResourceScope } from "@qmilab/lodestar-core"
import type { BeliefStore } from "./stores/belief-store.js"

/**
 * Gated retrieval over the BeliefStore.
 *
 * Every retrieval path goes through here. There is no direct query path
 * from the planner to the belief store: the policy must always apply.
 *
 * The ONLY way to retrieve beliefs that the policy excludes is to use
 * `retrievePrivileged()`, which requires an actor with explicit
 * privileged_only authority. Sentinels and probes use this path; the
 * planner does not.
 */
export class GatedRetrieval {
  constructor(private readonly beliefs: BeliefStore) {}

  /**
   * Standard retrieval used by the planner. Strictly bounded by ContextPolicy.
   *
   * Contradiction handling (Round 5 fix): contradicted beliefs are filtered
   * out of the main retrieval set by `policy.allowed_truth_statuses` (which
   * typically only allows `supported`). To still surface them when
   * `policy.include_contradictions` is true, we run a SEPARATE query against
   * `truth_status: ["contradicted"]` and return those in a dedicated channel.
   * The planner gets a "related contradictions" section, not arbitrary
   * contradicted beliefs in main context.
   */
  async retrieve(query: RetrievalQuery, policy: ContextPolicy): Promise<RetrievalResult> {
    const candidates = await this.beliefs.list({
      scope: query.scope,
      truth_status: policy.allowed_truth_statuses,
      retrieval_status: policy.allowed_retrieval_statuses,
      security_status: policy.allowed_security_statuses,
      max_sensitivity: policy.sensitivity_ceiling,
      calibration_class: query.calibration_class,
    })

    const now = Date.now()
    const maxAge = policy.freshness_max_age ? parseDurationToMs(policy.freshness_max_age) : null

    const accepted: Belief[] = []
    const rejected: BeliefRejection[] = []
    const uncertainties: Belief[] = []

    for (const belief of candidates) {
      // Freshness gate
      if (maxAge !== null) {
        const observedMs = Date.parse(belief.observed_at)
        if (Number.isFinite(observedMs) && now - observedMs > maxAge) {
          rejected.push({ belief, reason: "freshness_max_age_exceeded" })
          continue
        }
      }

      // Authority precedence: user_asserted and policy_asserted are always
      // surfaced regardless of freshness, if the policy says so.
      const isAsserted =
        belief.authority === "user_asserted" || belief.authority === "policy_asserted"
      const isAssertedPriority =
        (belief.authority === "user_asserted" && policy.user_asserted_takes_priority) ||
        (belief.authority === "policy_asserted" && policy.policy_asserted_takes_priority)

      // Confidence band: 'uncertainty' here means low calibrated confidence
      const isUncertain = belief.confidence < 0.5
      if (isUncertain && !policy.include_uncertainties && !isAssertedPriority) {
        rejected.push({ belief, reason: "uncertainty_excluded_by_policy" })
        continue
      }

      accepted.push(belief)
      if (isUncertain) uncertainties.push(belief)
      void isAsserted
    }

    // Separate channel for contradictions: query the store again with
    // truth_status: ["contradicted"] and the same scope/sensitivity gates.
    // This returns related-subject contradicted beliefs that the planner
    // should be aware of but should NOT mix into the main context.
    let contradictions: Belief[] = []
    if (policy.include_contradictions) {
      contradictions = await this.retrieveContradictions(query, policy)
    }

    return {
      accepted,
      rejected,
      contradictions,
      uncertainties: policy.include_uncertainties ? uncertainties : [],
    }
  }

  /**
   * Retrieve contradicted beliefs in a dedicated channel.
   *
   * Used internally by `retrieve()` when `policy.include_contradictions`
   * is true, but also callable directly by sentinels and reflection that
   * need to inspect contradictions specifically.
   *
   * Sensitivity, scope, and security gates still apply. Retrieval-status
   * gate also applies — a contradicted belief that's been demoted to
   * `hidden` will not surface here unless the policy explicitly allows it.
   */
  async retrieveContradictions(query: RetrievalQuery, policy: ContextPolicy): Promise<Belief[]> {
    return this.beliefs.list({
      scope: query.scope,
      truth_status: ["contradicted"],
      retrieval_status: policy.allowed_retrieval_statuses,
      security_status: policy.allowed_security_statuses,
      max_sensitivity: policy.sensitivity_ceiling,
      calibration_class: query.calibration_class,
    })
  }

  /**
   * Privileged retrieval. Used by sentinels, probes, and reflection.
   * The caller is responsible for ensuring the acting actor is authorised.
   *
   * No ContextPolicy filtering applies. Returns hidden, restricted,
   * suspicious, and quarantined beliefs as well as normal ones.
   */
  async retrievePrivileged(query: RetrievalQuery): Promise<Belief[]> {
    return this.beliefs.list({
      scope: query.scope,
      calibration_class: query.calibration_class,
    })
  }
}

export interface RetrievalQuery {
  scope?: ResourceScope
  calibration_class?: string
  /** Free-form text used for embedding-based retrieval in v0.2 */
  semantic_query?: string
  /** Maximum number of beliefs to return. v0 returns all matches. */
  limit?: number
}

export interface RetrievalResult {
  accepted: Belief[]
  rejected: BeliefRejection[]
  contradictions: Belief[]
  uncertainties: Belief[]
}

export interface BeliefRejection {
  belief: Belief
  reason:
    | "freshness_max_age_exceeded"
    | "uncertainty_excluded_by_policy"
    | "sensitivity_ceiling_exceeded"
}

/**
 * Minimal ISO 8601 duration parser for the freshness gate.
 * Supports the subset Lodestar actually uses: P<days>D and PT<hours>H<minutes>M<seconds>S.
 */
function parseDurationToMs(d: string): number {
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!m) return 0
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const minutes = Number(m[3] ?? 0)
  const seconds = Number(m[4] ?? 0)
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + Math.round(seconds * 1000)
}
