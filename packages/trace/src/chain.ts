import type {
  Action,
  Belief,
  Claim,
  EventEnvelope,
  EvidenceSet,
  Observation,
  Outcome,
} from "@orrery/core"

/**
 * Projection of an event log into the epistemic chain.
 *
 * The projection is intentionally tolerant: any event whose payload can
 * be recognised as one of the chain primitives (Observation, Claim,
 * Belief, EvidenceSet, Action, Outcome) is captured. Events whose
 * payload is unrecognised — including the firewall audit events that
 * only carry ids — are still recorded in `transitions` so the report
 * can show *that* the firewall acted, even when it cannot show *what*
 * the underlying claim said.
 *
 * Callers that want richer reports should emit `claim.extracted` and
 * `belief.adopted` events whose payloads embed the full `Claim` and
 * `Belief` records (the greenfield example does exactly that).
 */
export interface ChainProjection {
  session_id: string
  project_id: string
  actor_ids: Set<string>
  first_event_at?: string
  last_event_at?: string
  event_count: number

  observations: Observation[]
  claims: Claim[]
  evidence_sets: EvidenceSet[]
  beliefs: Belief[]
  actions: ProjectedAction[]
  transitions: FirewallTransition[]
  cognitive_summaries: CognitiveSummary[]
  raw_events: EventEnvelope[]
}

/**
 * A projected Action: one entry per action.id, with the most recent
 * payload retained. The `outcome` field is captured when the action
 * reaches `completed` or `failed`.
 */
export interface ProjectedAction {
  /** May be undefined if only an `action.outcome` event has been seen for this id. */
  action?: Action
  outcome?: Outcome
  /** Final phase observed in the event log (proposed/approved/rejected/completed/failed). */
  terminal_phase: Action["phase"]
}

/**
 * A firewall transition surfaced from a `firewall.*` audit event. The
 * payload here is intentionally narrow — only IDs and the transition
 * shape — because that is what the firewall emits in v0.
 */
export interface FirewallTransition {
  kind: "claim.accepted" | "belief.adopted" | "belief.transitioned" | "unknown"
  claim_id?: string
  belief_id?: string
  evidence_id?: string
  axis?: string
  from_value?: string
  to_value?: string
  by_authority?: string
  by_actor_id?: string
  at?: string
  raw: unknown
}

/**
 * Output of the cognitive-core ingestion phase. Captured from
 * `cognitive.ingested` events.
 */
export interface CognitiveSummary {
  observation_id?: string
  claim_count?: number
  belief_count?: number
  world_model_keys?: string[]
}

/**
 * Project a flat event stream into the epistemic chain.
 *
 * Pure function. No I/O. Safe to call on partial logs.
 */
export function projectChain(
  events: EventEnvelope[],
  filter?: { session_id?: string; project_id?: string },
): ChainProjection {
  const filtered = events.filter((e) => {
    if (filter?.session_id && e.session_id !== filter.session_id) return false
    if (filter?.project_id && e.project_id !== filter.project_id) return false
    return true
  })

  filtered.sort((a, b) => a.logical_clock - b.logical_clock)

  const session_id = filter?.session_id ?? filtered[0]?.session_id ?? ""
  const project_id = filter?.project_id ?? filtered[0]?.project_id ?? ""

  const observations: Observation[] = []
  const claims: Claim[] = []
  const beliefs: Belief[] = []
  const evidence_sets: EvidenceSet[] = []
  const transitions: FirewallTransition[] = []
  const cognitive_summaries: CognitiveSummary[] = []
  const actorIds = new Set<string>()

  const actionsById = new Map<string, ProjectedAction>()

  for (const event of filtered) {
    actorIds.add(event.actor_id)
    const payload = event.payload as Record<string, unknown> | undefined
    const type = event.type

    if (type === "observation.recorded" && isObservationPayload(payload)) {
      observations.push(payload)
      continue
    }

    if (type === "claim.extracted" && isClaimPayload(payload)) {
      claims.push(payload)
      continue
    }

    if (type === "evidence.assessed" && isEvidenceSetPayload(payload)) {
      evidence_sets.push(payload)
      continue
    }

    if (type === "belief.adopted" && isBeliefPayload(payload)) {
      beliefs.push(payload)
      continue
    }

    if (type === "action.outcome" && isOutcomePayload(payload)) {
      const existing = actionsById.get(payload.action_id)
      if (existing) {
        existing.outcome = payload
      } else {
        actionsById.set(payload.action_id, {
          outcome: payload,
          terminal_phase: "completed",
        })
      }
      continue
    }

    if (type.startsWith("action.") && isActionPayload(payload)) {
      const action = payload
      const existing = actionsById.get(action.id)
      const next: ProjectedAction = {
        action,
        terminal_phase: action.phase,
      }
      if (existing?.outcome) next.outcome = existing.outcome
      actionsById.set(action.id, next)
      continue
    }

    if (type.startsWith("firewall.")) {
      transitions.push(projectFirewallTransition(type, payload))
      continue
    }

    if (type === "cognitive.ingested" && payload && typeof payload === "object") {
      const summary: CognitiveSummary = {}
      if (typeof payload.observation_id === "string") {
        summary.observation_id = payload.observation_id
      }
      if (typeof payload.claim_count === "number") {
        summary.claim_count = payload.claim_count
      }
      if (typeof payload.belief_count === "number") {
        summary.belief_count = payload.belief_count
      }
      if (Array.isArray(payload.world_model_keys)) {
        summary.world_model_keys = payload.world_model_keys.filter(
          (k): k is string => typeof k === "string",
        )
      }
      cognitive_summaries.push(summary)
    }
  }

  const actions = Array.from(actionsById.values()).sort((a, b) => {
    const aKey = a.action?.proposed_at ?? a.outcome?.observed_at ?? ""
    const bKey = b.action?.proposed_at ?? b.outcome?.observed_at ?? ""
    return aKey.localeCompare(bKey)
  })

  const firstEvent = filtered[0]
  const lastEvent = filtered[filtered.length - 1]

  const projection: ChainProjection = {
    session_id,
    project_id,
    actor_ids: actorIds,
    event_count: filtered.length,
    observations,
    claims,
    evidence_sets,
    beliefs,
    actions,
    transitions,
    cognitive_summaries,
    raw_events: filtered,
  }
  if (firstEvent) projection.first_event_at = firstEvent.timestamp
  if (lastEvent) projection.last_event_at = lastEvent.timestamp
  return projection
}

function projectFirewallTransition(
  type: string,
  payload: Record<string, unknown> | undefined,
): FirewallTransition {
  const raw = payload ?? {}
  const kind = matchFirewallKind(type, raw)
  const transition: FirewallTransition = { kind, raw }
  if (typeof raw.claim_id === "string") transition.claim_id = raw.claim_id
  if (typeof raw.belief_id === "string") transition.belief_id = raw.belief_id
  if (typeof raw.evidence_id === "string") transition.evidence_id = raw.evidence_id
  if (typeof raw.axis === "string") transition.axis = raw.axis
  if (typeof raw.from_value === "string") transition.from_value = raw.from_value
  if (typeof raw.to_value === "string") transition.to_value = raw.to_value
  if (typeof raw.by_authority === "string") transition.by_authority = raw.by_authority
  if (typeof raw.by_actor_id === "string") transition.by_actor_id = raw.by_actor_id
  if (typeof raw.at === "string") transition.at = raw.at
  return transition
}

function matchFirewallKind(
  type: string,
  raw: Record<string, unknown>,
): FirewallTransition["kind"] {
  const candidate = typeof raw.kind === "string" ? raw.kind : type.replace(/^firewall\./, "")
  if (
    candidate === "claim.accepted" ||
    candidate === "belief.adopted" ||
    candidate === "belief.transitioned"
  ) {
    return candidate
  }
  return "unknown"
}

function isObservationPayload(p: unknown): p is Observation {
  if (!p || typeof p !== "object") return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.schema === "string" &&
    typeof obj.trust === "string" &&
    typeof obj.sensitivity === "string"
  )
}

function isClaimPayload(p: unknown): p is Claim {
  if (!p || typeof p !== "object") return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.statement === "string" &&
    Array.isArray(obj.source_observation_ids) &&
    typeof obj.status === "string"
  )
}

function isEvidenceSetPayload(p: unknown): p is EvidenceSet {
  if (!p || typeof p !== "object") return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.claim_id === "string" &&
    Array.isArray(obj.items)
  )
}

function isBeliefPayload(p: unknown): p is Belief {
  if (!p || typeof p !== "object") return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.claim_id === "string" &&
    typeof obj.truth_status === "string" &&
    typeof obj.retrieval_status === "string"
  )
}

function isActionPayload(p: unknown): p is Action {
  if (!p || typeof p !== "object") return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.tool === "string" &&
    typeof obj.phase === "string" &&
    typeof obj.intent === "string"
  )
}

function isOutcomePayload(p: unknown): p is Outcome {
  if (!p || typeof p !== "object") return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.action_id === "string" &&
    typeof obj.result === "string"
  )
}
