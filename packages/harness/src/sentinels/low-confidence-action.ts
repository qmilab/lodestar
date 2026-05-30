import type { EventEnvelope } from "@qmilab/lodestar-core"
import {
  Sentinel,
  type SentinelFinding,
  asActionView,
  asBeliefView,
  asDecisionView,
} from "../sentinel.js"

/**
 * Low-confidence action sentinel.
 *
 * Roadmap (Batch 4): "Watches `action.proposed` / `action.approved`; alerts
 * on actions whose `required_level` ≥ 3 backed by a belief at
 * `confidence < 0.5` or `truth_status: unverified`."
 *
 * The shape it catches: a consequential action (L3 modifies project state,
 * L4 reaches outside it) resting on a belief the system itself is not sure
 * of. That is exactly where an agent's overconfidence does damage — the
 * belief is shaky but the action is not.
 *
 * Tracking: an action does not carry its backing beliefs directly. The
 * chain is `action.decision_id → decision.belief_dependencies → belief`.
 * So the sentinel accumulates `decision.made` (decision → belief ids) and
 * `belief.adopted` (belief → confidence/truth_status), then checks the
 * backing when a qualifying action arrives. Order is not guaranteed across
 * hosts, so the check reads whatever state has accrued; a belief the
 * sentinel has not yet seen simply cannot trip the rule (it is not yet
 * "backed by a [known weak] belief").
 *
 * Scope discipline: the rule fires only when there IS a weak backing
 * belief. An action with no decision link, or whose beliefs are all strong
 * or unknown, is out of scope here — "action with no epistemic backing at
 * all" is a different concern and gets its own sentinel if we ever want it.
 */
export class LowConfidenceActionSentinel extends Sentinel {
  readonly name = "low-confidence-action"
  readonly description =
    "Flags an action at required_level >= 3 that depends on a belief with confidence below the floor or an unverified truth_status."

  private readonly minLevel: number
  private readonly confidenceFloor: number

  /**
   * State is partitioned by session and dropped on session end (the chain
   * decision→belief→action is intra-session, and the in-memory stores are
   * session-scoped). This is what bounds memory on a long-running live tail.
   */
  private readonly bySession = new Map<
    string,
    {
      /** decision_id -> belief_dependencies */
      decisions: Map<string, string[]>
      /** belief_id -> { confidence, truth_status } */
      beliefs: Map<string, { confidence?: number; truth_status?: string }>
      /** action ids already alerted on, so proposed→approved does not double-fire */
      alerted: Set<string>
    }
  >()

  constructor(options: { minLevel?: number; confidenceFloor?: number } = {}) {
    super()
    this.minLevel = options.minLevel ?? 3
    this.confidenceFloor = options.confidenceFloor ?? 0.5
  }

  private stateFor(sessionId: string) {
    let state = this.bySession.get(sessionId)
    if (!state) {
      state = { decisions: new Map(), beliefs: new Map(), alerted: new Set() }
      this.bySession.set(sessionId, state)
    }
    return state
  }

  inspect(event: EventEnvelope): SentinelFinding[] {
    switch (event.type) {
      case "decision.made": {
        const decision = asDecisionView(event.payload)
        if (decision) {
          this.stateFor(event.session_id).decisions.set(
            decision.id,
            decision.belief_dependencies ?? [],
          )
        }
        return []
      }
      case "belief.adopted": {
        const belief = asBeliefView(event.payload)
        if (belief) {
          this.stateFor(event.session_id).beliefs.set(belief.id, {
            confidence: belief.confidence,
            truth_status: belief.truth_status,
          })
        }
        return []
      }
      case "action.proposed":
      case "action.approved":
        return this.checkAction(event)
      default:
        return []
    }
  }

  private checkAction(event: EventEnvelope): SentinelFinding[] {
    const action = asActionView(event.payload)
    if (!action) return []
    const state = this.stateFor(event.session_id)
    if (state.alerted.has(action.id)) return []

    const requiredLevel = action.contract?.required_level
    if (typeof requiredLevel !== "number" || requiredLevel < this.minLevel) return []

    if (!action.decision_id) return []
    const dependencies = state.decisions.get(action.decision_id)
    if (!dependencies || dependencies.length === 0) return []

    const weak: Array<{
      belief_id: string
      confidence?: number
      truth_status?: string
      reason: "low_confidence" | "unverified"
    }> = []
    for (const beliefId of dependencies) {
      const belief = state.beliefs.get(beliefId)
      if (!belief) continue
      const lowConfidence =
        typeof belief.confidence === "number" && belief.confidence < this.confidenceFloor
      const unverified = belief.truth_status === "unverified"
      if (lowConfidence || unverified) {
        weak.push({
          belief_id: beliefId,
          confidence: belief.confidence,
          truth_status: belief.truth_status,
          // Confidence is the stronger signal; report it when both hold.
          reason: lowConfidence ? "low_confidence" : "unverified",
        })
      }
    }
    if (weak.length === 0) return []

    state.alerted.add(action.id)
    const summary = weak
      .map((w) =>
        w.reason === "low_confidence"
          ? `${w.belief_id} (confidence ${w.confidence?.toFixed(2)})`
          : `${w.belief_id} (truth_status unverified)`,
      )
      .join(", ")
    return [
      {
        rule: "high-trust-action-on-weak-belief",
        severity: "warning",
        subject: { kind: "action", id: action.id },
        message:
          `Action ${action.id}${action.tool ? ` (${action.tool})` : ""} at required_level ` +
          `${requiredLevel} depends on under-supported belief(s): ${summary}.`,
        observed_event_ids: [event.id],
        detail: {
          action_id: action.id,
          tool: action.tool,
          required_level: requiredLevel,
          decision_id: action.decision_id,
          confidence_floor: this.confidenceFloor,
          weak_beliefs: weak,
        },
      },
    ]
  }

  override onSessionEnd(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
