import type { Belief, ContextPolicy, ResourceScope } from "@qmilab/lodestar-core"
import type { BeliefStore } from "./stores/belief-store.js"
import type { ClaimStore } from "./stores/claim-store.js"

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
  constructor(
    private readonly beliefs: BeliefStore,
    private readonly claims: ClaimStore,
  ) {}

  /**
   * Standard retrieval used by the planner. Strictly bounded by ContextPolicy.
   *
   * Contradiction handling (Round 5 fix): contradicted beliefs are filtered
   * out of the main retrieval set by `policy.allowed_truth_statuses` (which
   * typically only allows `supported`). To still surface them when
   * `policy.include_contradictions` is true, we run `retrieveContradictions`
   * — which subject-joins the accepted set against contradicted beliefs in
   * scope and returns only the related ones. The planner gets a "related
   * contradictions" channel, not arbitrary contradicted beliefs in main
   * context.
   */
  async retrieve(query: RetrievalQuery, policy: ContextPolicy): Promise<RetrievalResult> {
    const { accepted, rejected, uncertainties } =
      await this.computeAcceptedCandidates(query, policy)

    let contradictions: Belief[] = []
    if (policy.include_contradictions) {
      // Reuse the already-computed accepted set so the join key set is
      // derived from beliefs that ACTUALLY make it into context — not
      // from stale supported beliefs the freshness gate would reject,
      // and not from low-confidence beliefs the uncertainty gate would
      // reject when `include_uncertainties` is false.
      contradictions = await this.contradictionsForAccepted(accepted, query, policy)
    }

    return {
      accepted,
      rejected,
      contradictions,
      uncertainties: policy.include_uncertainties ? uncertainties : [],
    }
  }

  /**
   * Retrieve contradicted beliefs related to the standard retrieval set.
   *
   * Round 5 fix (pre-Batch 3): a contradiction is "related" when its
   * claim's `structured_predicate.{subject, relation}` matches that of
   * one of the accepted-set candidates the standard `retrieve()` would
   * surface under the same policy. Subject-only would lump unrelated
   * relations together; the (subject, relation) join is the natural one.
   *
   * Claims without a `structured_predicate` cannot be subject-joined
   * and are intentionally excluded from this channel — surface only
   * what we can prove related. Sensitivity, scope, security, retrieval,
   * freshness, and uncertainty gates ALL apply.
   *
   * Called internally by `retrieve()` when `policy.include_contradictions`
   * is true. Callable directly by sentinels and reflection that need to
   * inspect contradictions specifically.
   */
  async retrieveContradictions(
    query: RetrievalQuery,
    policy: ContextPolicy,
  ): Promise<Belief[]> {
    const { accepted } = await this.computeAcceptedCandidates(query, policy)
    return this.contradictionsForAccepted(accepted, query, policy)
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

  // ── Shared helpers ──────────────────────────────────────────────────────

  /**
   * Run the candidate filter + freshness/uncertainty post-gates that
   * `retrieve()` applies. Both `retrieve()` and `retrieveContradictions()`
   * use this so the join keys derived from the accepted set reflect
   * what the planner will actually see, not just what the store filter
   * returned.
   */
  private async computeAcceptedCandidates(
    query: RetrievalQuery,
    policy: ContextPolicy,
  ): Promise<{
    accepted: Belief[]
    rejected: BeliefRejection[]
    uncertainties: Belief[]
  }> {
    const candidates = await this.beliefs.list({
      scope: query.scope,
      truth_status: policy.allowed_truth_statuses,
      retrieval_status: policy.allowed_retrieval_statuses,
      security_status: policy.allowed_security_statuses,
      max_sensitivity: policy.sensitivity_ceiling,
      calibration_class: query.calibration_class,
    })

    const now = Date.now()
    const maxAge = policy.freshness_max_age
      ? parseDurationToMs(policy.freshness_max_age)
      : null

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
      const isAssertedPriority =
        (belief.authority === "user_asserted" && policy.user_asserted_takes_priority) ||
        (belief.authority === "policy_asserted" && policy.policy_asserted_takes_priority)

      const isUncertain = belief.confidence < 0.5
      if (isUncertain && !policy.include_uncertainties && !isAssertedPriority) {
        rejected.push({ belief, reason: "uncertainty_excluded_by_policy" })
        continue
      }

      accepted.push(belief)
      if (isUncertain) uncertainties.push(belief)
    }

    return { accepted, rejected, uncertainties }
  }

  /**
   * Given an already-computed accepted set, find contradicted beliefs in
   * scope whose claim shares a (subject, relation) pair with an accepted
   * belief's claim. Same sensitivity / scope / security / retrieval
   * gates as the standard path; freshness and uncertainty gates apply
   * here too, so a contradiction that would itself be filtered out of
   * main context (e.g. stale) does not surface in this channel either.
   */
  private async contradictionsForAccepted(
    accepted: Belief[],
    query: RetrievalQuery,
    policy: ContextPolicy,
  ): Promise<Belief[]> {
    if (accepted.length === 0) return []

    const relatedKeys = new Set<string>()
    for (const belief of accepted) {
      const claim = await this.claims.get(belief.claim_id)
      const pred = claim?.structured_predicate
      if (pred) relatedKeys.add(predicateKey(pred.subject, pred.relation))
    }
    if (relatedKeys.size === 0) return []

    // Pull contradicted beliefs in scope, then apply the SAME freshness
    // + uncertainty post-gates the accepted set went through.
    const rawContradicted = await this.beliefs.list({
      scope: query.scope,
      truth_status: ["contradicted"],
      retrieval_status: policy.allowed_retrieval_statuses,
      security_status: policy.allowed_security_statuses,
      max_sensitivity: policy.sensitivity_ceiling,
      calibration_class: query.calibration_class,
    })

    const now = Date.now()
    const maxAge = policy.freshness_max_age
      ? parseDurationToMs(policy.freshness_max_age)
      : null

    const result: Belief[] = []
    for (const belief of rawContradicted) {
      // Freshness
      if (maxAge !== null) {
        const observedMs = Date.parse(belief.observed_at)
        if (Number.isFinite(observedMs) && now - observedMs > maxAge) continue
      }
      // Uncertainty
      const isAssertedPriority =
        (belief.authority === "user_asserted" && policy.user_asserted_takes_priority) ||
        (belief.authority === "policy_asserted" && policy.policy_asserted_takes_priority)
      if (
        belief.confidence < 0.5 &&
        !policy.include_uncertainties &&
        !isAssertedPriority
      ) {
        continue
      }
      // Subject-relation join
      const claim = await this.claims.get(belief.claim_id)
      const pred = claim?.structured_predicate
      if (!pred) continue
      if (relatedKeys.has(predicateKey(pred.subject, pred.relation))) {
        result.push(belief)
      }
    }
    return result
  }
}

/**
 * Collision-free composite key for a (subject, relation) pair.
 *
 * `JSON.stringify([subject, relation])` distinguishes
 *   ["a b", "c"]  →  '["a\\u0000b","c"]'
 *   ["a", "b c"]  →  '["a","b\\u0000c"]'
 * which a delimiter-based `subject + sep + relation` cannot, since the
 * Predicate schema allows the delimiter byte to appear in either
 * component (memory adapters import free-form text).
 */
function predicateKey(subject: string, relation: string): string {
  return JSON.stringify([subject, relation])
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
