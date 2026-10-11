import {
  type Action,
  ActionSchema,
  type Belief,
  BeliefSchema,
  type Claim,
  ClaimSchema,
  type EventEnvelope,
  FIREWALL_BELIEF_ADOPTED_EVENT_TYPE,
  FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
  ObservationSchema,
  type Outcome,
  OutcomeSchema,
  type Sensitivity,
  contentSensitivityForAction,
  isAboveCeiling,
  isSensitivity,
} from "@qmilab/lodestar-core"

/**
 * Belief taint / blast-radius projection (issue #182).
 *
 * "What did this belief touch?" — given a belief id, walk the causal edges the
 * log already records and list everything downstream of it. Pure projection over
 * `EventEnvelope[]`, in the same family as `projectChain` / `pendingApprovals` /
 * `harvestCandidates`: no I/O, no new event, no `packages/core` schema change,
 * never writes the log, never mutates its input.
 *
 * ## Edges walked
 *
 *   belief ──(decision.made.belief_dependencies)──▶ decision
 *   decision ──(action.decision_id)──▶ action   (any phase: proposed, held,
 *                                                 rejected, completed, failed …)
 *   action ──(outcome.action_id)──▶ outcome
 *   outcome ──(effect_observation_ids)──▶ observation
 *   observation ──(claim.source_observation_ids)──▶ claim ──(adoption)──▶ belief
 *
 * The last hop is how taint propagates *transitively*: a belief adopted from a
 * claim that was extracted from an observation a tainted action produced is itself
 * tainted, and its own dependent decisions/actions are walked in turn.
 * Supersession links (`Belief.superseded_by`, `firewall.belief.transitioned`'s
 * `superseded_by`) that touch a tainted belief are *reported* but not walked: a
 * successor replaces a belief, it is not derived from it.
 *
 * ## Walk order and cycle guard
 *
 * Breadth-first by "wave" (`depth`). The root belief is depth 0. Each wave takes
 * the beliefs newly tainted by the previous wave, finds the decisions that
 * depended on them, then those decisions' actions, outcomes, and the beliefs the
 * outcomes' observations fed — those beliefs form the next wave. Within every
 * list, entries sort by the `logical_clock` of the event that first revealed them
 * (ties by event id), so output is deterministic for a given log. Every belief,
 * decision, action and outcome id is visited **at most once** (first-reached wins,
 * which is the shortest path), so a feedback loop — an action whose outcome
 * re-derives a belief it already depended on — terminates.
 *
 * ## Authenticity: over-approximate on purpose
 *
 * Unlike `harvestCandidates`, which is a position of *trust* (a human is about to
 * keep a lesson) and so authenticates adoptions, this is a post-hoc *audit* of
 * damage. A false negative (a dependent the walk missed) is the dangerous error;
 * a false positive costs a reviewer a glance. So the projection follows the edges
 * as recorded and does not discard events an agent could have forged. An agent
 * that forges a `decision.made` naming the belief can only add noise to the set,
 * never remove a real dependent from it.
 *
 * ## Sensitivity ceiling
 *
 * The locked v0.2 ceiling, applied exactly as the shipper does (same core gate
 * primitives): ids, edges, phases and `payload_hash` are always shown; *content*
 * (a claim's statement, a decision's question, an action's intent + inputs) whose
 * source sensitivity outranks `sensitivityCeiling` (default `internal`) is
 * withheld, the node carrying `redacted: true` and the envelope's `payload_hash`.
 * A Claim uses its own `sensitivity`; an Action uses its contract's
 * `data_sensitivity` mapped onto the content scale; a decision, an outcome, and
 * anything not an exact known record **fail closed to `secret`** — the shipper's
 * posture.
 *
 * NOT on the stable public-API ledger: this is a v0 heuristic projection (the edge
 * set will grow), so its shape may change without a major bump.
 */

export interface TaintOptions {
  /** Content whose source sensitivity outranks this is withheld. Default `internal`. */
  sensitivityCeiling?: Sensitivity
}

/** Fields every node carries regardless of redaction. */
interface TaintNodeBase {
  /** Wave in which the walk first reached this node (root belief = 0). */
  depth: number
  /** Envelope id of the event that revealed the node. */
  event_id: string
  /** Hash of that event's payload — kept so a redacted node is still tamper-evident. */
  payload_hash: string
  /** The sensitivity the content was gated by. */
  sensitivity: Sensitivity
  /** True when content was withheld because `sensitivity` outranks the ceiling. */
  redacted: boolean
}

export interface TaintedBelief extends TaintNodeBase {
  belief_id: string
  claim_id?: string
  /** The tainted action whose output fed this belief; absent for the root. */
  via_action_id?: string
  /** Claim statement; absent when redacted or the claim is not in the log. */
  statement?: string
}

export interface TaintedDecision extends TaintNodeBase {
  decision_id: string
  /** Which tainted beliefs this decision listed as dependencies. */
  via_belief_ids: string[]
  /** The question; absent when redacted. */
  question?: string
}

export interface TaintedAction extends TaintNodeBase {
  action_id: string
  decision_id: string
  tool?: string
  /** Last phase seen in the log (proposed / pending_approval / rejected / completed …). */
  phase?: Action["phase"]
  /** Absent when redacted. */
  intent?: string
  inputs?: unknown
}

export interface TaintedOutcome extends TaintNodeBase {
  outcome_id: string
  action_id: string
  result?: Outcome["result"]
  /** Structural edges: always shown, even when the outcome content is redacted. */
  effect_observation_ids: string[]
}

export interface TaintSupersession {
  predecessor_id: string
  successor_id: string
}

export interface TaintSet {
  root_belief_id: string
  /** The ceiling actually applied. */
  sensitivity_ceiling: Sensitivity
  /** False when the log holds no adoption or reference of the root belief at all. */
  root_found: boolean
  /** The root first, then dependents by wave. */
  beliefs: TaintedBelief[]
  decisions: TaintedDecision[]
  actions: TaintedAction[]
  outcomes: TaintedOutcome[]
  supersessions: TaintSupersession[]
}

interface BeliefRecord {
  event: EventEnvelope
  claim_id?: string
  belief?: Belief
}

const ACTION_REJECTED_EVENT_TYPE = "action.rejected"

function asRecord(p: unknown): Record<string, unknown> | undefined {
  return p && typeof p === "object" ? (p as Record<string, unknown>) : undefined
}

function byClock(a: EventEnvelope, b: EventEnvelope): number {
  return a.logical_clock - b.logical_clock || a.id.localeCompare(b.id)
}

export function taintSet(
  events: EventEnvelope[],
  beliefId: string,
  options: TaintOptions = {},
): TaintSet {
  // Only an omitted ceiling takes the default; a present-but-invalid one must
  // fail loud (an unknown value ranks above everything and would redact nothing).
  const ceiling = options.sensitivityCeiling === undefined ? "internal" : options.sensitivityCeiling
  if (!isSensitivity(ceiling)) {
    throw new Error(`invalid sensitivity ceiling: ${JSON.stringify(ceiling)}`)
  }

  // Sort a copy — the input array is never mutated.
  const sorted = [...events].sort(byClock)

  // ── Index pass ───────────────────────────────────────────────────────────
  const beliefRecords = new Map<string, BeliefRecord>() // first adoption wins
  const beliefsByClaim = new Map<string, string[]>()
  const claims = new Map<string, { claim: Claim; event: EventEnvelope }>()
  const claimsByObservation = new Map<string, string[]>()
  const decisionEvents: Array<{
    event: EventEnvelope
    id: string
    deps: string[]
    p: Record<string, unknown>
  }> = []
  const actionsById = new Map<string, { action: Action; event: EventEnvelope }>()
  // Edges are UNIONED, never overwritten: a later (possibly forged) event naming a
  // different decision / successor must not erase the genuine earlier edge.
  const addEdge = <K, V>(m: Map<K, Set<V>>, k: K, v: V): void => {
    const set = m.get(k) ?? new Set<V>()
    set.add(v)
    m.set(k, set)
  }
  const actionDecision = new Map<string, Set<string>>() // action → every decision any action.* event names
  const observationsByAction = new Map<string, Set<string>>() // action id → observations it produced
  const outcomes: Array<{ event: EventEnvelope; outcome: Outcome }> = []
  const successor = new Map<string, Set<string>>() // predecessor → successors

  const noteBelief = (
    id: string,
    event: EventEnvelope,
    claimId?: string,
    belief?: Belief,
  ): void => {
    const existing = beliefRecords.get(id)
    if (!existing) {
      beliefRecords.set(id, {
        event,
        ...(claimId ? { claim_id: claimId } : {}),
        ...(belief ? { belief } : {}),
      })
    } else {
      // Keep the first event, but fill in what an ids-only first sighting lacked.
      if (!existing.claim_id && claimId) existing.claim_id = claimId
      if (!existing.belief && belief) existing.belief = belief
    }
    if (claimId) {
      const list = beliefsByClaim.get(claimId) ?? []
      if (!list.includes(id)) list.push(id)
      beliefsByClaim.set(claimId, list)
    }
  }

  for (const event of sorted) {
    const p = asRecord(event.payload)
    if (!p) continue
    const type = event.type

    if (type === "decision.made") {
      if (typeof p.id === "string" && Array.isArray(p.belief_dependencies)) {
        decisionEvents.push({
          event,
          id: p.id,
          deps: p.belief_dependencies.filter((b): b is string => typeof b === "string"),
          p,
        })
      }
      continue
    }

    if (type === "observation.recorded") {
      // The kernel records a tool's output as an observation whose
      // `source.invocation_id` is the action id — the edge ordinary Guard / MCP
      // sessions have (they emit no `action.outcome`).
      const o = ObservationSchema.safeParse(p)
      if (o.success) addEdge(observationsByAction, o.data.source.invocation_id, o.data.id)
      continue
    }

    if (type === "claim.extracted") {
      const c = ClaimSchema.safeParse(p)
      if (c.success && !claims.has(c.data.id)) {
        claims.set(c.data.id, { claim: c.data, event })
        for (const obs of c.data.source_observation_ids) {
          const list = claimsByObservation.get(obs) ?? []
          list.push(c.data.id)
          claimsByObservation.set(obs, list)
        }
      }
      continue
    }

    if (type === "belief.adopted" || type === FIREWALL_BELIEF_ADOPTED_EVENT_TYPE) {
      const full = BeliefSchema.safeParse(p)
      if (full.success) noteBelief(full.data.id, event, full.data.claim_id, full.data)
      else if (typeof p.belief_id === "string") {
        noteBelief(p.belief_id, event, typeof p.claim_id === "string" ? p.claim_id : undefined)
      }
      if (full.success && full.data.superseded_by)
        addEdge(successor, full.data.id, full.data.superseded_by)
      continue
    }

    if (type === "belief.transitioned" || type === FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE) {
      if (typeof p.belief_id === "string" && typeof p.superseded_by === "string") {
        addEdge(successor, p.belief_id, p.superseded_by)
      }
      continue
    }

    if (type === "action.outcome" || type === "outcome.observed") {
      const o = OutcomeSchema.safeParse(p)
      if (o.success) outcomes.push({ event, outcome: o.data })
      continue
    }

    if (type.startsWith("action.")) {
      const a = ActionSchema.safeParse(p)
      if (a.success) {
        actionsById.set(a.data.id, {
          action: a.data,
          event: actionsById.get(a.data.id)?.event ?? event,
        })
        if (a.data.decision_id) addEdge(actionDecision, a.data.id, a.data.decision_id)
      } else if (
        type === ACTION_REJECTED_EVENT_TYPE &&
        typeof p.action_id === "string" &&
        typeof p.decision_id === "string"
      ) {
        addEdge(actionDecision, p.action_id, p.decision_id)
      }
    }
  }

  // ── Walk ─────────────────────────────────────────────────────────────────
  const gate = (source: Sensitivity): { sensitivity: Sensitivity; redacted: boolean } => ({
    sensitivity: source,
    redacted: isAboveCeiling(source, ceiling),
  })

  const outBeliefs: TaintedBelief[] = []
  const outDecisions: TaintedDecision[] = []
  const outActions: TaintedAction[] = []
  const outOutcomes: TaintedOutcome[] = []

  const seenBeliefs = new Set<string>([beliefId])
  const seenDecisions = new Set<string>()
  const seenActions = new Set<string>()
  const seenOutcomes = new Set<string>()

  const beliefNode = (id: string, depth: number, viaAction?: string): TaintedBelief | undefined => {
    const rec = beliefRecords.get(id)
    if (!rec) return undefined
    const claimId = rec.claim_id ?? rec.belief?.claim_id
    const claimEntry = claimId ? claims.get(claimId) : undefined
    // Content (the statement) is the claim's; fail closed to secret if the claim
    // — the thing carrying the label — is not in the log.
    const g = gate(claimEntry?.claim.sensitivity ?? "secret")
    return {
      belief_id: id,
      ...(claimId ? { claim_id: claimId } : {}),
      ...(viaAction ? { via_action_id: viaAction } : {}),
      depth,
      event_id: rec.event.id,
      payload_hash: rec.event.payload_hash,
      ...g,
      ...(!g.redacted && claimEntry ? { statement: claimEntry.claim.statement } : {}),
    }
  }

  const rootRecord = beliefRecords.get(beliefId)
  const rootNode = beliefNode(beliefId, 0)
  if (rootNode) outBeliefs.push(rootNode)

  let frontier: string[] = [beliefId]
  let depth = 0
  let rootReferenced = rootRecord !== undefined

  while (frontier.length > 0) {
    depth += 1
    const tainted = new Set(frontier)
    const waveDecisionIds: string[] = []

    for (const d of decisionEvents) {
      if (seenDecisions.has(d.id)) continue
      const via = d.deps.filter((b) => tainted.has(b))
      if (via.length === 0) continue
      seenDecisions.add(d.id)
      waveDecisionIds.push(d.id)
      if (via.includes(beliefId)) rootReferenced = true
      const g = gate("secret") // a decision is never an exact known content record
      outDecisions.push({
        decision_id: d.id,
        via_belief_ids: via,
        depth,
        event_id: d.event.id,
        payload_hash: d.event.payload_hash,
        ...g,
        ...(!g.redacted && typeof (d.p.question ?? d.p.intent) === "string"
          ? { question: (d.p.question ?? d.p.intent) as string }
          : {}),
      })
    }

    // Actions justified by this wave's decisions. An action is attributed to a
    // decision via any `action.*` event that names it, so a rejected or held
    // action whose last event lost the field is still caught.
    const waveActionIds: string[] = []
    const decisionSet = new Set(waveDecisionIds)
    const candidateActionIds = new Set<string>([...actionsById.keys(), ...actionDecision.keys()])
    const actionOrder = [...candidateActionIds]
      .map((id) => ({ id, event: actionsById.get(id)?.event }))
      .filter((x) => {
        const decs = actionDecision.get(x.id)
        return decs !== undefined && [...decs].some((d) => decisionSet.has(d))
      })
    for (const { id } of actionOrder) {
      if (seenActions.has(id)) continue
      seenActions.add(id)
      waveActionIds.push(id)
      const rec = actionsById.get(id)
      const decisionId = [...(actionDecision.get(id) ?? [])].find((d) =>
        decisionSet.has(d),
      ) as string
      if (rec) {
        const g = gate(contentSensitivityForAction(rec.action.contract.data_sensitivity))
        outActions.push({
          action_id: id,
          decision_id: decisionId,
          tool: rec.action.tool,
          phase: rec.action.phase,
          depth,
          event_id: rec.event.id,
          payload_hash: rec.event.payload_hash,
          ...g,
          ...(!g.redacted ? { intent: rec.action.intent, inputs: rec.action.inputs } : {}),
        })
      } else {
        // Seen only as an id-bearing rejection: no content to gate, nothing to show.
        const ev = sorted.find((e) => asRecord(e.payload)?.action_id === id)
        outActions.push({
          action_id: id,
          decision_id: decisionId,
          depth,
          event_id: ev?.id ?? "",
          payload_hash: ev?.payload_hash ?? "",
          ...gate("secret"),
        })
      }
    }

    // Outcomes of this wave's actions, and the beliefs their output fed. An
    // action's output reaches claims two ways: an Outcome's effect observations,
    // and observations the kernel recorded with `source.invocation_id = action.id`
    // (the only edge ordinary Guard / MCP sessions emit).
    const actionSet = new Set(waveActionIds)
    const fed = new Map<string, string>() // observation id → tainted action id
    for (const id of waveActionIds) {
      for (const obs of observationsByAction.get(id) ?? []) if (!fed.has(obs)) fed.set(obs, id)
    }
    for (const { event, outcome } of outcomes) {
      if (!actionSet.has(outcome.action_id) || seenOutcomes.has(outcome.id)) continue
      seenOutcomes.add(outcome.id)
      const rec = actionsById.get(outcome.action_id)
      // Inherit the action's label; a bare outcome with no action record fails closed.
      const g = gate(
        rec ? contentSensitivityForAction(rec.action.contract.data_sensitivity) : "secret",
      )
      outOutcomes.push({
        outcome_id: outcome.id,
        action_id: outcome.action_id,
        // Content (result) is gated; the effect-observation ids are structural
        // edges and always shown.
        ...(!g.redacted ? { result: outcome.result } : {}),
        effect_observation_ids: outcome.effect_observation_ids,
        depth,
        event_id: event.id,
        payload_hash: event.payload_hash,
        ...g,
      })
      for (const obs of outcome.effect_observation_ids) {
        if (!fed.has(obs)) fed.set(obs, outcome.action_id)
      }
    }
    const newBeliefs: Array<{ id: string; via: string }> = []
    for (const [obs, via] of fed) {
      for (const claimId of claimsByObservation.get(obs) ?? []) {
        for (const b of beliefsByClaim.get(claimId) ?? []) {
          if (seenBeliefs.has(b)) continue
          seenBeliefs.add(b)
          newBeliefs.push({ id: b, via })
        }
      }
    }
    // Order by the adoption event's clock (then id), per the documented walk order.
    const clockOf = (id: string): number => beliefRecords.get(id)?.event.logical_clock ?? 0
    newBeliefs.sort((x, y) => clockOf(x.id) - clockOf(y.id) || x.id.localeCompare(y.id))
    const next: string[] = []
    for (const { id, via } of newBeliefs) {
      const node = beliefNode(id, depth, via)
      if (node) outBeliefs.push(node)
      next.push(id)
    }
    frontier = next
  }

  // Supersession links touching any tainted belief (reported, not walked).
  const supersessions: TaintSupersession[] = []
  for (const [pred, succs] of successor) {
    for (const succ of succs) {
      if (seenBeliefs.has(pred) || seenBeliefs.has(succ)) {
        supersessions.push({ predecessor_id: pred, successor_id: succ })
        if (pred === beliefId || succ === beliefId) rootReferenced = true
      }
    }
  }

  return {
    root_belief_id: beliefId,
    sensitivity_ceiling: ceiling,
    root_found: rootReferenced,
    beliefs: outBeliefs,
    decisions: outDecisions,
    actions: outActions,
    outcomes: outOutcomes,
    supersessions,
  }
}

/** Render a {@link TaintSet} as markdown for `lodestar report --taint`. */
export function renderTaintSet(t: TaintSet): string {
  const lines: string[] = []
  lines.push(`# Taint set — belief \`${t.root_belief_id}\``)
  lines.push("")
  lines.push(
    `Sensitivity ceiling: \`${t.sensitivity_ceiling}\` (content above it shows hash only).`,
  )
  if (!t.root_found) {
    lines.push("")
    lines.push("_Belief not found in this session's log — nothing is known to depend on it._")
    return lines.join("\n")
  }
  const hash = (n: TaintNodeBase): string =>
    n.redacted ? ` — redacted (\`${n.sensitivity}\`), payload_hash \`${n.payload_hash}\`` : ""

  lines.push("")
  lines.push(`## Decisions (${t.decisions.length})`)
  for (const d of t.decisions) {
    lines.push(
      `- \`${d.decision_id}\` (wave ${d.depth}, via ${d.via_belief_ids.map((b) => `\`${b}\``).join(", ")})${d.question ? `: ${d.question}` : ""}${hash(d)}`,
    )
  }
  lines.push("")
  lines.push(`## Actions (${t.actions.length})`)
  for (const a of t.actions) {
    lines.push(
      `- \`${a.action_id}\` ${a.tool ? `\`${a.tool}\` ` : ""}[${a.phase ?? "unknown"}] ← decision \`${a.decision_id}\`${a.intent ? `: ${a.intent}` : ""}${hash(a)}`,
    )
  }
  lines.push("")
  lines.push(`## Outcomes (${t.outcomes.length})`)
  for (const o of t.outcomes) {
    lines.push(`- \`${o.outcome_id}\` ${o.result ?? ""} ← action \`${o.action_id}\`${hash(o)}`)
  }
  lines.push("")
  lines.push(`## Dependent beliefs (${t.beliefs.length - (t.beliefs[0]?.depth === 0 ? 1 : 0)})`)
  for (const b of t.beliefs) {
    if (b.depth === 0) continue
    lines.push(
      `- \`${b.belief_id}\` (wave ${b.depth}, via action \`${b.via_action_id}\`)${b.statement ? `: ${b.statement}` : ""}${hash(b)}`,
    )
  }
  if (t.supersessions.length > 0) {
    lines.push("")
    lines.push(`## Supersessions (${t.supersessions.length})`)
    for (const s of t.supersessions) {
      lines.push(`- \`${s.predecessor_id}\` → superseded by \`${s.successor_id}\``)
    }
  }
  return lines.join("\n")
}
