import type {
  Action,
  ActionPhase,
  Belief,
  Claim,
  Observation,
  Sensitivity,
} from "@qmilab/lodestar-core"
import type {
  ChainProjection,
  FirewallTransition,
  ProjectedAction,
  ProjectedDecision,
} from "@qmilab/lodestar-trace"
import { isoToUnixNano, spanIdFor, traceIdFor } from "./ids.js"
import {
  SENSITIVITY_ORDER,
  contentSensitivityForAction,
  isAboveCeiling,
  isSensitivity,
  sensitivityRank,
} from "./sensitivity.js"

/**
 * Neutral, OTel-free intermediate representation of a trace.
 *
 * `project-spans` is the heart of the package and carries no OpenTelemetry
 * dependency: it turns a {@link ChainProjection} into this IR, which
 * `otlp.ts` then serialises to the wire format. Keeping the mapping pure
 * makes it trivially testable and keeps the sensitivity gate in one place.
 */

/** An OTLP-compatible attribute value (scalar or homogeneous array). */
export type AttrValue = string | number | boolean | string[] | number[] | boolean[]

export interface LodestarSpanEvent {
  name: string
  time_unix_nano: string
  attributes: Record<string, AttrValue>
}

export type SpanStatusCode = "unset" | "ok" | "error"

export interface LodestarSpan {
  name: string
  span_id: string
  parent_span_id?: string
  kind: "internal"
  start_unix_nano: string
  end_unix_nano: string
  status: { code: SpanStatusCode; message?: string }
  attributes: Record<string, AttrValue>
  events: LodestarSpanEvent[]
}

export interface LodestarTrace {
  trace_id: string
  resource_attributes: Record<string, AttrValue>
  spans: LodestarSpan[]
  /** Number of content attributes withheld by the sensitivity gate. */
  redacted_count: number
}

export interface BuildTraceOptions {
  /** Content whose source sensitivity outranks this is withheld. Default "internal". */
  sensitivityCeiling?: Sensitivity
}

// ── The sensitivity gate ─────────────────────────────────────────────────

interface GateState {
  ceiling: Sensitivity
  redacted: number
}

/**
 * Accumulates a span / event's attribute bag, enforcing the sensitivity
 * gate. `put` is for structural metadata (always emitted); `putContent`
 * is for anything derived from claim / observation / input *content* —
 * it is withheld (and replaced by a `*.redacted` + `*.payload_hash`
 * marker) when its source sensitivity outranks the ceiling.
 */
class Attrs {
  readonly bag: Record<string, AttrValue> = {}
  constructor(private readonly gate: GateState) {}

  put(key: string, value: AttrValue | undefined): this {
    if (value !== undefined) this.bag[key] = value
    return this
  }

  putContent(
    key: string,
    value: AttrValue | undefined,
    source: Sensitivity,
    payloadHash?: string,
  ): this {
    if (value === undefined) return this
    if (isAboveCeiling(source, this.gate.ceiling)) {
      this.bag[`${key}.redacted`] = true
      if (payloadHash) this.bag[`${key}.payload_hash`] = payloadHash
      this.gate.redacted++
    } else {
      this.bag[key] = value
    }
    return this
  }
}

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Project an epistemic-chain {@link ChainProjection} into the neutral
 * trace IR, applying the sensitivity gate. Pure: no I/O, deterministic
 * ids, no wall clock.
 *
 * Action-centric model: the session is the root `invoke_agent` span; each
 * governed Action is an `execute_tool` child span; observations, beliefs,
 * decisions, and firewall transitions ride as span events on the root.
 */
export function buildTrace(
  projection: ChainProjection,
  opts: BuildTraceOptions = {},
): LodestarTrace {
  // Only an omitted option (`undefined`) takes the default. A present-but-
  // invalid value — null, "", a typo from JS/config — must reach validation
  // and fail loud, never silently fall back to internal (a `??` default would
  // swallow null).
  const ceiling = opts.sensitivityCeiling === undefined ? "internal" : opts.sensitivityCeiling
  // Validate the ceiling at runtime: a typo'd / config-derived value would
  // otherwise rank above every real level (see `sensitivityRank`) and make
  // the gate fail open — exporting even `secret` content. Fail loud instead.
  if (!isSensitivity(ceiling)) {
    throw new Error(
      `invalid sensitivity ceiling: ${JSON.stringify(ceiling)} ` +
        `(expected one of ${SENSITIVITY_ORDER.join(", ")})`,
    )
  }
  const gate: GateState = { ceiling, redacted: 0 }

  const session = projection.session_id
  const trace_id = traceIdFor(session)
  const rootSpanId = spanIdFor(session, `session:${session}`)

  const meta = buildMetaIndex(projection)
  const claimById = new Map<string, Claim>()
  for (const c of projection.claims) claimById.set(c.id, c)
  const beliefById = new Map<string, Belief>()
  for (const b of projection.beliefs) beliefById.set(b.id, b)

  // ── Root span: the session ──────────────────────────────────────────
  const rootAttrs = new Attrs(gate)
  rootAttrs
    .put("gen_ai.operation.name", "invoke_agent")
    .put("gen_ai.conversation.id", session)
    .put("lodestar.session.id", session)
    .put("lodestar.project.id", projection.project_id)
    .put("lodestar.actor_ids", [...projection.actor_ids])
    .put("lodestar.event_count", projection.event_count)
  const model = singleModel(projection)
  if (model) rootAttrs.put("gen_ai.request.model", model)

  const rootEvents: LodestarSpanEvent[] = []
  for (const obs of projection.observations) rootEvents.push(observationEvent(obs, meta, gate))
  for (const b of projection.beliefs) rootEvents.push(beliefEvent(b, claimById, meta, gate))
  for (const d of projection.decisions)
    rootEvents.push(decisionEvent(d, beliefById, claimById, meta, gate))
  for (const t of projection.transitions) rootEvents.push(transitionEvent(t, gate))
  rootEvents.sort(byTime)

  const anyFailed = projection.actions.some((a) => isErrorPhase(a.terminal_phase))

  // ── Action spans: execute_tool ──────────────────────────────────────
  const actionSpans: LodestarSpan[] = []
  for (const pa of projection.actions) {
    const span = actionSpan(pa, session, rootSpanId, meta, gate)
    if (span) actionSpans.push(span)
  }

  // The root must enclose every child span and event. Child spans/events are
  // timed off *payload* timestamps (proposed_at, observed_at, terminal audit
  // `at`) which can fall outside the envelope range — so bounding the root on
  // the envelope alone (first/last_event_at) would let a child extend past
  // it. Widen the root to span the earliest..latest of every contained time.
  const { start: rootStart, end: rootEnd } = spanBounds([
    isoToUnixNano(projection.first_event_at),
    isoToUnixNano(projection.last_event_at ?? projection.first_event_at),
    ...rootEvents.map((e) => e.time_unix_nano),
    ...actionSpans.flatMap((s) => [s.start_unix_nano, s.end_unix_nano]),
  ])

  const rootSpan: LodestarSpan = {
    name: `invoke_agent ${projection.project_id || session}`,
    span_id: rootSpanId,
    kind: "internal",
    start_unix_nano: rootStart,
    end_unix_nano: rootEnd,
    status: { code: anyFailed ? "error" : "unset" },
    attributes: rootAttrs.bag,
    events: rootEvents,
  }

  const spans: LodestarSpan[] = [rootSpan, ...actionSpans]

  const resource_attributes: Record<string, AttrValue> = {
    "service.name": "lodestar",
    "lodestar.project.id": projection.project_id,
  }

  return { trace_id, resource_attributes, spans, redacted_count: gate.redacted }
}

/**
 * The earliest..latest bounds over a set of unix-nano timestamps. The "0"
 * sentinel (a missing/unparseable timestamp) is ignored; if everything is
 * absent the bounds collapse to "0".
 */
function spanBounds(nanos: string[]): { start: string; end: string } {
  let min: bigint | undefined
  let max: bigint | undefined
  for (const n of nanos) {
    if (n === "0") continue
    const v = BigInt(n)
    if (min === undefined || v < min) min = v
    if (max === undefined || v > max) max = v
  }
  const start = min !== undefined ? min.toString() : "0"
  const end = max !== undefined ? max.toString() : start
  return { start, end }
}

// ── Span / event builders ────────────────────────────────────────────────

function actionSpan(
  pa: ProjectedAction,
  session: string,
  parentSpanId: string,
  meta: Map<string, RecordMeta>,
  gate: GateState,
): LodestarSpan | undefined {
  const action = pa.action
  // Outcome-only entries (an outcome seen before/without its action) have
  // no tool or proposed_at — there is no span to render.
  if (!action) return undefined

  const a = new Attrs(gate)
  a.put("gen_ai.operation.name", "execute_tool")
    .put("gen_ai.tool.name", action.tool)
    .put("gen_ai.tool.call.id", action.id)
    .put("lodestar.action.phase", pa.terminal_phase)
    .put("lodestar.policy.verdict", policyVerdict(pa.terminal_phase))
    .put("lodestar.trust.required_level", action.contract.required_level)
    .put("lodestar.blast_radius", action.contract.blast_radius)
    .put("lodestar.reversibility", action.contract.reversibility)
    .put("lodestar.data_sensitivity", action.contract.data_sensitivity)
  if (action.decision_id) a.put("lodestar.decision_id", action.decision_id)

  // Content: intent + inputs, gated on the action's data_sensitivity.
  const src = contentSensitivityForAction(action.contract.data_sensitivity)
  const hash = meta.get(action.id)?.hash
  a.putContent("lodestar.action.intent", action.intent, src, hash)
  a.putContent("lodestar.action.inputs", safeJson(action.inputs), src, hash)

  if (pa.outcome) {
    a.put("lodestar.outcome.result", pa.outcome.result)
    a.put("lodestar.outcome.duration_ms", pa.outcome.duration_ms)
  }

  const status: { code: SpanStatusCode; message?: string } = isErrorPhase(pa.terminal_phase)
    ? { code: "error", message: pa.outcome?.result ?? pa.terminal_phase }
    : { code: pa.terminal_phase === "completed" ? "ok" : "unset" }

  // Span end. An Outcome (completed/failed) carries the real end time. The
  // many terminal states that produce NO Outcome — rejected, halted,
  // pending_approval, approval timeout — instead record their terminal time
  // in the audit trail (and `approval`); use the latest of those so the span
  // reflects when policy actually denied/halted the action rather than
  // collapsing to a zero-length span at proposal time. `proposed_at` is the
  // last resort, and the end is clamped to never precede the start.
  const start_unix_nano = isoToUnixNano(action.proposed_at)
  const endAt = pa.outcome?.observed_at ?? latestTimestamp(terminalCandidates(action))
  const endNano = endAt ? isoToUnixNano(endAt) : start_unix_nano
  const end_unix_nano = BigInt(endNano) >= BigInt(start_unix_nano) ? endNano : start_unix_nano

  return {
    name: `execute_tool ${action.tool}`,
    span_id: spanIdFor(session, action.id),
    parent_span_id: parentSpanId,
    kind: "internal",
    start_unix_nano,
    end_unix_nano,
    status,
    attributes: a.bag,
    events: [],
  }
}

/** Timestamps that can mark an action's terminal transition without an Outcome. */
function terminalCandidates(action: Action): Array<string | undefined> {
  const candidates: Array<string | undefined> = action.audit.map((e) => e.at)
  if (action.approval) candidates.push(action.approval.at)
  return candidates
}

/** The latest parseable timestamp among the candidates (original string preserved). */
function latestTimestamp(candidates: Array<string | undefined>): string | undefined {
  let best: string | undefined
  let bestMs = Number.NEGATIVE_INFINITY
  for (const c of candidates) {
    if (!c) continue
    const ms = Date.parse(c)
    if (Number.isNaN(ms)) continue
    if (ms > bestMs) {
      bestMs = ms
      best = c
    }
  }
  return best
}

function observationEvent(
  obs: Observation,
  meta: Map<string, RecordMeta>,
  gate: GateState,
): LodestarSpanEvent {
  const a = new Attrs(gate)
  const m = meta.get(obs.id)
  a.put("lodestar.observation.id", obs.id)
    .put("lodestar.observation.schema", obs.schema)
    .put("lodestar.observation.tool", obs.source.tool)
    .put("lodestar.trust", obs.trust)
    .put("lodestar.sensitivity", obs.sensitivity)
  a.putContent("lodestar.observation.payload", safeJson(obs.payload), obs.sensitivity, m?.hash)
  return {
    name: "observation.recorded",
    time_unix_nano: isoToUnixNano(m?.timestamp ?? obs.source.captured_at),
    attributes: a.bag,
  }
}

function beliefEvent(
  b: Belief,
  claimById: Map<string, Claim>,
  meta: Map<string, RecordMeta>,
  gate: GateState,
): LodestarSpanEvent {
  const a = new Attrs(gate)
  const m = meta.get(b.id)
  a.put("lodestar.belief.id", b.id)
    .put("lodestar.belief.claim_id", b.claim_id)
    .put("lodestar.truth_status", b.truth_status)
    .put("lodestar.retrieval_status", b.retrieval_status)
    .put("lodestar.security_status", b.security_status)
    .put("lodestar.freshness_status", b.freshness_status)
    .put("lodestar.sensitivity", b.sensitivity)
    .put("lodestar.confidence", b.confidence)
    .put("lodestar.calibration_class", b.calibration_class)
    .put("lodestar.authority", b.authority)

  // The claim statement is content. Gate by the stricter of the belief's
  // and the claim's sensitivity (fail closed), and point the redaction
  // marker at the claim's own payload hash — that is the content withheld.
  const claim = claimById.get(b.claim_id)
  if (claim) {
    const src = stricter(b.sensitivity, claim.sensitivity)
    const claimHash = meta.get(claim.id)?.hash ?? m?.hash
    a.putContent("lodestar.belief.statement", claim.statement, src, claimHash)
  }

  return {
    name: "belief.adopted",
    time_unix_nano: isoToUnixNano(m?.timestamp ?? b.observed_at),
    attributes: a.bag,
  }
}

function decisionEvent(
  d: ProjectedDecision,
  beliefById: Map<string, Belief>,
  claimById: Map<string, Claim>,
  meta: Map<string, RecordMeta>,
  gate: GateState,
): LodestarSpanEvent {
  const a = new Attrs(gate)
  const m = d.id ? meta.get(d.id) : undefined
  if (d.id) a.put("lodestar.decision.id", d.id)
  if (d.belief_dependencies) {
    a.put("lodestar.decision.belief_dependencies", d.belief_dependencies)
    a.put("lodestar.decision.belief_dependency_count", d.belief_dependencies.length)
  }
  if (d.made_by) a.put("lodestar.decision.made_by", d.made_by)
  // The question / intent is free-form content that can echo the claim text
  // of the beliefs the decision depends on, so it must be gated at least as
  // strictly as the strictest dependency — otherwise a secret belief that was
  // itself redacted leaks through the decision event.
  if (d.question !== undefined) {
    const src = decisionContentSensitivity(d, beliefById, claimById)
    a.putContent("lodestar.decision.question", d.question, src, m?.hash)
  }
  return {
    name: "decision.made",
    time_unix_nano: isoToUnixNano(m?.timestamp ?? d.made_at),
    attributes: a.bag,
  }
}

/**
 * The sensitivity at which a decision's free-text question/intent must be
 * gated. Floored at `internal` (the default tool-output level — a
 * dependency-free intent is the agent's own text), then raised to the
 * strictest sensitivity of every belief the decision depends on (and that
 * belief's claim). A dependency we cannot resolve to verify its sensitivity
 * fails closed (`secret`): we cannot prove the question is safe to export.
 */
function decisionContentSensitivity(
  d: ProjectedDecision,
  beliefById: Map<string, Belief>,
  claimById: Map<string, Claim>,
): Sensitivity {
  let level: Sensitivity = "internal"
  for (const beliefId of d.belief_dependencies ?? []) {
    const belief = beliefById.get(beliefId)
    if (!belief) return "secret"
    level = stricter(level, belief.sensitivity)
    const claim = claimById.get(belief.claim_id)
    if (claim) level = stricter(level, claim.sensitivity)
  }
  return level
}

function transitionEvent(t: FirewallTransition, gate: GateState): LodestarSpanEvent {
  const a = new Attrs(gate)
  // Firewall transitions carry only ids/axes — structural, no gating.
  a.put("lodestar.transition.kind", t.kind)
  if (t.claim_id) a.put("lodestar.transition.claim_id", t.claim_id)
  if (t.belief_id) a.put("lodestar.transition.belief_id", t.belief_id)
  if (t.axis) a.put("lodestar.transition.axis", t.axis)
  if (t.from_value) a.put("lodestar.transition.from", t.from_value)
  if (t.to_value) a.put("lodestar.transition.to", t.to_value)
  if (t.by_authority) a.put("lodestar.transition.by_authority", t.by_authority)
  return {
    name: `firewall.${t.kind}`,
    time_unix_nano: isoToUnixNano(t.at),
    attributes: a.bag,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface RecordMeta {
  hash: string
  timestamp: string
}

/**
 * Index `{ payload_hash, timestamp }` by the payload's `id`, so events can
 * be timed off the real envelope and redaction markers can carry the
 * tamper-evident hash of the withheld content.
 */
function buildMetaIndex(projection: ChainProjection): Map<string, RecordMeta> {
  const m = new Map<string, RecordMeta>()
  for (const ev of projection.raw_events) {
    const p = ev.payload
    if (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string") {
      const id = (p as { id: string }).id
      // Keep the first envelope seen for an id (its creation), which is
      // the most stable timestamp for ordering.
      if (!m.has(id)) m.set(id, { hash: ev.payload_hash, timestamp: ev.timestamp })
    }
  }
  return m
}

function isErrorPhase(phase: ActionPhase): boolean {
  return phase === "failed" || phase === "rejected" || phase === "halted"
}

function policyVerdict(phase: ActionPhase): string {
  switch (phase) {
    case "rejected":
      return "deny"
    case "pending_approval":
      return "hold"
    case "approved":
    case "executing":
    case "completed":
    case "failed":
      // Policy allowed it; "failed" is a runtime failure, not a denial.
      return "allow"
    case "halted":
      return "halt"
    default:
      return "unknown"
  }
}

function stricter(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) >= sensitivityRank(b) ? a : b
}

function singleModel(projection: ChainProjection): string | undefined {
  const models = new Set<string>()
  for (const ev of projection.raw_events) {
    const mdl = ev.versions?.model
    if (mdl) models.add(mdl)
  }
  return models.size === 1 ? [...models][0] : undefined
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function byTime(a: LodestarSpanEvent, b: LodestarSpanEvent): number {
  const x = BigInt(a.time_unix_nano)
  const y = BigInt(b.time_unix_nano)
  return x < y ? -1 : x > y ? 1 : 0
}
