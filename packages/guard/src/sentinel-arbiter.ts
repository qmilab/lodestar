import {
  type Action,
  type EventEnvelope,
  type Policy,
  SENTINEL_ALERTED_EVENT_TYPE,
  type SentinelAlertPayload,
  type TruthStatus,
} from "@qmilab/lodestar-core"
import {
  DEFAULT_SENTINEL_ACTOR,
  DEFAULT_SESSION_END_EVENTS,
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
  /**
   * The `actor_id` attributed to the `sentinel.alerted@1` events a host emits
   * from this arbiter's findings. Sentinels are neither the agent nor a human;
   * this names the sentinel/runner so the audit trail shows who authored an
   * alert, not the governed agent (Codex review, round 2).
   */
  readonly actorId: string
  /**
   * The single session this arbiter governs. The arbiter is **single-session by
   * construction**: a host binds it (via {@link bindSession}, or lazily on the
   * first observed event) and `resolveContext` reports exactly that session — it
   * never infers a session from "whichever event was seen last", which would race
   * under concurrent reuse. Reuse across a *second concurrent* session is rejected
   * loudly at {@link bindSession}; sequential reuse is fine (a session-end unbinds
   * and clears).
   */
  private boundSession: string | undefined
  /**
   * Landed alert payloads for the bound session, in arrival order (cleared when it
   * ends). The gate scopes them per action by backing-belief id — but a
   * subject-agnostic `tool_sequence` alert gates *every* subsequent action until
   * session end. A bounded recency window is a deferred refinement (PR #54 review,
   * F4); for v0 the session-scoped buffer is the conservative choice.
   */
  private alerts: SentinelAlertPayload[] = []
  /** belief_id → backing fields, projected from the bound session's `belief.adopted`. */
  private readonly beliefs = new Map<string, BackingBelief>()
  /** decision_id → belief_dependencies, projected from the bound session's `decision.made`. */
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
    this.actorId = options.runner?.actor_id ?? DEFAULT_SENTINEL_ACTOR
    this.calibration = options.calibration ?? null
  }

  /**
   * Bind this arbiter to the one session it governs — the host calls this once at
   * session start. Throws if a *different* session is still active: the arbiter is
   * single-session, so create one (e.g. via {@link compileWithSentinels}) per
   * guarded session. Idempotent for the same session id. A session-end event seen
   * by {@link observe} unbinds it, so the *same* arbiter may serve a later session
   * sequentially.
   */
  bindSession(sessionId: string): void {
    if (this.boundSession !== undefined && this.boundSession !== sessionId) {
      throw new Error(
        `SentinelArbiter is single-session: session '${this.boundSession}' is still active — create one arbiter per guarded session (e.g. one compileWithSentinels() call each).`,
      )
    }
    this.boundSession = sessionId
  }

  /**
   * Feed one event to the arbiter. Updates the backing-belief / decision
   * projections and runs the sentinels, buffering any alerts that land for
   * {@link resolveContext}. Returns the alerts produced *by this event* so the
   * host can emit them as `sentinel.alerted@1` on its own writer. A session-end
   * event clears state and unbinds (after inspection, so a sentinel still sees the
   * terminating event).
   */
  async observe(event: EventEnvelope): Promise<SentinelAlert[]> {
    // Never feed the arbiter its own output. The host emits each landed alert as
    // `sentinel.alerted@1` through the very path that calls observe(); a (custom)
    // sentinel reacting to a `sentinel.alerted` event would make alert-emission
    // recurse without bound. The event also carries no chain primitive to
    // project, so skip it wholesale — the depth-one guarantee then holds for ANY
    // sentinel set, not only the first-party ones (PR #54 review, F5).
    if (event.type === SENTINEL_ALERTED_EVENT_TYPE) return []
    // Lazy-bind for hosts that drive observe() directly (e.g. tests); runGuarded
    // binds explicitly at session start.
    if (this.boundSession === undefined) this.boundSession = event.session_id
    // Defensive: an event from a different session than the bound one is ignored
    // (concurrent reuse is rejected at bindSession, so this should not occur — it
    // guards against cross-session contamination of the single-session state).
    if (event.session_id !== this.boundSession) return []
    const sessionEnding = this.sessionEndEventTypes.has(event.type)
    try {
      this.project(event)
      const alerts = await this.runner.observe(event)
      for (const alert of alerts) this.alerts.push(alert.payload)
      return alerts
    } finally {
      // Always clear/unbind on a terminal event — even if a sentinel threw while
      // inspecting it (the host swallows that throw best-effort). Otherwise stale
      // state would block or poison sequential reuse of the same arbiter (Codex
      // review, round 3).
      if (sessionEnding) this.unbind()
    }
  }

  /**
   * Build the gate's read-only {@link ArbitrationContext} for the bound session's
   * action. Pure and synchronous (reads only in-memory state), so a host can
   * re-run it deterministically after a park — handing the *same* snapshot the
   * gate saw.
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

  private unbind(): void {
    this.boundSession = undefined
    this.alerts = []
    this.beliefs.clear()
    this.decisions.clear()
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
        // A real `belief.adopted` always carries all three fields; these defaults
        // only apply to a malformed/partial payload, and they fail CLOSED (the
        // repo's "no silent defaults for security-relevant settings" norm): a
        // missing truth_status reads as `unverified`, so a partial belief HOLDS a
        // dependent L3+ action rather than slipping past the low-confidence
        // signal. `calibration_class` defaults to the neutral "general".
        calibration_class: v.calibration_class ?? "general",
        confidence: v.confidence ?? 1,
        truth_status: (v.truth_status ?? "unverified") as TruthStatus,
      })
      return
    }
    if (event.type === "decision.made") {
      const decision = asDecisionView(event.payload)
      if (decision !== null) {
        // Union, never narrow: a second `decision.made` for the same id can only
        // ADD backing beliefs, never drop one a sentinel may already have flagged.
        // A later duplicate with an empty/narrower list must not be able to fail a
        // belief-scoped hold open — the same monotonic strengthen-only discipline
        // as the alert buffer and the gate (Codex review, round 4).
        const existing = this.decisions.get(decision.id) ?? []
        this.decisions.set(decision.id, [
          ...new Set([...existing, ...(decision.belief_dependencies ?? [])]),
        ])
      }
    }
    // NOTE (deferred — PR #54 review, F1): the belief cache reflects
    // `belief.adopted` only. A later `firewall.belief.transitioned` (e.g. a
    // contradiction routing a belief to `contradicted`/`superseded`) is not
    // re-projected, so a cached truth_status is the adoption-time value. Today
    // that only skews the *conservative* way for the low-confidence signal (a
    // since-promoted belief still reads `unverified` → an extra hold). Reflecting
    // transitions — and deciding whether `contradicted`/`superseded` should gate,
    // which is a policy-kernel gate-semantics question (the signal tests only
    // `=== "unverified"`) — is left for the P1 hardening follow-up.
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
  /**
   * Forwarded to the arbiter's internal {@link SentinelRunner}: `actor_id` for
   * emitted alert envelopes, and `sessionEndEventTypes` for a host whose session
   * terminates on non-default events (so the arbiter frees per-session state at
   * the right boundary rather than leaking caches across logical sessions).
   */
  runner?: Pick<SentinelRunnerOptions, "actor_id" | "sessionEndEventTypes">
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
    runner: options.runner,
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
