import type {
  Action,
  EventEnvelope,
  Policy,
  SentinelAlertPayload,
  TruthStatus,
} from "@qmilab/lodestar-core"
import {
  type Sentinel,
  type SentinelAlert,
  SentinelRunner,
  type SentinelRunnerOptions,
  asDecisionView,
} from "@qmilab/lodestar-harness"
import {
  type ArbitrationContext,
  type BackingBelief,
  type CalibrationSnapshot,
  type CompiledPolicy,
  type EscalationConfig,
  compile,
} from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

/**
 * Session-end event types after which the arbiter frees its per-session state.
 * Mirrors the {@link SentinelRunner} default so the arbiter's caches and the
 * sentinels' state are dropped on the same events (the guarded session ending or
 * failing). Override via {@link SentinelArbiterOptions.runner}.
 */
const DEFAULT_SESSION_END_EVENTS = ["guard.session.ended", "guard.session.failed"] as const

/**
 * A loose projection of `belief.adopted` that — unlike the harness `asBeliefView`
 * — surfaces `calibration_class`, which {@link BackingBelief} needs for the
 * calibration-flag signal. Event payloads are `z.unknown()` on the wire and hosts
 * emit varying completeness, so this reads defensively (every field but `id`
 * optional) and is deliberately NOT the strict core `BeliefSchema`.
 */
const ArbiterBeliefView = z
  .object({
    id: z.string(),
    calibration_class: z.string().optional(),
    confidence: z.number().optional(),
    truth_status: z.string().optional(),
  })
  .passthrough()

export interface SentinelArbiterOptions {
  /**
   * The sentinels to run over the session's event stream. The same first-party
   * classes a probe pack declares (`SuspiciousMemoryOriginSentinel`,
   * `LowConfidenceActionSentinel`, `AnomalousToolSequenceSentinel`) or any
   * custom `Sentinel`.
   */
  sentinels: Sentinel[]
  /**
   * The latest calibration snapshot for this project, if the host computes one.
   * `null`/omitted disables the calibration-flag signal. The arbiter does not
   * compute calibration itself (that is a full log read); a host that wants it
   * injects a `CalibrationReport` here or via {@link SentinelArbiter.setCalibration}.
   * A full harness `CalibrationReport` is structurally assignable.
   */
  calibration?: CalibrationSnapshot | null
  /**
   * Forwarded to the internal {@link SentinelRunner}. `actor_id` attributes
   * emitted `sentinel.alerted@1` envelopes; `sessionEndEventTypes` overrides
   * which events free per-session state (and is mirrored onto the arbiter's own
   * caches).
   */
  runner?: Pick<SentinelRunnerOptions, "actor_id" | "sessionEndEventTypes">
}

/**
 * The host-side bridge that gives sentinel alerts (and calibration flags) teeth.
 *
 * Design lock: `docs/architecture/policy-kernel.md` "The arbitrate hook" and the
 * repo ADR `.claude/adr/0001-sentinel-action-arbitration-bridge.md`.
 *
 * The Policy Kernel's arbitrate hook can *strengthen* a verdict from a
 * host-injected {@link ArbitrationContext} — but only a host that runs the
 * sentinels and resolves an action's backing beliefs can supply that context.
 * The `SentinelArbiter` is that host glue, made reusable:
 *
 * - Feed it every emitted event via {@link observe}. Internally it runs a
 *   {@link SentinelRunner} over the stream and **buffers the alerts that land**,
 *   and it projects `decision.made → belief_dependencies` and
 *   `belief.adopted → { calibration_class, confidence, truth_status }` from the
 *   *same* stream — exactly as the sentinels do. It therefore needs no store
 *   injection; it is self-contained from the stream.
 * - {@link resolveContext} turns one action into the gate's `ArbitrationContext`:
 *   the buffered alerts, the action's backing beliefs
 *   (`action.decision_id → belief_dependencies → BackingBelief`), and the
 *   calibration snapshot.
 *
 * Wiring (see {@link compileWithSentinels} for the one-call form): compile the
 * policy with `arbitration.resolveContext = a => arbiter.resolveContext(a)` and
 * hand the same arbiter to the host. The host calls `observe()` for every event
 * it emits and emits the {@link SentinelAlert}s `observe()` returns as
 * `sentinel.alerted@1` on its own writer — so the host stays the sole log writer
 * (the arbiter never writes the log itself).
 *
 * The sentinels still only observe and the calibrator still only measures: the
 * arbiter *projects* their outputs into the gate's input. It never calls back
 * into the Action Kernel and never blocks — enforcement lives in the gate.
 */
export class SentinelArbiter {
  private readonly runner: SentinelRunner
  private readonly sessionEndEventTypes: ReadonlySet<string>
  /** Landed alert payloads in arrival order. The gate scopes them per action. */
  private alerts: SentinelAlertPayload[] = []
  /** belief_id → backing fields, projected from `belief.adopted`. */
  private readonly beliefs = new Map<string, BackingBelief>()
  /** decision_id → belief_dependencies, projected from `decision.made`. */
  private readonly decisions = new Map<string, string[]>()
  private calibration: CalibrationSnapshot | null

  constructor(options: SentinelArbiterOptions) {
    // No sink: the runner only *collects* alerts and returns them. The host
    // emits them on its own writer (keeping it the sole writer of its log),
    // rather than the arbiter appending the log behind the host's back.
    this.runner = new SentinelRunner(options.sentinels, {
      actor_id: options.runner?.actor_id,
      sessionEndEventTypes: options.runner?.sessionEndEventTypes,
    })
    this.sessionEndEventTypes = new Set(
      options.runner?.sessionEndEventTypes ?? DEFAULT_SESSION_END_EVENTS,
    )
    this.calibration = options.calibration ?? null
  }

  /**
   * Feed one event to the arbiter. Updates the backing-belief / decision
   * projections and runs the sentinels, buffering any alerts that land for
   * {@link resolveContext}. Returns the alerts produced *by this event* so the
   * host can emit them as `sentinel.alerted@1` on its own writer. Frees
   * per-session state on a session-end event (after inspection, so a sentinel
   * still sees the terminating event).
   */
  async observe(event: EventEnvelope): Promise<SentinelAlert[]> {
    this.project(event)
    const alerts = await this.runner.observe(event)
    for (const alert of alerts) this.alerts.push(alert.payload)
    if (this.sessionEndEventTypes.has(event.type)) this.resetSession()
    return alerts
  }

  /**
   * Build the gate's read-only {@link ArbitrationContext} for one action. Pure
   * and synchronous (reads only in-memory projections), so a host can re-run it
   * deterministically after a park — handing the *same* snapshot the gate saw.
   */
  resolveContext(action: Action): ArbitrationContext {
    return {
      // Copy so the gate can never observe a later `observe()` mutating the
      // buffer mid-evaluation (it consumes synchronously, but be defensive).
      alerts: [...this.alerts],
      beliefs: this.backingBeliefsFor(action),
      calibration: this.calibration,
    }
  }

  /** Replace the calibration snapshot consulted by the calibration-flag signal. */
  setCalibration(snapshot: CalibrationSnapshot | null): void {
    this.calibration = snapshot
  }

  /**
   * Resolve an action's backing beliefs: `action.decision_id` → the decision's
   * `belief_dependencies` → the projected {@link BackingBelief}s. An action with
   * no decision link, an unknown decision, or beliefs the arbiter has not yet
   * seen simply yields fewer (or no) backing beliefs — the same "cannot trip a
   * rule it has not seen" discipline the sentinels follow.
   */
  private backingBeliefsFor(action: Action): BackingBelief[] {
    if (action.decision_id === undefined) return []
    const dependencies = this.decisions.get(action.decision_id)
    if (dependencies === undefined) return []
    const out: BackingBelief[] = []
    for (const id of dependencies) {
      const belief = this.beliefs.get(id)
      if (belief !== undefined) out.push(belief)
    }
    return out
  }

  private project(event: EventEnvelope): void {
    if (event.type === "belief.adopted") {
      const parsed = ArbiterBeliefView.safeParse(event.payload)
      if (!parsed.success) return
      const v = parsed.data
      this.beliefs.set(v.id, {
        id: v.id,
        // Defaults are defensive fallbacks for a malformed/partial payload; a
        // real `belief.adopted` always carries all three. They are chosen to NOT
        // over-gate on missing data: an absent confidence/truth_status reads as
        // strong+verified so a partial belief does not spuriously trip the
        // low-confidence signal (the explicit alert path is unaffected — it
        // scopes by belief id, not these fields).
        calibration_class: v.calibration_class ?? "general",
        confidence: v.confidence ?? 1,
        truth_status: (v.truth_status ?? "supported") as TruthStatus,
      })
      return
    }
    if (event.type === "decision.made") {
      const decision = asDecisionView(event.payload)
      if (decision !== null) this.decisions.set(decision.id, decision.belief_dependencies ?? [])
    }
  }

  private resetSession(): void {
    this.alerts = []
    this.beliefs.clear()
    this.decisions.clear()
  }
}

/**
 * Options for {@link compileWithSentinels}: the {@link compile} essentials plus
 * the sentinels (and optional calibration / escalation tuning) that drive the
 * arbiter. It deliberately omits `arbitration` — the helper owns the
 * `resolveContext` wiring, which is the whole point.
 */
export interface CompileWithSentinelsOptions {
  /** actor_id stamped onto every decision the gate emits (see {@link compile}). */
  decider_id: string
  /** Permit an unsigned (draft) policy — development opt-in only (see {@link compile}). */
  allow_unsigned?: boolean
  /** Optional cryptographic signature verifier (see {@link compile}). */
  verifySignature?: (policy: Policy) => boolean
  /** The sentinels the arbiter runs over the session stream. */
  sentinels: Sentinel[]
  /** Optional calibration snapshot for the calibration-flag signal. */
  calibration?: CalibrationSnapshot | null
  /** Optional escalation thresholds (severity→effect, low-confidence floor). */
  escalation?: EscalationConfig
}

/**
 * Compile a policy with its sentinel arbiter wired in one call — the
 * footgun-free form of the two-step (build arbiter → compile with its
 * `resolveContext` → hand both to the host). Returns the `CompiledPolicy` to use
 * as `GuardConfig.policy_gate` and the `SentinelArbiter` to pass as
 * `GuardConfig.arbiter`:
 *
 * ```ts
 * const { gate, arbiter } = compileWithSentinels(policy, {
 *   decider_id: "policy-signer",
 *   sentinels: [new SuspiciousMemoryOriginSentinel()],
 * })
 * await runGuarded(loop, { policy_gate: gate, arbiter, approval_resolver, ... })
 * ```
 */
export function compileWithSentinels(
  policy: Policy,
  options: CompileWithSentinelsOptions,
): { gate: CompiledPolicy; arbiter: SentinelArbiter } {
  const arbiter = new SentinelArbiter({
    sentinels: options.sentinels,
    calibration: options.calibration,
  })
  const gate = compile(policy, {
    decider_id: options.decider_id,
    allow_unsigned: options.allow_unsigned,
    verifySignature: options.verifySignature,
    arbitration: {
      resolveContext: (action) => arbiter.resolveContext(action),
      escalation: options.escalation,
    },
  })
  return { gate, arbiter }
}
