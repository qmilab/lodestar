import type {
  EventEnvelope,
  Explanation,
  ReflectionCompletedPayload,
  ReflectionProposal,
  ReflectionTrigger,
  Revision,
} from "@qmilab/lodestar-core"
import {
  REFLECTION_COMPLETED_EVENT_TYPE,
  REFLECTION_COMPLETED_SCHEMA_VERSION,
} from "@qmilab/lodestar-core"
import type {
  BeliefStore,
  ClaimStore,
  EvidenceStore,
  LifecycleAxis,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import type { EventLogReader } from "@qmilab/lodestar-event-log"
import type { ExplanationGenerator } from "./explanation.js"

/**
 * Reflection — the second-look pass across the event log that proposes
 * lifecycle changes without committing them.
 *
 * Design contract: `docs/architecture/reflection-pass.md`. The short
 * version:
 *
 * - Reflection is cognitive machinery. It lives here, not in the
 *   harness. The harness observes reflection; it does not invoke it.
 * - Reflection NEVER mutates belief state directly. Every applied
 *   proposal goes through `MemoryFirewall` with
 *   `by_authority: "reflection"`, and the firewall emits its own
 *   normal `belief.adopted` / `belief.transitioned` event whose
 *   `causal_parent_ids` includes the reflection pass id.
 * - Reflection cannot manufacture independence. Re-aggregating the
 *   same `independence_group` over and over does not satisfy Parallax
 *   — `aggregateStrength` still sees one source.
 * - Reflection authority is absent from the `restricted → normal`
 *   retrieval row in `transitions.ts`. The probe
 *   `reflection-cannot-promote-to-normal-alone` enforces that
 *   structurally.
 *
 * v0 scope: rule-based. Two rules are implemented:
 *
 *   1. **Contradicted-belief cascade.** A belief that transitioned to
 *      `truth_status: contradicted` is searched against past
 *      `decision.made@1` events; any Decision whose
 *      `belief_dependencies` includes the contradicted belief produces
 *      a `decision_dependency_flagged` proposal. Applying the proposal
 *      emits a `Revision` event with `target_type: "decision"`.
 *
 *   2. **`no_op` for completeness.** When no other proposal fires for
 *      a contradicted belief, an explicit `no_op` is emitted so the
 *      audit chain distinguishes "looked and did nothing" from
 *      "did not look."
 *
 * LLM-driven reflection and reflection-driven corroboration (promoting
 * a previously-blocked `external_document` claim once an independent
 * source arrives) are explicit follow-ups, not v0 scope. See the
 * design doc's "Out of scope" section.
 */

const DECISION_MADE_EVENT_TYPE = "decision.made"

/**
 * Minimal event-emission surface the reflection runner needs. The host
 * supplies an implementation — `EventLogWriter` from
 * `@qmilab/lodestar-event-log` for production, a collecting array for
 * probes. Keeping this narrow (one method per event the runner can
 * produce) lets probes mock without dragging in the writer's
 * partition-state machinery.
 */
export interface ReflectionEmitter {
  emitReflectionCompleted(envelope: {
    payload: ReflectionCompletedPayload
    causal_parent_ids: string[]
  }): Promise<string>

  /**
   * Used when a `decision_dependency_flagged` proposal is applied.
   * The Revision is the audit-grade record that the Decision's
   * epistemic status changed.
   */
  emitDecisionRevision(envelope: {
    revision: Revision
    causal_parent_ids: string[]
  }): Promise<string>
}

export interface ReflectionContext {
  project_id: string
  session_id: string
  actor_id: string
}

export interface ReflectionInputs {
  /**
   * Stores and the firewall are optional so the CLI can construct a
   * dry-run Reflection that only computes proposals against an
   * existing event log without rebuilding live state. When absent,
   * `run({ apply: true })` will error on the first proposal that
   * needs them; the CLI defaults to `apply: false` for this reason.
   */
  beliefs?: BeliefStore
  claims?: ClaimStore
  evidence?: EvidenceStore
  firewall?: MemoryFirewall
  explanations: ExplanationGenerator
  emitter?: ReflectionEmitter
  reader?: EventLogReader
  context: ReflectionContext
}

export interface RunInput {
  trigger: ReflectionTrigger
  /**
   * Cursor lower bound (exclusive). Reflection considers events with
   * `seq > since_seq`. Defaults to the highest `cursor.to_seq` from
   * prior `reflection.completed` events for the partition, or `-1`
   * if no prior pass exists.
   */
  since_seq?: number
  /**
   * Override the event stream the runner inspects. When provided, the
   * runner does NOT consult `reader`. Used by probes that drive the
   * reflection directly without a live event log.
   */
  events?: EventEnvelope[]
  /**
   * If true, apply every proposal through the firewall (and the
   * emitter, for decision flags). Defaults to true.
   */
  apply?: boolean
}

export interface RunResult {
  pass_id: string
  reflection_event_id?: string
  payload: ReflectionCompletedPayload
  applied: AppliedSummary
}

export interface AppliedSummary {
  belief_transitions: number
  belief_supersessions: number
  claim_promotions: number
  decision_flags: number
  no_ops: number
  errors: { proposal_kind: ReflectionProposal["kind"]; message: string }[]
}

export class Reflection {
  constructor(private readonly inputs: ReflectionInputs) {}

  async run(input: RunInput): Promise<RunResult> {
    const startedAt = new Date().toISOString()
    const pass_id = crypto.randomUUID()
    const events = await this.gatherEvents(input)
    const since_seq = await this.resolveSinceSeq(input, events)
    const window = events.filter((e) => e.seq > since_seq)

    const proposals: ReflectionProposal[] = []
    const observed: string[] = window.map((e) => e.id)

    proposals.push(...this.detectContradictedDecisionCascade(window))

    if (proposals.length === 0) {
      // Per the design doc Q2: every pass emits at least one
      // proposal. A truly empty inspection still emits a no_op
      // against the partition itself so the audit chain can tell
      // "ran and silent" apart from "did not run."
      proposals.push({
        kind: "no_op",
        subject: { kind: "belief", id: `partition:${this.inputs.context.session_id}` },
        rationale_id: this.buildNoOpExplanation({
          summary: "reflection pass observed no actionable cascades",
          full_text:
            `Reflection pass ${pass_id} considered ${window.length} event(s) ` +
            `with seq > ${since_seq} and found no contradicted beliefs with ` +
            `dependent decisions in scope.`,
        }).id,
      })
    }

    const finishedAt = new Date().toISOString()
    const max_seq = window.length === 0 ? since_seq : window[window.length - 1]!.seq
    const payload: ReflectionCompletedPayload = {
      pass_id,
      triggered_by: input.trigger,
      cursor: { from_seq: since_seq, to_seq: max_seq },
      observed_event_ids: observed,
      proposals,
      started_at: startedAt,
      finished_at: finishedAt,
    }

    let reflection_event_id: string | undefined
    if (this.inputs.emitter) {
      reflection_event_id = await this.inputs.emitter.emitReflectionCompleted({
        payload,
        causal_parent_ids: observed,
      })
    }

    const applied: AppliedSummary = {
      belief_transitions: 0,
      belief_supersessions: 0,
      claim_promotions: 0,
      decision_flags: 0,
      no_ops: 0,
      errors: [],
    }

    if (input.apply !== false) {
      for (const proposal of proposals) {
        try {
          await this.applyProposal(proposal, reflection_event_id)
          if (proposal.kind === "belief_transition") applied.belief_transitions += 1
          else if (proposal.kind === "belief_supersession") applied.belief_supersessions += 1
          else if (proposal.kind === "claim_promotion") applied.claim_promotions += 1
          else if (proposal.kind === "decision_dependency_flagged") applied.decision_flags += 1
          else if (proposal.kind === "no_op") applied.no_ops += 1
        } catch (err) {
          applied.errors.push({
            proposal_kind: proposal.kind,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return { pass_id, reflection_event_id, payload, applied }
  }

  // ── Rule: contradicted-belief cascade ─────────────────────────────────────

  private detectContradictedDecisionCascade(
    window: EventEnvelope[],
  ): ReflectionProposal[] {
    const proposals: ReflectionProposal[] = []
    const decisions = collectDecisions(window)
    if (decisions.length === 0) return proposals

    for (const event of window) {
      const transition = extractContradictionTransition(event)
      if (!transition) continue
      const { belief_id } = transition

      for (const decision of decisions) {
        if (!decision.belief_dependencies.includes(belief_id)) continue
        const rationale = this.inputs.explanations.build({
          subject_type: "belief_revision",
          subject_id: decision.id,
          audience: "audit",
          summary: `Decision ${decision.id.slice(0, 8)} depended on belief ${belief_id.slice(0, 8)}, now contradicted`,
          full_text:
            `Belief ${belief_id} transitioned to truth_status='contradicted' in event ${event.id}. ` +
            `Decision ${decision.id} ("${decision.question}") recorded this belief in its ` +
            `belief_dependencies at the time it was made. Reflection proposes flagging the ` +
            `Decision so a downstream Revision can re-examine whether the selected option still ` +
            `holds under the updated belief state.`,
          claims_used: [],
          evidence_used: [],
        })
        proposals.push({
          kind: "decision_dependency_flagged",
          decision_id: decision.id,
          contradicted_belief_id: belief_id,
          rationale_id: rationale.id,
        })
      }
    }

    return proposals
  }

  // ── Apply proposals ───────────────────────────────────────────────────────

  private async applyProposal(
    proposal: ReflectionProposal,
    reflection_event_id: string | undefined,
  ): Promise<void> {
    switch (proposal.kind) {
      case "belief_transition": {
        if (!this.inputs.firewall) throw new Error("Reflection: belief_transition requires a firewall")
        const explanation = await this.materializeExplanation(proposal.rationale_id)
        // The schema keeps `to_value` as a plain string because the
        // valid set depends on `axis` — that relationship isn't
        // expressible in a flat discriminated union. Cast to the
        // firewall's narrower union; the firewall's transition table
        // re-validates the (axis, from, to) tuple and rejects any
        // invalid combination.
        await this.inputs.firewall.transitionAxis({
          belief_id: proposal.belief_id,
          axis: proposal.axis as LifecycleAxis,
          to_value: proposal.to_value as Parameters<MemoryFirewall["transitionAxis"]>[0]["to_value"],
          by_authority: "reflection",
          by_actor_id: this.inputs.context.actor_id,
          rationale: explanation,
        })
        return
      }
      case "claim_promotion": {
        if (!this.inputs.firewall || !this.inputs.claims) {
          throw new Error("Reflection: claim_promotion requires firewall and claims store")
        }
        const explanation = await this.materializeExplanation(proposal.rationale_id)
        const claim = await this.inputs.claims.get(proposal.claim_id)
        if (!claim) {
          throw new Error(`Reflection: claim ${proposal.claim_id} not found for promotion`)
        }
        // Reflection-driven promotion to a non-unverified truth_status
        // routes through adoptBelief — the firewall enforces that the
        // requested truth_status is reachable from 'unverified' under
        // `reflection` authority (see transitions.ts).
        await this.inputs.firewall.adoptBelief({
          candidate: {
            claim_id: proposal.claim_id,
            confidence: 0.7,
            calibration_class: `reflection::${claim.structured_predicate?.subject ?? "untyped"}`,
            scope: claim.scope,
            sensitivity: claim.sensitivity,
            authority: "inferred",
            truth_status: proposal.target_truth_status,
            retrieval_status: "restricted",
            security_status: "clean",
            freshness_status: "fresh",
            observed_at: claim.created_at,
            last_verified_at: new Date().toISOString(),
          },
          evidence_id: proposal.evidence_id,
          by_authority: "reflection",
          rationale: explanation,
        })
        return
      }
      case "belief_supersession": {
        if (!this.inputs.firewall) throw new Error("Reflection: belief_supersession requires a firewall")
        // Recorded by transitioning the old belief's truth_status to
        // 'superseded' and stamping superseded_by on the stored belief
        // record. The successor belief is assumed to exist already
        // (reflection does not create the successor).
        const explanation = await this.materializeExplanation(proposal.rationale_id)
        await this.inputs.firewall.transitionAxis({
          belief_id: proposal.old_belief_id,
          axis: "truth_status",
          to_value: "superseded",
          by_authority: "reflection",
          by_actor_id: this.inputs.context.actor_id,
          rationale: explanation,
        })
        return
      }
      case "decision_dependency_flagged": {
        if (!this.inputs.emitter) {
          // No emitter wired up — the proposal stays in the
          // reflection.completed payload but the Revision side is
          // not persisted. Probes that drive reflection without an
          // event log rely on this path.
          return
        }
        const revision: Revision = {
          id: crypto.randomUUID(),
          target_type: "decision",
          target_id: proposal.decision_id,
          changes: [
            {
              field: `belief_dependencies.${proposal.contradicted_belief_id}.truth_status`,
              old_value: "supported",
              new_value: "contradicted",
            },
          ],
          triggered_by: reflection_event_id ?? `reflection-pass:${this.inputs.context.actor_id}`,
          rationale_id: proposal.rationale_id,
          at: new Date().toISOString(),
        }
        await this.inputs.emitter.emitDecisionRevision({
          revision,
          causal_parent_ids: reflection_event_id ? [reflection_event_id] : [],
        })
        return
      }
      case "no_op":
        return
    }
  }

  // ── Cursor resolution ─────────────────────────────────────────────────────

  private async gatherEvents(input: RunInput): Promise<EventEnvelope[]> {
    if (input.events) return [...input.events].sort((a, b) => a.seq - b.seq)
    if (this.inputs.reader) {
      return this.inputs.reader.readAll(this.inputs.context.project_id)
    }
    return []
  }

  private async resolveSinceSeq(
    input: RunInput,
    events: EventEnvelope[],
  ): Promise<number> {
    if (input.since_seq !== undefined) return input.since_seq
    // Highest cursor.to_seq from prior reflection.completed events for the partition
    let highest = -1
    for (const e of events) {
      if (e.type !== REFLECTION_COMPLETED_EVENT_TYPE) continue
      const payload = e.payload as { cursor?: { to_seq?: unknown } } | undefined
      const toSeq = payload?.cursor?.to_seq
      if (typeof toSeq === "number" && toSeq > highest) highest = toSeq
    }
    return highest
  }

  // ── Explanation helpers ───────────────────────────────────────────────────

  private buildNoOpExplanation(input: { summary: string; full_text: string }): Explanation {
    return this.inputs.explanations.build({
      subject_type: "belief_revision",
      subject_id: `reflection:${this.inputs.context.session_id}`,
      audience: "audit",
      summary: input.summary,
      full_text: input.full_text,
      claims_used: [],
      evidence_used: [],
    })
  }

  /**
   * Re-materialize an Explanation by id. The runner already generated
   * the Explanation during rule-detection (see
   * `detectContradictedDecisionCascade`), so we re-construct a minimal
   * record here that carries the id forward to the firewall API. In
   * production, Explanations live in their own store; v0 callers do
   * not need them looked up.
   */
  private async materializeExplanation(rationale_id: string): Promise<Explanation> {
    return {
      id: rationale_id,
      subject_type: "belief_revision",
      subject_id: `reflection-pass:${this.inputs.context.session_id}`,
      audience: "audit",
      summary: "reflection-pass rationale",
      full_text: `Rationale carried by reflection pass for actor ${this.inputs.context.actor_id}.`,
      claims_used: [],
      evidence_used: [],
      uncertainties: [],
      counterarguments: [],
      generated_by: this.inputs.context.actor_id,
      at: new Date().toISOString(),
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event-shape adapters
//
// Reflection inspects events by type+payload shape. The payload shapes
// emitted by guard / guard-mcp / the firewall audit sink are not yet
// schematised in `@qmilab/lodestar-core` (event payloads stay
// deliberately permissive at the envelope level), so these helpers
// shape-check defensively. When payload shapes are formalised in a
// later batch, replace these with parse() calls against the shared
// schemas.
// ─────────────────────────────────────────────────────────────────────────────

interface DecisionLike {
  id: string
  question: string
  belief_dependencies: string[]
}

function collectDecisions(events: EventEnvelope[]): DecisionLike[] {
  const out: DecisionLike[] = []
  for (const e of events) {
    if (e.type !== DECISION_MADE_EVENT_TYPE) continue
    const decision = e.payload as Partial<DecisionLike> | undefined
    if (!decision || typeof decision.id !== "string") continue
    if (!Array.isArray(decision.belief_dependencies)) continue
    out.push({
      id: decision.id,
      question: typeof decision.question === "string" ? decision.question : "(no question)",
      belief_dependencies: decision.belief_dependencies.filter((x): x is string => typeof x === "string"),
    })
  }
  return out
}

function extractContradictionTransition(
  event: EventEnvelope,
): { belief_id: string } | null {
  if (event.type !== "belief.transitioned") return null
  const payload = event.payload as
    | { belief_id?: unknown; axis?: unknown; to_value?: unknown }
    | undefined
  if (!payload) return null
  if (payload.axis !== "truth_status") return null
  if (payload.to_value !== "contradicted") return null
  if (typeof payload.belief_id !== "string") return null
  return { belief_id: payload.belief_id }
}
