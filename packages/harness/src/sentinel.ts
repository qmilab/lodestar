import { randomUUID } from "node:crypto"
import {
  type EventEnvelope,
  type SentinelAlertPayload,
  SentinelAlertPayloadSchema,
  type SentinelSeverity,
  type SentinelSubject,
} from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * The Sentinel authoring surface.
 *
 * A Sentinel is a stateful watcher over the event stream. It is fed events
 * one at a time (`inspect`), accumulates whatever internal state its rule
 * needs across calls, and returns zero or more {@link SentinelFinding}s for
 * the event it was just shown. The {@link SentinelRunner} turns findings
 * into `sentinel.alerted@1` events.
 *
 * Design lock: `docs/architecture/sentinels.md`. The execution model
 * (async tail, non-blocking, emits events) was settled in Q7 of
 * `docs/architecture/reflection-pass.md`. Sentinels do NOT back-pressure
 * the Action Kernel; they flag subjects so a future additive `arbitrate`
 * hook can gate the *next* action that depends on a flagged subject.
 *
 * Why push-one-at-a-time rather than "hand the sentinel the whole log":
 * it makes the live-tail and batch-sweep paths the same code (the runner
 * just calls `inspect` per event in either mode), and it keeps each
 * sentinel's state explicit and inspectable rather than re-derived from a
 * full scan on every event.
 */
export abstract class Sentinel {
  /** Stable identifier; appears as `sentinel_name` on every alert it emits. */
  abstract readonly name: string
  /** What pattern this sentinel watches for and the threat it maps onto. */
  abstract readonly description: string

  /**
   * Inspect one event. Return any findings this event *completes* — a
   * stateful sentinel typically returns `[]` for the events that only
   * build up its state and a finding on the event that closes the
   * pattern. Must be pure with respect to the outside world: mutate only
   * the sentinel's own fields, never emit or perform I/O here.
   */
  abstract inspect(event: EventEnvelope): SentinelFinding[]

  /**
   * Drop any state scoped to `sessionId`. The runner calls this when it
   * observes a session-terminating event so a long-running live tail does
   * not accumulate per-session state forever (the in-memory stores are
   * themselves session-scoped, so nothing of value survives a session).
   * Default: no-op, for stateless sentinels. Stateful sentinels override.
   */
  onSessionEnd(_sessionId: string): void {}
}

/**
 * What a sentinel returns for an event. The runner stamps the envelope-level
 * fields a sentinel cannot know about itself — `alert_id`, `detected_at`,
 * and the routing (`project_id` / `session_id`) it lifts from the
 * triggering event.
 */
export interface SentinelFinding {
  /** Stable id of the specific rule that fired (a sentinel may have several). */
  rule: string
  severity: SentinelSeverity
  subject: SentinelSubject
  message: string
  /** The events the sentinel read to reach this finding; become causal parents. */
  observed_event_ids: string[]
  /** Rule-specific structured context. Defaults to `{}` when omitted. */
  detail?: Record<string, unknown>
}

/**
 * A fully-formed alert ready to append to the event log. `payload` is the
 * `sentinel.alerted@1` event payload; the routing fields tell the sink
 * which partition/session the alert belongs to. `causal_parent_ids`
 * mirrors `payload.observed_event_ids`.
 */
export interface SentinelAlert {
  payload: SentinelAlertPayload
  project_id: string
  session_id: string
  causal_parent_ids: string[]
}

/** Where the runner sends finished alerts. Injected, mirroring the probe runner. */
export type SentinelAlertSink = (alert: SentinelAlert) => Promise<void>

export interface SentinelRunnerOptions {
  /**
   * Optional sink. When set, every alert is awaited through it as it is
   * produced (e.g. appended to the event log). When absent, the runner
   * only collects and returns alerts — useful for tests and dry runs.
   */
  sink?: SentinelAlertSink
  /**
   * `actor_id` attributed to emitted alert envelopes. Sentinels are not a
   * human or an agent; the default names the harness so the audit trail
   * is unambiguous.
   */
  actor_id?: string
  /**
   * Event types that mean "this session is over". On any of these the
   * runner calls `onSessionEnd(event.session_id)` on every sentinel so
   * per-session state is freed. Defaults to the Guard / MCP-proxy
   * session-end events; override to match a different host.
   */
  sessionEndEventTypes?: readonly string[]
}

const DEFAULT_SENTINEL_ACTOR = "lodestar-sentinel"
const DEFAULT_SESSION_END_EVENTS = ["guard.session.ended", "guard.session.failed"] as const

/**
 * Drives a set of sentinels over events. Stateless itself — all state
 * lives in the sentinels. `observe` is the live-tail entry point (push one
 * event as it is appended); `sweep` replays an ordered batch through the
 * same path.
 */
export class SentinelRunner {
  private readonly actorId: string
  private readonly sessionEndEventTypes: ReadonlySet<string>

  constructor(
    private readonly sentinels: Sentinel[],
    private readonly options: SentinelRunnerOptions = {},
  ) {
    this.actorId = options.actor_id ?? DEFAULT_SENTINEL_ACTOR
    this.sessionEndEventTypes = new Set(options.sessionEndEventTypes ?? DEFAULT_SESSION_END_EVENTS)
  }

  /**
   * Feed one event to every sentinel in registration order. Returns the
   * alerts this event produced (possibly across several sentinels), and —
   * if a sink is configured — appends each one before returning.
   */
  async observe(event: EventEnvelope): Promise<SentinelAlert[]> {
    const alerts: SentinelAlert[] = []
    for (const sentinel of this.sentinels) {
      for (const finding of sentinel.inspect(event)) {
        const alert = buildSentinelAlert(finding, sentinel, event)
        alerts.push(alert)
        if (this.options.sink) await this.options.sink(alert)
      }
    }
    // Free per-session state once a session terminates. Done after
    // inspection so a sentinel that wants to react to the session-end event
    // itself still sees it before its state is dropped.
    if (this.sessionEndEventTypes.has(event.type)) {
      for (const sentinel of this.sentinels) sentinel.onSessionEnd(event.session_id)
    }
    return alerts
  }

  /**
   * Replay a batch of events through the sentinels in the order given.
   * The order is the caller's responsibility — the event-log reader yields
   * events in append order within a partition, which is the order
   * sentinels expect. (We do not re-sort by `seq`: `seq` is per-partition,
   * so re-sorting a multi-partition slice would be wrong.)
   */
  async sweep(events: Iterable<EventEnvelope>): Promise<SentinelAlert[]> {
    const all: SentinelAlert[] = []
    for (const event of events) {
      all.push(...(await this.observe(event)))
    }
    return all
  }
}

function buildSentinelAlert(
  finding: SentinelFinding,
  sentinel: Sentinel,
  triggeringEvent: EventEnvelope,
): SentinelAlert {
  const payload: SentinelAlertPayload = {
    alert_id: randomUUID(),
    sentinel_name: sentinel.name,
    rule: finding.rule,
    severity: finding.severity,
    subject: finding.subject,
    message: finding.message,
    observed_event_ids: finding.observed_event_ids,
    // Normalise undefined -> null throughout `detail`. The event-log writer
    // hashes the payload with `canonicalHash` (treats undefined as null) but
    // serialises it with `JSON.stringify` (drops undefined keys); a lone
    // undefined anywhere in `detail` makes the stored JSON and its hash
    // disagree on re-read. This enforces, for the open `detail` record, the
    // same no-undefined discipline the top-level payload fields hold by
    // construction.
    detail: nullifyUndefined(finding.detail ?? {}) as Record<string, unknown>,
    detected_at: new Date().toISOString(),
  }
  // Validate at the boundary, same as the probe-run observation builder.
  // A malformed finding is a bug in a sentinel; fail loudly rather than
  // writing an unschema'd alert into the audit log.
  const parsed = SentinelAlertPayloadSchema.parse(payload)
  return {
    payload: parsed,
    project_id: triggeringEvent.project_id,
    session_id: triggeringEvent.session_id,
    causal_parent_ids: finding.observed_event_ids,
  }
}

/**
 * True only for a plain data object (object literal or `Object.create(null)`),
 * not a class instance, Date, Map, etc. Recursing into a class instance to swap
 * `undefined → null` could violate its invariants, so {@link nullifyUndefined}
 * descends only into plain objects and arrays. (Narrower than `typeof ===
 * "object"`, which also matches every class instance.)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively replace `undefined` with `null` in arrays and plain objects.
 * Used to make a sentinel's `detail` hash-stable (see {@link buildSentinelAlert}).
 * Leaves all other values — including class instances — untouched.
 */
function nullifyUndefined(value: unknown): unknown {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(nullifyUndefined)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) out[key] = nullifyUndefined(v)
    return out
  }
  return value
}

// -----------------------------------------------------------------------------
// Tolerant event-payload projections
//
// Event payloads are `z.unknown()` on the wire (see EventEnvelopeSchema), and
// hosts vary in how complete a payload they emit — e.g. the greenfield example
// emits a `decision.made` without `belief_dependencies`. A sentinel must read
// defensively: pull only the fields its rule needs, tolerate absence, and skip
// an event whose payload does not even carry the minimum. These loose views
// are deliberately NOT the strict core schemas; using `ActionSchema` et al.
// would reject a partial-but-usable payload.
// -----------------------------------------------------------------------------

const ActionView = z
  .object({
    id: z.string(),
    tool: z.string().optional(),
    decision_id: z.string().optional(),
    contract: z
      .object({
        required_level: z.number().optional(),
        blast_radius: z.string().optional(),
        reversibility: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough()
export type ActionView = z.infer<typeof ActionView>

const BeliefView = z
  .object({
    id: z.string(),
    claim_id: z.string().optional(),
    confidence: z.number().optional(),
    truth_status: z.string().optional(),
    authority: z.string().optional(),
  })
  .passthrough()
export type BeliefView = z.infer<typeof BeliefView>

const DecisionView = z
  .object({
    id: z.string(),
    belief_dependencies: z.array(z.string()).optional(),
  })
  .passthrough()
export type DecisionView = z.infer<typeof DecisionView>

const EvidenceSetView = z
  .object({
    claim_id: z.string().optional(),
    items: z
      .array(
        z
          .object({
            source_id: z.string().optional(),
            relation: z.string().optional(),
            quality: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
export type EvidenceSetView = z.infer<typeof EvidenceSetView>

/** Project an event payload as an Action, or `null` if it isn't one. */
export function asActionView(payload: unknown): ActionView | null {
  const parsed = ActionView.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/** Project an event payload as a Belief, or `null`. */
export function asBeliefView(payload: unknown): BeliefView | null {
  const parsed = BeliefView.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/** Project an event payload as a Decision, or `null`. */
export function asDecisionView(payload: unknown): DecisionView | null {
  const parsed = DecisionView.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/** Project an event payload as an EvidenceSet, or `null`. */
export function asEvidenceSetView(payload: unknown): EvidenceSetView | null {
  const parsed = EvidenceSetView.safeParse(payload)
  return parsed.success ? parsed.data : null
}
