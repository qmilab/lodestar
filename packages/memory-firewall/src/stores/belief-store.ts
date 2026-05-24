import type {
  Belief,
  BeliefAuthority,
  FreshnessStatus,
  ResourceScope,
  RetrievalStatus,
  SecurityStatus,
  Sensitivity,
  TruthStatus,
} from "@qmilab/lodestar-core"

/**
 * Storage for beliefs.
 *
 * Each belief tracks four orthogonal lifecycle axes:
 * - truth_status: unverified / supported / contradicted / superseded
 * - retrieval_status: hidden / restricted / normal / privileged_only / blocked
 * - security_status: clean / suspicious / quarantined / malicious
 * - freshness_status: fresh / stale / expired
 *
 * Transitions on each axis are independent and recorded separately.
 */
export interface BeliefStore {
  put(belief: Belief): Promise<void>
  get(id: string): Promise<Belief | undefined>
  list(filter?: BeliefFilter): Promise<Belief[]>
  history(id: string): Promise<BeliefAxisTransition[]>
  transition(input: BeliefAxisTransitionInput): Promise<BeliefAxisTransition>
}

export interface BeliefFilter {
  claim_id?: string
  scope?: ResourceScope
  authority?: BeliefAuthority[]
  truth_status?: TruthStatus[]
  retrieval_status?: RetrievalStatus[]
  security_status?: SecurityStatus[]
  freshness_status?: FreshnessStatus[]
  max_sensitivity?: Sensitivity
  calibration_class?: string
}

export type LifecycleAxis = "truth_status" | "retrieval_status" | "security_status" | "freshness_status"

export interface BeliefAxisTransitionInput {
  belief_id: string
  axis: LifecycleAxis
  from_value: string
  to_value: string
  by_actor_id: string
  rationale_id: string
}

export interface BeliefAxisTransition extends BeliefAxisTransitionInput {
  id: string
  at: string
}

// -----------------------------------------------------------------------------
// In-memory implementation
// -----------------------------------------------------------------------------

const SENSITIVITY_ORDER: Sensitivity[] = ["public", "internal", "confidential", "secret"]

function sensitivityRank(s: Sensitivity): number {
  return SENSITIVITY_ORDER.indexOf(s)
}

export class InMemoryBeliefStore implements BeliefStore {
  private beliefs = new Map<string, Belief>()
  private transitions = new Map<string, BeliefAxisTransition[]>()

  async put(belief: Belief): Promise<void> {
    if (this.beliefs.has(belief.id)) {
      throw new Error(`BeliefStore: belief ${belief.id} already exists; use transition() for axis changes`)
    }
    this.beliefs.set(belief.id, belief)
    this.transitions.set(belief.id, [])
  }

  async get(id: string): Promise<Belief | undefined> {
    return this.beliefs.get(id)
  }

  async list(filter?: BeliefFilter): Promise<Belief[]> {
    const all = Array.from(this.beliefs.values())
    if (!filter) return all
    return all.filter((b) => {
      if (filter.claim_id && b.claim_id !== filter.claim_id) return false
      if (filter.authority && !filter.authority.includes(b.authority)) return false
      if (filter.truth_status && !filter.truth_status.includes(b.truth_status)) return false
      if (filter.retrieval_status && !filter.retrieval_status.includes(b.retrieval_status)) return false
      if (filter.security_status && !filter.security_status.includes(b.security_status)) return false
      if (filter.freshness_status && !filter.freshness_status.includes(b.freshness_status)) return false
      if (filter.calibration_class && b.calibration_class !== filter.calibration_class) return false
      if (filter.max_sensitivity && sensitivityRank(b.sensitivity) > sensitivityRank(filter.max_sensitivity)) {
        return false
      }
      if (filter.scope) {
        if (b.scope.level !== filter.scope.level) return false
        if (b.scope.identifier !== filter.scope.identifier) return false
      }
      return true
    })
  }

  async history(id: string): Promise<BeliefAxisTransition[]> {
    return this.transitions.get(id) ?? []
  }

  async transition(input: BeliefAxisTransitionInput): Promise<BeliefAxisTransition> {
    const belief = this.beliefs.get(input.belief_id)
    if (!belief) {
      throw new Error(`BeliefStore: belief ${input.belief_id} not found`)
    }
    const current = belief[input.axis]
    if (current !== input.from_value) {
      throw new Error(
        `BeliefStore: transition on axis ${input.axis} expected from=${input.from_value} but belief has ${current}`,
      )
    }
    const transition: BeliefAxisTransition = {
      id: crypto.randomUUID(),
      ...input,
      at: new Date().toISOString(),
    }
    const history = this.transitions.get(input.belief_id) ?? []
    history.push(transition)
    this.transitions.set(input.belief_id, history)

    // Apply the change to the stored belief
    const updated: Belief = { ...belief, [input.axis]: input.to_value }
    this.beliefs.set(input.belief_id, updated)
    return transition
  }
}
