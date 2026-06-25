import {
  type Belief,
  BeliefSchema,
  type Claim,
  ClaimSchema,
  type EventEnvelope,
  type EvidenceSet,
  EvidenceSetSchema,
  FIREWALL_BELIEF_ADOPTED_EVENT_TYPE,
  FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
  FIREWALL_EVENT_SCHEMA_VERSION,
  FirewallBeliefAdoptedPayloadSchema,
  FirewallBeliefTransitionedPayloadSchema,
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
 *
 * Both the belief's **adoption** and its lifecycle **transitions** are trusted
 * only when **firewall-authored**, because a governed agent's raw `ctx.emit`
 * writes to the same log but is pinned to the session schema version and cannot
 * stamp the firewall's (`FIREWALL_EVENT_SCHEMA_VERSION`):
 *
 *  - **Adoption.** A `belief.adopted` event carries the full `Belief`, but it is
 *    surfaced only when a host-authored `firewall.belief.adopted@1` audit event
 *    (schema-stamped, agent-unforgeable) confirms the *same* `belief_id` **and**
 *    the record's `claim_id` matches the audit's. So an agent cannot
 *    `ctx.emit("belief.adopted", …)` a fabricated belief (no audit) nor bind a
 *    genuine id to a different claim's content (claim_id mismatch). The full
 *    record is taken **first-wins** per id, so a later forged re-emit cannot
 *    overwrite a genuine adoption's content. The candidate's evidence is the exact
 *    set the audit's `evidence_id` names (not the latest assessment for the claim);
 *    the surfaced claim + evidence **content** is likewise first-wins per id, so an
 *    agent cannot `ctx.emit` a same-id `claim.extracted` / `evidence.assessed` to
 *    overwrite the provenance shown for an authenticated belief.
 *  - **Transitions** ({@link readBeliefTransition}): the canonical
 *    `firewall.belief.transitioned` type, `schema_version ===
 *    FIREWALL_EVENT_SCHEMA_VERSION`, and a payload that strictly validates — so an
 *    agent cannot emit a fake `security_status → clean` transition to launder a
 *    belief the firewall genuinely quarantined.
 *
 * Authentication is **per-session**: the projection processes each
 * `(project_id, session_id)` independently, so a firewall audit from one session
 * can never authenticate a `belief.adopted` record from another (a later session
 * could otherwise `ctx.emit` a clean record reusing a known prior `belief_id`, and
 * the prior session's genuine audit would satisfy the id check). Per-session maps
 * also keep claim/evidence content from bleeding across sessions.
 *
 * (A pure projection still cannot defend against direct log-file tampering — that
 * is the signing boundary every projection shares, exactly as `pendingApprovals`
 * trusts the guard's audit. What this closes are the *in-process* forgery paths a
 * governed agent has via `ctx.emit`.)
 *
 * The security gate applies wherever firewall-rejected content would reach the
 * Keep queue — a candidate **and** the supersession history under it. A
 * quarantined / hard-demoted predecessor is dropped from `supersedes` even
 * though it is `superseded` (never a top-level candidate either), so a poisoned
 * lesson cannot ride in as "history".
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

/** A firewall-authored belief-axis transition. `axis` is the locked four-value enum. */
interface BeliefTransition {
  belief_id: string
  axis: "truth_status" | "retrieval_status" | "security_status" | "freshness_status"
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

  // Process each (project_id, session_id) independently. Authentication must
  // never cross a session boundary: a firewall adoption audit from one session
  // must not authenticate a `belief.adopted` record from another (a later
  // session could `ctx.emit` a clean record reusing a known prior belief_id, and
  // the prior session's genuine audit would otherwise satisfy the check). Per-
  // session maps also keep claim/evidence content from bleeding across sessions.
  const bySession = new Map<string, EventEnvelope[]>()
  for (const event of filtered) {
    const key = `${event.project_id} ${event.session_id}`
    const group = bySession.get(key)
    if (group) group.push(event)
    else bySession.set(key, [event])
  }

  const candidates: MemoryCandidate[] = []
  for (const group of bySession.values()) {
    candidates.push(...harvestSession(group))
  }

  // Stable, oldest-first review order across all sessions.
  candidates.sort((a, b) => {
    const byTime = a.belief.observed_at.localeCompare(b.belief.observed_at)
    return byTime !== 0 ? byTime : a.belief.id.localeCompare(b.belief.id)
  })
  return candidates
}

/**
 * Harvest one session's candidates. `events` all share a single
 * `(project_id, session_id)`, so every id-keyed map below is session-scoped and
 * authentication cannot cross a session boundary. Returns the session's
 * candidates unsorted (the caller applies the global order).
 */
function harvestSession(events: EventEnvelope[]): MemoryCandidate[] {
  // Replay in logical-clock order so adoption precedes its transitions.
  const ordered = [...events].sort((a, b) => a.logical_clock - b.logical_clock)
  const project_id = ordered[0]?.project_id ?? ""
  const session_id = ordered[0]?.session_id ?? ""

  const adopted = new Map<string, Belief>()
  // belief_id → the firewall's host-authored adoption record (`firewall.belief.adopted@1`).
  // It carries the `claim_id` + `evidence_id` that actually cleared the gate, so it
  // both authenticates the belief (an agent's `ctx.emit` can't stamp the firewall
  // schema version) and binds the surfaced content to what the firewall approved.
  const firewallAdopted = new Map<string, { claim_id: string; evidence_id: string }>()
  const claims = new Map<string, Claim>()
  const evidenceById = new Map<string, EvidenceSet>()
  const transitions: BeliefTransition[] = []

  for (const event of ordered) {
    const { type } = event
    if (type === "belief.adopted") {
      const parsed = BeliefSchema.safeParse(event.payload)
      // First-wins: the adoption record is set once; a later forged re-emit for
      // the same id cannot overwrite a genuine adoption's content.
      if (parsed.success && !adopted.has(parsed.data.id)) adopted.set(parsed.data.id, parsed.data)
      continue
    }
    if (
      type === FIREWALL_BELIEF_ADOPTED_EVENT_TYPE &&
      event.schema_version === FIREWALL_EVENT_SCHEMA_VERSION
    ) {
      const parsed = FirewallBeliefAdoptedPayloadSchema.safeParse(event.payload)
      if (parsed.success && !firewallAdopted.has(parsed.data.belief_id)) {
        firewallAdopted.set(parsed.data.belief_id, {
          claim_id: parsed.data.claim_id,
          evidence_id: parsed.data.evidence_id,
        })
      }
      continue
    }
    if (type === "claim.extracted") {
      const parsed = ClaimSchema.safeParse(event.payload)
      // First-wins: the host emits a claim's content before an agent could
      // `ctx.emit` a same-id forgery (and ids are unpredictable), so a later
      // re-emit cannot overwrite the provenance shown for an authenticated belief.
      if (parsed.success && !claims.has(parsed.data.id)) claims.set(parsed.data.id, parsed.data)
      continue
    }
    if (type === "evidence.assessed") {
      const parsed = EvidenceSetSchema.safeParse(event.payload)
      // Keyed by evidence-set id (so a candidate attaches the exact set the
      // firewall's audit names), first-wins (so a later same-id re-emit cannot
      // overwrite the evidence content the firewall actually cleared against).
      if (parsed.success && !evidenceById.has(parsed.data.id)) {
        evidenceById.set(parsed.data.id, parsed.data)
      }
      continue
    }
    const transition = readBeliefTransition(event)
    if (transition) transitions.push(transition)
  }

  // Reconstruct each belief's current lifecycle state by replaying its
  // firewall-authored transitions in clock order. A belief is reconstructed only
  // when the firewall confirms it adopted *that record*: the adoption audit must
  // exist AND its `claim_id` must match the `belief.adopted` record's — so a
  // forged record (no audit, or a mismatched same-id record) never becomes a
  // candidate or history. Each step re-validates into a Belief so the result is
  // type-correct; a bogus `to_value` is ignored, keeping prior state.
  const reconstructed = new Map<string, Belief>()
  for (const [id, belief] of adopted) {
    const audit = firewallAdopted.get(id)
    if (audit && audit.claim_id === belief.claim_id) reconstructed.set(id, belief)
  }
  for (const t of transitions) {
    const belief = reconstructed.get(t.belief_id)
    if (!belief) continue // no full record to reconstruct against — skip
    const next: Record<string, unknown> = { ...belief }
    next[t.axis] = t.to_value
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
    const item: MemoryCandidate = {
      project_id,
      session_id,
      belief,
      supersedes: collectHistory(id, predecessorsOf, reconstructed, claims),
      status: "candidate",
    }
    const claim = claims.get(belief.claim_id)
    if (claim) item.claim = claim
    // Attach the exact evidence set the firewall recorded at adoption, not the
    // latest assessment for the claim (which may post-date what cleared the gate).
    const evidenceId = firewallAdopted.get(id)?.evidence_id
    const evidence = evidenceId ? evidenceById.get(evidenceId) : undefined
    if (evidence) item.evidence = evidence
    candidates.push(item)
  }
  return candidates
}

/**
 * The security gate — the no-launder axes. A belief whose content reaches the
 * Keep queue (a candidate *or* the history under one) must be `security_status:
 * clean` and retrievable; otherwise the firewall rejected it and surfacing it
 * would launder rejected content into the human queue. This is the
 * security-relevant subset of the firewall's `DEFAULT_CONTEXT_POLICY`.
 */
function passesSecurityGate(belief: Belief): boolean {
  return belief.security_status === "clean" && ELIGIBLE_RETRIEVAL.has(belief.retrieval_status)
}

/**
 * The candidacy gate (ADR-0031/0033). A belief is a *top-level* keeper candidate
 * only when its reconstructed current state is a corroborated lesson
 * (`truth_status: supported`) that also {@link passesSecurityGate}. See the module
 * header for why freshness / sensitivity / scope are *not* gated.
 */
function isHarvestable(belief: Belief): boolean {
  return belief.truth_status === "supported" && passesSecurityGate(belief)
}

/**
 * Walk the supersession chain backwards from a head belief, collecting every
 * prior lesson it (transitively) replaced. Cycle-safe via a visited set;
 * returned newest-first by `observed_at` so the immediate predecessor leads.
 *
 * A predecessor that fails {@link passesSecurityGate} (quarantined / hard-demoted
 * content the firewall rejected) is **omitted** from the history — its content
 * must not reach the Keep queue even as audit trail — but the walk still
 * traverses *through* it so a clean ancestor behind a rejected link still
 * surfaces. (Truth status is not gated here: a predecessor is `superseded` by
 * construction.)
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
    if (belief && passesSecurityGate(belief)) {
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
 * Read a **firewall-authored** belief-axis transition from an event. The lifecycle
 * the harvest gate reads must reflect only the firewall's decisions, so this trusts
 * an event only when all three hold: the canonical
 * `firewall.belief.transitioned` type, the host stamp `schema_version ===
 * FIREWALL_EVENT_SCHEMA_VERSION` (which a governed agent's `ctx.emit` is pinned
 * below and cannot forge), and a payload that strictly validates against the core
 * wire schema. A bare `belief.transitioned` or a `kind`-tagged agent emit is
 * **not** trusted — that is the forge-a-clearance path. Returns `undefined`
 * otherwise.
 */
function readBeliefTransition(event: EventEnvelope): BeliefTransition | undefined {
  if (
    event.type !== FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE ||
    event.schema_version !== FIREWALL_EVENT_SCHEMA_VERSION
  ) {
    return undefined
  }
  const parsed = FirewallBeliefTransitionedPayloadSchema.safeParse(event.payload)
  if (!parsed.success) return undefined
  const { belief_id, axis, to_value, superseded_by } = parsed.data
  const transition: BeliefTransition = { belief_id, axis, to_value }
  if (superseded_by !== undefined && superseded_by.length > 0) {
    transition.superseded_by = superseded_by
  }
  return transition
}
