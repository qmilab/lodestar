import type { EventEnvelope } from "@qmilab/lodestar-core"
import { z } from "zod"
import { asDecisionView } from "../sentinel.js"
import type { CalibrationSample, ResolvedCalibratorConfig } from "./schema.js"

/**
 * Resolve calibration samples from a slice of the event log.
 *
 * Reads defensively in the same style as the sentinels: event payloads
 * are `z.unknown()` on the wire and hosts emit varying completeness, so
 * every projection is a loose `.passthrough()` view that pulls only the
 * fields a rule needs and a payload that lacks the minimum is skipped,
 * not thrown on. The calibrator needs `calibration_class` (off a belief)
 * and `phase` (off an action) which the sentinel views do not type, so
 * it carries its own views here; `asDecisionView` is reused as-is.
 *
 * Two signals, gated by `config.outcome_sources`:
 *   - action_outcome: belief → decision.belief_dependencies →
 *     action(decision_id) → realised result
 *   - truth_status: firewall transition of a belief's truth_status
 *
 * See `docs/architecture/calibrator.md`.
 */

// ── Tolerant views ───────────────────────────────────────────────────────

const BeliefView = z
  .object({
    id: z.string(),
    confidence: z.number(),
    calibration_class: z.string(),
    authority: z.string().optional(),
  })
  .passthrough()

const ActionView = z
  .object({
    id: z.string(),
    decision_id: z.string().optional(),
    phase: z.string().optional(),
  })
  .passthrough()

// Firewall belief.transitioned audit event (emitted as
// `firewall.belief.transitioned`; reflection-era hosts also emit a bare
// `belief.transitioned`). Only the truth_status axis carries a calibration
// label, and only `supported` / `contradicted` are adjudications.
const TransitionView = z
  .object({
    kind: z.string().optional(),
    belief_id: z.string().optional(),
    axis: z.string().optional(),
    to_value: z.string().optional(),
  })
  .passthrough()

// An explicit Outcome event (`outcome.observed` / `action.outcome`).
const OutcomeView = z
  .object({
    action_id: z.string().optional(),
    result: z.string().optional(),
  })
  .passthrough()

interface ResolvedBelief {
  confidence: number
  calibration_class: string
  authority?: string
}

const TRANSITION_EVENT_TYPES = new Set(["firewall.belief.transitioned", "belief.transitioned"])
const OUTCOME_EVENT_TYPES = new Set(["outcome.observed", "action.outcome"])

/**
 * True when a belief is excluded by the synthetic-authority rule.
 * Synthetic beliefs are probe artefacts and must not pollute real
 * calibration classes (mirrors the firewall's synthetic-isolation
 * invariant). Off by default; `includeSyntheticAuthority` opts in.
 */
function excludedAuthority(belief: ResolvedBelief, config: ResolvedCalibratorConfig): boolean {
  return !config.include_synthetic_authority && belief.authority === "synthetic"
}

export function resolveSamples(
  events: EventEnvelope[],
  config: ResolvedCalibratorConfig,
): CalibrationSample[] {
  // Pass 1 — index every adopted belief by id. The prediction
  // (confidence) and grouping key (calibration_class) live here; both
  // signals look beliefs up by id.
  const beliefById = new Map<string, ResolvedBelief>()
  for (const event of events) {
    if (event.type !== "belief.adopted") continue
    const parsed = BeliefView.safeParse(event.payload)
    if (!parsed.success) continue
    const belief: ResolvedBelief = {
      confidence: parsed.data.confidence,
      calibration_class: parsed.data.calibration_class,
    }
    if (typeof parsed.data.authority === "string") belief.authority = parsed.data.authority
    beliefById.set(parsed.data.id, belief) // last write wins
  }

  const samples: CalibrationSample[] = []
  const sources = new Set(config.outcome_sources)

  if (sources.has("action_outcome")) {
    resolveActionOutcomeSamples(events, config, beliefById, samples)
  }
  if (sources.has("truth_status")) {
    resolveTruthStatusSamples(events, config, beliefById, samples)
  }

  return samples
}

function resolveActionOutcomeSamples(
  events: EventEnvelope[],
  config: ResolvedCalibratorConfig,
  beliefById: Map<string, ResolvedBelief>,
  out: CalibrationSample[],
): void {
  // decision id → the beliefs it leaned on
  const decisionDeps = new Map<string, string[]>()
  // action id → { decision it came from, realised success from phase }
  const actionInfo = new Map<string, { decision_id?: string; success?: boolean }>()
  // action id → the host's explicit Outcome verdict, which wins over the
  // terminal phase. `true`/`false` are binary labels; `null` records that a
  // non-binary outcome (`partial` / `unknown`) was seen — it is NOT a label,
  // but it must SUPPRESS the phase-derived fallback below rather than let the
  // terminal phase manufacture a spurious success/failure sample.
  const explicitOutcome = new Map<string, boolean | null>()

  for (const event of events) {
    const { type, payload } = event

    if (type === "decision.made") {
      const view = asDecisionView(payload)
      if (view?.id && Array.isArray(view.belief_dependencies)) {
        decisionDeps.set(view.id, view.belief_dependencies)
      }
      continue
    }

    if (OUTCOME_EVENT_TYPES.has(type)) {
      const parsed = OutcomeView.safeParse(payload)
      if (parsed.success && parsed.data.action_id) {
        if (parsed.data.result === "success") explicitOutcome.set(parsed.data.action_id, true)
        else if (parsed.data.result === "failure") explicitOutcome.set(parsed.data.action_id, false)
        else if (parsed.data.result === "partial" || parsed.data.result === "unknown") {
          // Not a clean binary label, but the host explicitly saw a
          // non-binary result — remember it (as null) so the phase fallback
          // cannot turn this action into a success/failure sample.
          explicitOutcome.set(parsed.data.action_id, null)
        }
      }
      continue
    }

    if (type.startsWith("action.")) {
      const parsed = ActionView.safeParse(payload)
      if (!parsed.success) continue
      const info = actionInfo.get(parsed.data.id) ?? {}
      if (typeof parsed.data.decision_id === "string") info.decision_id = parsed.data.decision_id
      // Terminal phase is the realised result. `rejected` is a policy
      // decision, not a tool outcome; `proposed`/`approved`/etc. are not
      // yet realised — none of those are labels.
      if (parsed.data.phase === "completed") info.success = true
      else if (parsed.data.phase === "failed") info.success = false
      actionInfo.set(parsed.data.id, info)
    }
  }

  for (const [actionId, info] of actionInfo) {
    let success: boolean | undefined
    if (explicitOutcome.has(actionId)) {
      const verdict = explicitOutcome.get(actionId)
      // A non-binary explicit outcome (null) suppresses the phase fallback:
      // the host saw the result and it wasn't a clean success/failure, so
      // this action contributes no sample at all.
      if (verdict === null || verdict === undefined) continue
      success = verdict
    } else {
      success = info.success
    }
    if (success === undefined) continue // no realised result for this action
    if (!info.decision_id) continue // can't reach the backing beliefs
    const deps = decisionDeps.get(info.decision_id)
    if (!deps) continue
    for (const beliefId of deps) {
      const belief = beliefById.get(beliefId)
      if (!belief) continue // belief not in this slice (e.g. cross-session)
      if (excludedAuthority(belief, config)) continue
      out.push({
        calibration_class: belief.calibration_class,
        confidence: belief.confidence,
        correct: success,
        belief_id: beliefId,
        source: "action_outcome",
        outcome_ref: actionId,
      })
    }
  }
}

function resolveTruthStatusSamples(
  events: EventEnvelope[],
  config: ResolvedCalibratorConfig,
  beliefById: Map<string, ResolvedBelief>,
  out: CalibrationSample[],
): void {
  for (const event of events) {
    if (!TRANSITION_EVENT_TYPES.has(event.type)) continue
    const parsed = TransitionView.safeParse(event.payload)
    if (!parsed.success) continue
    const t = parsed.data
    // If a `kind` discriminator is present it must be belief.transitioned;
    // absent (bare event) we trust the event type.
    if (typeof t.kind === "string" && t.kind !== "belief.transitioned") continue
    if (t.axis !== "truth_status") continue
    if (!t.belief_id) continue
    const correct = t.to_value === "supported"
    const adjudicated = correct || t.to_value === "contradicted"
    if (!adjudicated) continue // superseded / unverified are not labels
    const belief = beliefById.get(t.belief_id)
    if (!belief) continue
    if (excludedAuthority(belief, config)) continue
    out.push({
      calibration_class: belief.calibration_class,
      confidence: belief.confidence,
      correct,
      belief_id: t.belief_id,
      source: "truth_status",
      outcome_ref: `${t.belief_id}:${t.to_value}`,
    })
  }
}
