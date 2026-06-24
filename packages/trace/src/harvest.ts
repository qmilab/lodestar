import {
  type Belief,
  BeliefSchema,
  type Claim,
  ClaimSchema,
  type EventEnvelope,
  type EvidenceSet,
  EvidenceSetSchema,
  FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
  type RetrievalStatus,
} from "@qmilab/lodestar-core"

/**
 * The durable-memory harvest queue, projected from a flat event stream.
 *
 * This is a pure projection over `EventEnvelope[]`, in the same family as
 * `projectChain` / `pendingApprovals` — no I/O, no writes. It surfaces, at
 * end-of-run, the beliefs worth carrying into the *next* run as **durable
 * lessons** (ADR-0031): each one a review-ready candidate carrying the
 * evidence + provenance a human needs to judge it before keeping it.
 *
 * The mapping is locked (ADR-0031): a `Belief` maps to a durable **lesson**,
 * not to current world-state (the `WorldModel` is the current-state store).
 * The projection's job is to surface honest evidence + provenance — *not* to
 * classify a lesson as keeper-worthy. That is the human reviewer's call, and
 * the projection is **advisory, never auto-promoted** (every item is
 * `status: "candidate"`). Whether a given belief reads as a useful lesson or
 * as state noise is an upstream extractor-design choice, not something this
 * surface reconciles.
 *
 * Two things the projection *does* decide, both narrow and security-driven —
 * the **candidacy gate** ({@link isHarvestable}):
 *
 *  1. A candidate's current `truth_status` must be `supported`. An
 *     `unverified` / `contradicted` belief is not a corroborated lesson. A
 *     `superseded` belief is not surfaced on its own — it appears only as the
 *     *history* of the successor that replaced it (decision 2 below).
 *  2. A candidate must be `security_status: clean` and `retrieval_status` in
 *     {`normal`, `restricted`}. Surfacing a quarantined / malicious or a
 *     hard-demoted (`hidden` / `blocked` / `privileged_only`) belief as a
 *     keeper candidate would launder firewall-rejected content past the
 *     no-self-promotion guarantee — into a human "Keep" queue this time. So
 *     the harvest gate mirrors the firewall's own `DEFAULT_CONTEXT_POLICY`
 *     on exactly the security-relevant axes.
 *
 * Everything else (`freshness`, `sensitivity`, `scope`, `confidence`) is
 * **surfaced, not gated** — it is the reviewer's call, and an egress consumer
 * (the session shipper) applies its own sensitivity ceiling separately. A
 * stale lesson may still be worth keeping; a current-state-shaped lesson is
 * noise the reviewer discards. The projection shows what is in the log; it
 * does not pre-judge.
 *
 * Current lifecycle state is **reconstructed**, not read from a snapshot: a
 * belief is adopted via a `belief.adopted` event carrying the full `Belief`,
 * and its axes may later move via `firewall.belief.transitioned` events. So a
 * belief adopted `unverified` then promoted to `supported` *is* a candidate,
 * and one adopted `supported` then quarantined *is not* — the reconstruction
 * replays the transitions in logical-clock order.
 */

/**
 * A prior lesson a candidate replaced, surfaced for audit. Supersession is the
 * lesson-replacement primitive (ADR-0031): a newer lesson replaces an older one
 * via `superseded_by` while **preserving** the history, never overwriting it —
 * so a reviewer sees "we used to believe X, then learned Y".
 */
export interface SupersededLesson {
  /** The replaced belief, lifecycle axes reconstructed to current state (`truth_status: "superseded"`). */
  belief: Belief
  /** The replaced belief's claim — present when its `claim.extracted` is in the log. */
  claim?: Claim
}

/**
 * A review-ready durable-memory candidate: a current, supported belief
 * proposed as a "lesson" worth carrying into the next run, with the evidence +
 * provenance a human reviewer needs. Advisory only — never auto-promoted.
 *
 * Mirrors {@link import("./approvals.js").PendingApproval}: a pure projection
 * surfacing *what is worth keeping*, never keeping it. The keep/discard
 * decision is a separate write-side surface.
 */
export interface MemoryCandidate {
  project_id: string
  session_id: string
  /** The candidate belief, lifecycle axes reconstructed to current state (`truth_status: "supported"`). */
  belief: Belief
  /** The belief's claim — statement, structured predicate, source observations. Present when `claim.extracted` is in the log. */
  claim?: Claim
  /** The evidence set the belief cleared against. Present when an `evidence.assessed` for the claim is in the log. */
  evidence?: EvidenceSet
  /** Prior lessons this one replaced, newest-first — the supersession audit trail. Empty when standalone. */
  supersedes: SupersededLesson[]
  /** Always `"candidate"`: advisory, human-review gated. Mirrors `PendingApproval.status`. */
  status: "candidate"
}

/** Retrieval states a keeper candidate may carry — mirrors the firewall's adopted/default states. */
const ELIGIBLE_RETRIEVAL: ReadonlySet<RetrievalStatus> = new Set(["normal", "restricted"])

/** The four lifecycle axes a `firewall.belief.transitioned` event can move. */
const LIFECYCLE_AXES: ReadonlySet<string> = new Set([
  "truth_status",
  "retrieval_status",
  "security_status",
  "freshness_status",
])

/** A normalised belief-axis transition read tolerantly from the event stream. */
interface BeliefTransition {
  belief_id: string
  axis: string
  to_value: string
  superseded_by?: string
}

/**
 * Derive the durable-memory harvest queue from a flat event stream.
 *
 * Pure function. No I/O. Safe to call on partial logs. The candidacy rules and
 * the supersession-history walk are documented on {@link MemoryCandidate} and
 * the module header.
 *
 * Candidates are returned oldest-first by the belief's `observed_at`
 * (tie-broken by belief id) for a stable review order, matching
 * `pendingApprovals`' oldest-first convention.
 */
export function harvestCandidates(
  events: EventEnvelope[],
  filter?: { session_id?: string; project_id?: string },
): MemoryCandidate[] {
  const filtered = events.filter((e) => {
    if (filter?.session_id && e.session_id !== filter.session_id) return false
    if (filter?.project_id && e.project_id !== filter.project_id) return false
    return true
  })
  // Replay in logical-clock order so adoption precedes its transitions.
  filtered.sort((a, b) => a.logical_clock - b.logical_clock)

  const adopted = new Map<string, Belief>()
  const origin = new Map<string, { project_id: string; session_id: string }>()
  const claims = new Map<string, Claim>()
  const evidenceByClaim = new Map<string, EvidenceSet>()
  const transitions: BeliefTransition[] = []

  for (const event of filtered) {
    const { type } = event
    if (type === "belief.adopted") {
      const parsed = BeliefSchema.safeParse(event.payload)
      if (parsed.success) {
        adopted.set(parsed.data.id, parsed.data)
        origin.set(parsed.data.id, {
          project_id: event.project_id,
          session_id: event.session_id,
        })
      }
      continue
    }
    if (type === "claim.extracted") {
      const parsed = ClaimSchema.safeParse(event.payload)
      if (parsed.success) claims.set(parsed.data.id, parsed.data)
      continue
    }
    if (type === "evidence.assessed") {
      const parsed = EvidenceSetSchema.safeParse(event.payload)
      if (parsed.success) {
        // Keep the latest assessment per claim — re-assessment supersedes.
        const prev = evidenceByClaim.get(parsed.data.claim_id)
        if (!prev || parsed.data.assessed_at >= prev.assessed_at) {
          evidenceByClaim.set(parsed.data.claim_id, parsed.data)
        }
      }
      continue
    }
    const transition = readBeliefTransition(type, event.payload)
    if (transition) transitions.push(transition)
  }

  // Reconstruct each belief's current lifecycle state by replaying its
  // transitions in clock order. Each step re-validates into a Belief so the
  // result is type-correct; a bogus `to_value` is ignored, keeping prior state.
  const reconstructed = new Map<string, Belief>(adopted)
  for (const t of transitions) {
    const belief = reconstructed.get(t.belief_id)
    if (!belief) continue // no full record to reconstruct against — skip
    const next: Record<string, unknown> = { ...belief }
    if (LIFECYCLE_AXES.has(t.axis)) next[t.axis] = t.to_value
    if (t.superseded_by) next.superseded_by = t.superseded_by
    const parsed = BeliefSchema.safeParse(next)
    if (parsed.success) reconstructed.set(t.belief_id, parsed.data)
  }

  // old belief id → successor id (from a transition's superseded_by, or a
  // re-emitted belief record that already carries it).
  const successorOf = new Map<string, string>()
  for (const [id, belief] of reconstructed) {
    if (belief.superseded_by) successorOf.set(id, belief.superseded_by)
  }
  // successor id → [old belief ids it replaced]
  const predecessorsOf = new Map<string, string[]>()
  for (const [oldId, newId] of successorOf) {
    const arr = predecessorsOf.get(newId)
    if (arr) arr.push(oldId)
    else predecessorsOf.set(newId, [oldId])
  }

  const candidates: MemoryCandidate[] = []
  for (const [id, belief] of reconstructed) {
    if (!isHarvestable(belief)) continue
    const o = origin.get(id)
    if (!o) continue // a harvestable belief always came from a belief.adopted event
    const item: MemoryCandidate = {
      project_id: o.project_id,
      session_id: o.session_id,
      belief,
      supersedes: collectHistory(id, predecessorsOf, reconstructed, claims),
      status: "candidate",
    }
    const claim = claims.get(belief.claim_id)
    if (claim) item.claim = claim
    const evidence = evidenceByClaim.get(belief.claim_id)
    if (evidence) item.evidence = evidence
    candidates.push(item)
  }

  candidates.sort((a, b) => {
    const byTime = a.belief.observed_at.localeCompare(b.belief.observed_at)
    return byTime !== 0 ? byTime : a.belief.id.localeCompare(b.belief.id)
  })
  return candidates
}

/**
 * The candidacy gate (ADR-0031). A belief is a keeper candidate only when its
 * reconstructed current state is a corroborated, clean, retrievable lesson —
 * the security-relevant subset of the firewall's `DEFAULT_CONTEXT_POLICY`. See
 * the module header for why freshness / sensitivity / scope are *not* gated.
 */
function isHarvestable(belief: Belief): boolean {
  return (
    belief.truth_status === "supported" &&
    belief.security_status === "clean" &&
    ELIGIBLE_RETRIEVAL.has(belief.retrieval_status)
  )
}

/**
 * Walk the supersession chain backwards from a head belief, collecting every
 * prior lesson it (transitively) replaced. Cycle-safe via a visited set;
 * returned newest-first by `observed_at` so the immediate predecessor leads.
 */
function collectHistory(
  headId: string,
  predecessorsOf: Map<string, string[]>,
  reconstructed: Map<string, Belief>,
  claims: Map<string, Claim>,
): SupersededLesson[] {
  const out: SupersededLesson[] = []
  const visited = new Set<string>([headId])
  const queue = [...(predecessorsOf.get(headId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || visited.has(id)) continue
    visited.add(id)
    const belief = reconstructed.get(id)
    if (belief) {
      const lesson: SupersededLesson = { belief }
      const claim = claims.get(belief.claim_id)
      if (claim) lesson.claim = claim
      out.push(lesson)
    }
    for (const pred of predecessorsOf.get(id) ?? []) queue.push(pred)
  }
  out.sort((a, b) => {
    const byTime = b.belief.observed_at.localeCompare(a.belief.observed_at)
    return byTime !== 0 ? byTime : a.belief.id.localeCompare(b.belief.id)
  })
  return out
}

/**
 * Read a belief-axis transition from an event, tolerantly. Recognises the
 * canonical `firewall.belief.transitioned` type, a bare `belief.transitioned`
 * (the synthetic shape some probes/loops emit), or any payload tagged
 * `kind: "belief.transitioned"`. Returns `undefined` for anything else.
 */
function readBeliefTransition(type: string, payload: unknown): BeliefTransition | undefined {
  const p = payload as Record<string, unknown> | undefined
  const looksLikeTransition =
    type === FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE ||
    type === "belief.transitioned" ||
    p?.kind === "belief.transitioned"
  if (!looksLikeTransition || !p) return undefined
  const { belief_id, axis, to_value, superseded_by } = p
  if (typeof belief_id !== "string" || typeof axis !== "string" || typeof to_value !== "string") {
    return undefined
  }
  const transition: BeliefTransition = { belief_id, axis, to_value }
  if (typeof superseded_by === "string" && superseded_by.length > 0) {
    transition.superseded_by = superseded_by
  }
  return transition
}
