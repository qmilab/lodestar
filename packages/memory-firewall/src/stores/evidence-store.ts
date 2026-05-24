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
    return ids
      .map((id) => this.byId.get(id))
      .filter((e): e is EvidenceSet => e !== undefined)
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

/**
 * Compute a strength score for an evidence set.
 *
 * Returns a value in [-1, 1]: positive means net-supporting,
 * negative means net-contradicting, zero means no information.
 *
 * Independence groups are deduplicated: multiple items in the same
 * group contribute as one, taking the maximum weight in the group.
 *
 * This is deliberately a simple v0 heuristic. Real calibration of the
 * aggregator is a research question (see research/benchmarks/).
 */
export function aggregateStrength(evidence: EvidenceSet): number {
  if (evidence.items.length === 0) return 0

  // Group by independence_group; items without a group are each their own group.
  const groups = new Map<string, EvidenceItem[]>()
  for (const item of evidence.items) {
    const key = item.independence_group ?? `__solo_${crypto.randomUUID()}`
    const existing = groups.get(key) ?? []
    existing.push(item)
    groups.set(key, existing)
  }

  let supportWeight = 0
  let contradictWeight = 0

  for (const group of groups.values()) {
    // Within a group, take the strongest representative
    const best = group.reduce((acc, item) => {
      const w = QUALITY_WEIGHT[item.quality] * FRESHNESS_WEIGHT[item.freshness]
      return w > acc.weight ? { item, weight: w } : acc
    }, { item: group[0]!, weight: 0 })

    if (best.item.relation === "supports") supportWeight += best.weight
    else if (best.item.relation === "contradicts") contradictWeight += best.weight
    // "contextualizes" doesn't contribute either way
  }

  const total = supportWeight + contradictWeight
  if (total === 0) return 0
  return (supportWeight - contradictWeight) / total
}
