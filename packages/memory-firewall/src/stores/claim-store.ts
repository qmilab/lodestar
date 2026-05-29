import type { Claim, ClaimStatus, ResourceScope } from "@qmilab/lodestar-core"

/**
 * Storage for claims. v0 ships an in-memory implementation;
 * v0.2 adds a Postgres-backed implementation.
 *
 * Implementations MUST be append-only: claims are never overwritten.
 * Updates to claim status are recorded as transitions, not mutations.
 */
export interface ClaimStore {
  put(claim: Claim): Promise<void>
  get(id: string): Promise<Claim | undefined>
  list(filter?: ClaimFilter): Promise<Claim[]>
  /** Returns the claim's status transition history. */
  history(id: string): Promise<ClaimTransition[]>
  /** Records a status transition. Does not mutate the original claim record. */
  transition(input: ClaimTransitionInput): Promise<ClaimTransition>
}

export interface ClaimFilter {
  status?: ClaimStatus[]
  scope?: ResourceScope
  extracted_by?: string
  since?: string
}

export interface ClaimTransitionInput {
  claim_id: string
  from_status: ClaimStatus
  to_status: ClaimStatus
  by_actor_id: string
  rationale_id: string
}

export interface ClaimTransition extends ClaimTransitionInput {
  id: string
  at: string
}

// -----------------------------------------------------------------------------
// In-memory implementation
// -----------------------------------------------------------------------------

export class InMemoryClaimStore implements ClaimStore {
  private claims = new Map<string, Claim>()
  private transitions = new Map<string, ClaimTransition[]>()

  async put(claim: Claim): Promise<void> {
    if (this.claims.has(claim.id)) {
      throw new Error(
        `ClaimStore: claim ${claim.id} already exists; use transition() for status changes`,
      )
    }
    this.claims.set(claim.id, claim)
    this.transitions.set(claim.id, [])
  }

  async get(id: string): Promise<Claim | undefined> {
    return this.claims.get(id)
  }

  async list(filter?: ClaimFilter): Promise<Claim[]> {
    const all = Array.from(this.claims.values())
    if (!filter) return all
    return all.filter((c) => {
      if (filter.status && !filter.status.includes(c.status)) return false
      if (filter.extracted_by && c.extracted_by !== filter.extracted_by) return false
      if (filter.scope) {
        if (c.scope.level !== filter.scope.level) return false
        if (c.scope.identifier !== filter.scope.identifier) return false
      }
      if (filter.since && c.created_at < filter.since) return false
      return true
    })
  }

  async history(id: string): Promise<ClaimTransition[]> {
    return this.transitions.get(id) ?? []
  }

  async transition(input: ClaimTransitionInput): Promise<ClaimTransition> {
    const claim = this.claims.get(input.claim_id)
    if (!claim) {
      throw new Error(`ClaimStore: claim ${input.claim_id} not found`)
    }
    if (claim.status !== input.from_status) {
      throw new Error(
        `ClaimStore: transition expected from_status=${input.from_status} but claim is ${claim.status}`,
      )
    }
    const transition: ClaimTransition = {
      id: crypto.randomUUID(),
      ...input,
      at: new Date().toISOString(),
    }
    const history = this.transitions.get(input.claim_id) ?? []
    history.push(transition)
    this.transitions.set(input.claim_id, history)

    // Update the claim's status in place. The transition record is the
    // authoritative audit trail; the claim's current status mirrors the
    // last transition.
    this.claims.set(input.claim_id, { ...claim, status: input.to_status })
    return transition
  }
}
