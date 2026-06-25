import type { EvidenceItem, EvidenceSet } from "@qmilab/lodestar-core"

/**
 * Storage for evidence sets. Append-only: an evidence set's items are
 * added to over time as more sources are discovered, but old items
 * are never removed (only superseded by re-assessment with a new id).
 */
export interface EvidenceStore {
  put(evidence: EvidenceSet): Promise<void>
  get(id: string): Promise<EvidenceSet | undefined>
  forClaim(claim_id: string): Promise<EvidenceSet[]>
  /** Append a new item to an existing evidence set. */
  appendItem(evidence_id: string, item: EvidenceItem): Promise<EvidenceSet>
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private byId = new Map<string, EvidenceSet>()
  private byClaim = new Map<string, string[]>()

  async put(evidence: EvidenceSet): Promise<void> {
    if (this.byId.has(evidence.id)) {
      throw new Error(`EvidenceStore: evidence ${evidence.id} already exists`)
    }
    this.byId.set(evidence.id, evidence)
    const ids = this.byClaim.get(evidence.claim_id) ?? []
    ids.push(evidence.id)
    this.byClaim.set(evidence.claim_id, ids)
  }

  async get(id: string): Promise<EvidenceSet | undefined> {
    return this.byId.get(id)
  }

  async forClaim(claim_id: string): Promise<EvidenceSet[]> {
    const ids = this.byClaim.get(claim_id) ?? []
    return ids.map((id) => this.byId.get(id)).filter((e): e is EvidenceSet => e !== undefined)
  }

  async appendItem(evidence_id: string, item: EvidenceItem): Promise<EvidenceSet> {
    const existing = this.byId.get(evidence_id)
    if (!existing) {
      throw new Error(`EvidenceStore: evidence ${evidence_id} not found`)
    }
    const updated: EvidenceSet = {
      ...existing,
      items: [...existing.items, item],
    }
    this.byId.set(evidence_id, updated)
    return updated
  }
}

// -----------------------------------------------------------------------------
// Evidence aggregation
//
// v0 keeps this simple. A scalar strength is computed on demand rather
// than stored. The function below is the v0 aggregator; it can be
// replaced or extended without schema changes.
// -----------------------------------------------------------------------------

const QUALITY_WEIGHT: Record<EvidenceItem["quality"], number> = {
  direct_observation: 1.0,
  tool_result: 0.85,
  human_assertion: 0.7,
  model_inference: 0.4,
  external_document: 0.3,
  synthetic_probe: 0.0, // never affects real strength
}

const FRESHNESS_WEIGHT: Record<EvidenceItem["freshness"], number> = {
  fresh: 1.0,
  stale: 0.5,
  unknown: 0.6,
}

/** A group's strongest representative item and its quality×freshness weight. */
interface GroupBest {
  item: EvidenceItem
  weight: number
}

/**
 * Collapse an evidence set into one representative per independence group.
 *
 * Items without an `independence_group` are each their own group; within a
 * group only the strongest (highest quality×freshness) item counts. This is
 * the single source of the independence-group semantics shared by both
 * aggregators below — they must not drift on how corroboration is counted.
 */
function strongestPerGroup(evidence: EvidenceSet): GroupBest[] {
  const groups = new Map<string, EvidenceItem[]>()
  for (const item of evidence.items) {
    const key = item.independence_group ?? `__solo_${crypto.randomUUID()}`
    const existing = groups.get(key) ?? []
    existing.push(item)
    groups.set(key, existing)
  }

  const out: GroupBest[] = []
  for (const group of groups.values()) {
    out.push(
      group.reduce(
        (acc, item) => {
          const w = QUALITY_WEIGHT[item.quality] * FRESHNESS_WEIGHT[item.freshness]
          return w > acc.weight ? { item, weight: w } : acc
        },
        { item: group[0]!, weight: 0 },
      ),
    )
  }
  return out
}

/**
 * Compute a strength score for an evidence set.
 *
 * Returns a value in [-1, 1]: positive means net-supporting,
 * negative means net-contradicting, zero means no information.
 *
 * Independence groups are deduplicated: multiple items in the same
 * group contribute as one, taking the maximum weight in the group.
 *
 * This is the **gate input**: `cognitive-core` adopts a belief only when
 * this is `> 0` and auto-promotes to `truth_status: supported` only at
 * `>= 0.7` (with the Parallax quality gate on top). It is normalized
 * `(S − C)/(S + C)`, so an all-supporting set is **always exactly `1.0`** no
 * matter how many independent sources back it — only contradiction moves the
 * scalar. That normalization is deliberate: it keeps the promotion threshold
 * calibration-stable. Corroboration is made legible separately by
 * {@link corroborationStrength}, which does **not** feed any gate (#158).
 *
 * This is deliberately a simple v0 heuristic. Real calibration of the
 * aggregator is a research question (see research/benchmarks/).
 */
export function aggregateStrength(evidence: EvidenceSet): number {
  if (evidence.items.length === 0) return 0

  let supportWeight = 0
  let contradictWeight = 0
  for (const best of strongestPerGroup(evidence)) {
    if (best.item.relation === "supports") supportWeight += best.weight
    else if (best.item.relation === "contradicts") contradictWeight += best.weight
    // "contextualizes" doesn't contribute either way
  }

  const total = supportWeight + contradictWeight
  if (total === 0) return 0
  return (supportWeight - contradictWeight) / total
}

/**
 * The per-source confidence ceiling. Even a perfect `direct_observation`
 * (weight `1.0`) contributes only `0.95`, never certainty — so a lone strong
 * source leaves headroom for an independent corroborator to raise the score,
 * and the result stays strictly below `1`. Mirrors the `Math.min(0.95, …)`
 * confidence clamp `cognitive-core` already applies at belief adoption.
 */
const SOURCE_CONFIDENCE_CEILING = 0.95

/**
 * The saturation cap — the largest value `corroborationStrength` returns,
 * strictly below `1`. Past ~13 strong independent groups the noisy-OR
 * "miss" product underflows below one ULP at `1.0`, so `1 − miss` would round
 * to exactly `1.0` and break the `[0, 1)` bound (and stall the ranking
 * headroom). Clamping the result here keeps the scalar bounded and
 * non-decreasing in that tail: it *saturates below a cap* rather than hitting
 * `1`. The cap sits at the float-precision limit, so it only bites well beyond
 * any realistic corroboration count — strict monotonicity holds everywhere
 * below it.
 */
const MAX_CORROBORATION = 1 - Number.EPSILON

/**
 * Compute a **corroboration-aware** quality score for an evidence set (#158).
 *
 * Unlike {@link aggregateStrength} (the normalized gate input, pinned at `1.0`
 * for any all-supporting set), this score *rises with the number of
 * independent supporting groups* — so a claim corroborated by a second
 * independent source scores strictly higher than the same claim alone. It is a
 * read-side **ranking / legibility** signal ("best-evidenced first" — e.g. the
 * durable-memory harvest queue), **never a gate**: it feeds no adoption or
 * promotion threshold, so adding it cannot shift any belief's lifecycle and the
 * Parallax invariant (two `external_document` sources can't auto-promote) is
 * untouched. The gate stays {@link aggregateStrength} + the quality check.
 *
 * Model: a **noisy-OR** over independent groups — "the probability that at
 * least one independent source is right". Each group contributes
 * `p = quality × freshness × SOURCE_CONFIDENCE_CEILING ∈ [0, 0.95]`:
 *
 *   supportConfidence    = 1 − ∏ (1 − pᵢ)   over supporting groups
 *   contradictConfidence = 1 − ∏ (1 − pᵢ)   over contradicting groups
 *   score = supportConfidence × (1 − contradictConfidence)
 *
 * Properties (all probe-pinned, `corroboration-strength-rewards-independent-sources`):
 *  - **monotone** in independent supporting groups (each added group with
 *    `p > 0` strictly raises the score),
 *  - **saturating** and **bounded** in `[0, 1)` (added sources yield
 *    diminishing returns; clamped at {@link MAX_CORROBORATION} so even a tail
 *    of strong sources that underflows the noisy-OR product never reaches `1`),
 *  - **quality-weighted** (a `direct_observation` corroborator raises more than
 *    an `external_document` one), and
 *  - **dampened by contradiction** (a strong contradicting group pulls it
 *    toward `0`).
 *
 * Same independence-group semantics as `aggregateStrength` (shared
 * {@link strongestPerGroup}): a same-source re-read in one group does not
 * inflate it, and `synthetic_probe` (weight `0`) contributes nothing. Like its
 * sibling this is a v0 heuristic, not calibrated, and is deliberately **off**
 * the stable public-API ledger.
 */
export function corroborationStrength(evidence: EvidenceSet): number {
  if (evidence.items.length === 0) return 0

  let supportMiss = 1 // ∏ (1 − pᵢ) over supporting groups
  let contradictMiss = 1 // ∏ (1 − pᵢ) over contradicting groups
  for (const best of strongestPerGroup(evidence)) {
    if (best.weight <= 0) continue // synthetic_probe etc.: never affects real strength
    const p = best.weight * SOURCE_CONFIDENCE_CEILING
    if (best.item.relation === "supports") supportMiss *= 1 - p
    else if (best.item.relation === "contradicts") contradictMiss *= 1 - p
    // "contextualizes" doesn't contribute either way
  }

  const supportConfidence = 1 - supportMiss
  const contradictConfidence = 1 - contradictMiss
  // Clamp below 1: with enough strong independent groups `supportMiss`
  // underflows and `1 − supportMiss` rounds to exactly 1.0 in float64, which
  // would break the `[0, 1)` bound. Saturate at the cap instead.
  return Math.min(supportConfidence * (1 - contradictConfidence), MAX_CORROBORATION)
}
