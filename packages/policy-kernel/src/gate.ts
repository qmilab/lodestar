import type { PolicyDecision, PolicyGate } from "@qmilab/lodestar-action-kernel"
import {
  type Action,
  type ActionContract,
  type Belief,
  type BlastRadius,
  type Policy,
  type PolicyMatch,
  PolicySchema,
  type RequiredAuthority,
  type ResourceScope,
  type SentinelAlertPayload,
  type SentinelSeverity,
} from "@qmilab/lodestar-core"
import { canonicalPolicyHash } from "./hash.js"

/**
 * The gate's three-valued runtime verdict. `hold` is the declarative
 * `require_approval` effect (and the L4 floor) realised at runtime — the
 * action is parked at `pending_approval`. This is an engine type; the wire
 * format (`PolicyEffect`) lives in `@qmilab/lodestar-core`.
 */
export type PolicyVerdict = "allow" | "deny" | "hold"

/**
 * The full, pure result of evaluating a policy against an action. The Action
 * Kernel only sees the narrower `PolicyDecision` (via the gate), so a host
 * re-runs `evaluate()` after `arbitrate()` parks a held action to learn the
 * matched rule's `required_authority` and open the `ApprovalRequest`.
 */
export interface PolicyEvaluation {
  verdict: PolicyVerdict
  reason: string
  /** actor_id stamped as the decision's `approver_id`. */
  decider_id: string
  /** Where the verdict came from — the floor, a rule (with its index), or the
   *  structural deny default. Audit-facing; never silently a default-allow. */
  matched: { source: "floor" | "rule" | "default"; rule_index?: number }
  /** Present iff `verdict === "hold"`: the authority an approver must hold.
   *  `openApprovalRequest()` enriches this with the action's mapped
   *  `data_sensitivity` before the request is written. */
  required_authority?: RequiredAuthority
  /**
   * Present iff the {@link ArbitrationContext arbitrate hook} *strengthened* the
   * base verdict (a sentinel alert, calibration flag, or low-confidence belief
   * lifting `allow → hold`, or `→ deny`). `from` is the contract+rule verdict
   * the floor/rules/default produced; `fired` is every signal that escalated.
   * The top-level `verdict`/`reason` already reflect the decisive (strictest)
   * one — this field is the audit trail showing *both* "the rule allowed it" (in
   * {@link PolicyEvaluation.matched matched}) and "the alert held it". Absent when
   * no signal fired, when no context was supplied, or when the base verdict was
   * already at least as strict (the hook never weakens — see {@link applyArbitration}).
   */
  escalation?: {
    from: PolicyVerdict
    fired: ArbitrationSignalRecord[]
  }
}

/**
 * One signal the arbitrate hook found and the effect it forced. Audit-facing:
 * the decisive record is the strictest `effect` in {@link PolicyEvaluation.escalation}'s
 * `fired` list; the rest are recorded so a report can show every reason the
 * action was strengthened, not only the winning one.
 */
export interface ArbitrationSignalRecord {
  /** Which of the three hook inputs produced it. */
  signal: "sentinel_alert" | "calibration_flag" | "low_confidence_belief"
  /** The effect this signal forced. `none` signals are never recorded. */
  effect: "hold" | "deny"
  /** Human-legible account of what tripped, for the audit log. */
  reason: string
  /** Signal-specific structured context (alert id, flagged classes, weak beliefs). */
  detail?: Record<string, unknown>
}

/** The effect a single arbitrate signal forces. `none` ⇒ ignore the signal. */
export type EscalationEffect = "none" | "hold" | "deny"

/**
 * A backing belief, projected down to exactly the fields the arbitrate hook
 * reads. A full core {@link Belief} is structurally assignable, so a host hands
 * its resolved beliefs straight in. The host does the
 * `action.decision_id → decision.belief_dependencies → belief` resolution
 * (store I/O); the gate stays pure given the result.
 */
export type BackingBelief = Pick<Belief, "id" | "calibration_class" | "confidence" | "truth_status">

/**
 * The single field of a harness `CalibrationReport` the gate consults. Declared
 * structurally *on purpose*: it keeps `@qmilab/lodestar-policy-kernel` from
 * importing `@qmilab/lodestar-harness`, preserving the layering the design
 * protects — the calibrator measures and the Policy Kernel reads its output; the
 * harness never depends on the kernel. A full `CalibrationReport` is assignable.
 */
export interface CalibrationSnapshot {
  readonly flagged_classes: readonly string[]
}

/**
 * The read-only snapshot the arbitrate hook consults for one action. Every
 * field is optional; an absent field simply disables that signal. The host
 * resolves it (the open question in `policy-kernel.md` is settled host-injected:
 * the host that runs the `SentinelRunner` and `calibrate()` owns freshness and
 * scoping) and the gate is a pure function of `(policy, action, context)` given
 * it. Two honesty caveats carried from the design: alerts are the ones that have
 * *already landed* on the sentinel tail (a not-yet-landed alert does not gate —
 * the gate fails open on that one signal while the contract rules still apply),
 * and a calibration class needs `≥ min_samples` before it can flag.
 */
export interface ArbitrationContext {
  /** Beliefs backing the action — see {@link BackingBelief}. */
  beliefs?: readonly BackingBelief[]
  /** Recent, host-scoped `sentinel.alerted@1` payloads; the gate filters them to
   *  this action's own subjects (its beliefs / id / a tool_sequence). */
  alerts?: readonly SentinelAlertPayload[]
  /** Latest calibration snapshot for the action's project; `null` ⇒ inactive. */
  calibration?: CalibrationSnapshot | null
}

/**
 * Host configuration that turns the arbitrate hook on. Supplying it is the only
 * thing that activates alert/calibration/low-confidence escalation; omitting it
 * leaves the gate at its pure contract+rule behaviour (every pre-slice-2 probe
 * stays green). The `resolveContext` resolver may be async (it does store/log
 * reads); a throw propagates — the hook fails *closed* (the action does not
 * proceed) rather than silently disabling enforcement, per the repo's
 * "no silent defaults for security-relevant settings" norm.
 */
export interface ArbitrationConfig {
  resolveContext: (action: Action) => ArbitrationContext | Promise<ArbitrationContext>
  escalation?: EscalationConfig
}

/**
 * The escalation thresholds. Every knob is overridable because escalation *is*
 * policy (`policy-kernel.md`, open question 4); the defaults are the doc's fixed
 * table (`critical → deny`, `warning → hold`, `info → none`) and the
 * low-confidence-action sentinel's own floor (`< 0.5` at level `≥ 3`).
 */
export interface EscalationConfig {
  /** Map an alert's severity to the effect it forces. Default {@link defaultSeverityEffect}. */
  severityEffect?: (severity: SentinelSeverity) => EscalationEffect
  /** A backing belief below this confidence escalates to a hold. Default `0.5`. */
  low_confidence_floor?: number
  /** Only actions at/above this `required_level` get the synchronous
   *  low-confidence check. Default `3` (mirrors the sentinel's `minLevel`). */
  low_confidence_min_level?: number
}

/** A policy compiled into a gate plus its pure evaluator. */
export interface CompiledPolicy {
  readonly policy: Policy
  /** The `PolicyGate` the Action Kernel calls at arbitration. */
  readonly gate: PolicyGate
  /**
   * The pure verdict, re-runnable by the host (no I/O, no clock). With no
   * `context`, returns the contract+rule verdict alone (the pre-slice-2
   * behaviour). With a {@link ArbitrationContext} — the same snapshot the gate
   * resolved — it additionally applies the arbitrate hook. A host that wires
   * `arbitration` and needs to re-derive a hold's `required_authority` after a
   * park must re-run with the *same* context, since an escalation-induced hold
   * is invisible to a contract-only re-run.
   */
  evaluate(action: Action, context?: ArbitrationContext): PolicyEvaluation
}

export interface CompileOptions {
  /** actor_id stamped onto every decision this gate emits (e.g. the policy's
   *  signer, or a configured policy actor). */
  decider_id: string
  /**
   * Permit an unsigned (draft) policy. Security-relevant: an *active* policy
   * must be signed (`v02-delta.md` §5). Defaults to `false`; set `true` only
   * for an explicit, logged development opt-in — never the production path.
   */
  allow_unsigned?: boolean
  /**
   * Optional cryptographic signature verifier, injected by a host that holds
   * the signer's public key. Called after the structural `payload_hash` check;
   * returning `false` rejects the policy. When omitted, v0 relies on the
   * payload-hash match (tamper-evidence) alone.
   */
  verifySignature?: (policy: Policy) => boolean
  /**
   * Wires the {@link ArbitrationContext arbitrate hook} into the gate: at
   * arbitration the gate resolves a read-only snapshot (recent alerts, the
   * calibration report, the action's backing beliefs) and lets it *strengthen*
   * the contract+rule verdict. Omit it and the gate behaves exactly as it did
   * before this slice. This is the piece that finally gives sentinel alerts and
   * calibration flags teeth — they only observe until a Policy Kernel reads them.
   */
  arbitration?: ArbitrationConfig
}

/** Raised when a policy cannot be compiled (e.g. an unsigned active policy). */
export class PolicyCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyCompileError"
  }
}

/**
 * Verify a policy's signature at load. Rejects an unsigned policy (unless
 * `allow_unsigned`), a tampered/stale signature (payload_hash mismatch), and a
 * signature that fails an injected cryptographic check. Exported so a host or
 * probe can verify without compiling.
 */
export function verifyPolicySignature(policy: Policy, options: CompileOptions): void {
  if (policy.signature === undefined) {
    if (options.allow_unsigned === true) return
    throw new PolicyCompileError(
      `policy '${policy.id}@${policy.version}' is unsigned; an active policy must be signed (set allow_unsigned: true only for development drafts)`,
    )
  }
  const expected = canonicalPolicyHash(policy)
  if (policy.signature.payload_hash !== expected) {
    throw new PolicyCompileError(
      `policy '${policy.id}@${policy.version}' signature payload_hash does not match the canonical document — the policy was tampered with or the signature is stale`,
    )
  }
  if (options.verifySignature && !options.verifySignature(policy)) {
    throw new PolicyCompileError(
      `policy '${policy.id}@${policy.version}' signature failed cryptographic verification`,
    )
  }
}

/**
 * Compile a `Policy` document into a `PolicyGate` (plus its pure evaluator).
 * Verifies the signature first (see {@link verifyPolicySignature}), then
 * returns a gate that applies the trust-ladder floor, the ordered
 * first-decisive rule list, and the structural deny default.
 */
export function compile(policy: Policy, options: CompileOptions): CompiledPolicy {
  // Validate the document structurally first (core coding norm: public APIs
  // take Zod-validated input). This enforces the schema refinements — e.g.
  // `approval` only on a require_approval rule, `signed_by` === signer_id —
  // before any semantic check.
  const parsed = PolicySchema.parse(policy)
  verifyPolicySignature(parsed, options)
  const decider_id = options.decider_id
  const escalation = resolveEscalationConfig(options.arbitration?.escalation)
  const evaluate = (action: Action, context?: ArbitrationContext): PolicyEvaluation => {
    const base = evaluatePolicy(parsed, action, decider_id)
    return context ? applyArbitration(base, action, context, escalation) : base
  }
  const gate: PolicyGate = async (action) => {
    // The async boundary: the host resolver does any store/log I/O, then the
    // pure `evaluate` applies the snapshot. No `arbitration` ⇒ no context ⇒ the
    // pre-slice-2 contract+rule verdict, unchanged.
    const context = options.arbitration
      ? await options.arbitration.resolveContext(action)
      : undefined
    return decisionOf(evaluate(action, context))
  }
  return { policy: parsed, gate, evaluate }
}

/** Map a `PolicyEvaluation` onto the Action Kernel's `PolicyDecision`. */
export function decisionOf(ev: PolicyEvaluation): PolicyDecision {
  if (ev.verdict === "allow") {
    return { approved: true, reason: ev.reason, approver_id: ev.decider_id }
  }
  if (ev.verdict === "hold") {
    return {
      approved: false,
      requires_human_approval: true,
      reason: ev.reason,
      approver_id: ev.decider_id,
    }
  }
  return { approved: false, reason: ev.reason, approver_id: ev.decider_id }
}

// -----------------------------------------------------------------------------
// Evaluation: floor → ordered rules → structural deny default
// -----------------------------------------------------------------------------

function evaluatePolicy(policy: Policy, action: Action, decider_id: string): PolicyEvaluation {
  const contract = action.contract
  const level = contract.required_level

  // L5 is prohibited — always deny, nothing overrides.
  if (level >= 5) {
    return {
      verdict: "deny",
      reason: `L${level} is prohibited and can never run in this context`,
      decider_id,
      matched: { source: "floor" },
    }
  }

  const hit = firstMatchingRule(policy, contract, action.tool)

  // The trust-ladder floor for L4 is a *lower bound*, not a fixed verdict: it
  // guarantees L4 (external/shared) NEVER auto-approves, but a matching rule
  // can still make it *more* restrictive. So the rule list is consulted first,
  // and the floor only blocks a downgrade to `allow`:
  //   - a matching `deny` rule           → deny (stricter than the floor; kept)
  //   - a matching `require_approval`    → hold, with the rule's stricter
  //                                         required_authority preserved
  //   - a matching `allow` rule          → hold (the floor lifts allow → hold;
  //                                         allow is impotent at L4)
  //   - no matching rule                 → hold (the floor's baseline; NOT the
  //                                         structural deny default — L4 is the
  //                                         human-in-the-loop tier, not L5)
  // This is what "no rule can *lift* the floor" means: rules may strengthen it,
  // never weaken it. (A literal "L4 → hold, ignore rules" floor would silently
  // drop a stricter rule's deny / required_authority — an under-enforcement.)
  if (level === 4) {
    if (hit) {
      if (hit.rule.effect === "deny") {
        return {
          verdict: "deny",
          reason: hit.rule.reason,
          decider_id,
          matched: { source: "rule", rule_index: hit.index },
        }
      }
      if (hit.rule.effect === "require_approval") {
        return {
          verdict: "hold",
          reason: hit.rule.reason,
          decider_id,
          matched: { source: "rule", rule_index: hit.index },
          required_authority: hit.rule.approval?.required_authority ?? {},
        }
      }
      // effect === "allow": the floor blocks the downgrade.
      return {
        verdict: "hold",
        reason:
          "L4 (external/shared) always requires approval — a matching allow rule cannot lift the floor",
        decider_id,
        matched: { source: "floor" },
        required_authority: {},
      }
    }
    return {
      verdict: "hold",
      reason: "L4 (external/shared) always requires approval",
      decider_id,
      matched: { source: "floor" },
      required_authority: {},
    }
  }

  // L0–L3: ordered, first-decisive rules over the structural deny default.
  if (hit) {
    if (hit.rule.effect === "allow") {
      return {
        verdict: "allow",
        reason: hit.rule.reason,
        decider_id,
        matched: { source: "rule", rule_index: hit.index },
      }
    }
    if (hit.rule.effect === "deny") {
      return {
        verdict: "deny",
        reason: hit.rule.reason,
        decider_id,
        matched: { source: "rule", rule_index: hit.index },
      }
    }
    return {
      verdict: "hold",
      reason: hit.rule.reason,
      decider_id,
      matched: { source: "rule", rule_index: hit.index },
      required_authority: hit.rule.approval?.required_authority ?? {},
    }
  }

  // Structural deny default — no silent allow.
  return {
    verdict: "deny",
    reason: `no policy rule matched action '${action.tool}' (L${level}); structural deny default`,
    decider_id,
    matched: { source: "default" },
  }
}

// -----------------------------------------------------------------------------
// The arbitrate hook: alerts + calibration + low-confidence give the verdict teeth
//
// Sentinels still only emit `sentinel.alerted@1`, the calibrator still only
// returns a `CalibrationReport` — the observe/measure boundary the harness
// guards does not move. The Policy Kernel is what *reads* those signals here and
// decides. The hook can only ever *strengthen* the contract+rule verdict
// (`allow → hold → deny`), never weaken it — the same discipline the L4 floor
// follows. See `docs/architecture/policy-kernel.md` "The arbitrate hook".
// -----------------------------------------------------------------------------

/** Strictness order: a higher rank may replace a lower one, never the reverse. */
const VERDICT_RANK: Record<PolicyVerdict, number> = { allow: 0, hold: 1, deny: 2 }

const DEFAULT_LOW_CONFIDENCE_FLOOR = 0.5
const DEFAULT_LOW_CONFIDENCE_MIN_LEVEL = 3

/** The doc's fixed table: `critical → deny`, `warning → hold`, `info → none`. */
function defaultSeverityEffect(severity: SentinelSeverity): EscalationEffect {
  if (severity === "critical") return "deny"
  if (severity === "warning") return "hold"
  return "none"
}

interface ResolvedEscalation {
  severityEffect: (severity: SentinelSeverity) => EscalationEffect
  lowConfidenceFloor: number
  lowConfidenceMinLevel: number
}

function resolveEscalationConfig(config?: EscalationConfig): ResolvedEscalation {
  return {
    severityEffect: config?.severityEffect ?? defaultSeverityEffect,
    lowConfidenceFloor: config?.low_confidence_floor ?? DEFAULT_LOW_CONFIDENCE_FLOOR,
    lowConfidenceMinLevel: config?.low_confidence_min_level ?? DEFAULT_LOW_CONFIDENCE_MIN_LEVEL,
  }
}

/**
 * Does this alert's subject name *this* action? Encodes the design's
 * "which subjects can gate" table directly:
 * - `belief` — the load-bearing case: gates iff the alert names one of the
 *   action's backing beliefs (`suspicious-memory-origin`).
 * - `decision` — scoped to the action's deciding context (no v0 sentinel emits
 *   one, but the scoping is the conservative answer if one ever does).
 * - `tool_sequence` — names a *completed* flagged sequence; it is meant to gate
 *   *subsequent* actions. The host scopes the alert window (session / recency),
 *   so a flagged sequence present in the snapshot gates the next action.
 * - `action` — `low-confidence-action` names the action itself and fires on the
 *   very event (`action.proposed`) that would gate it, so its alert cannot
 *   reliably pre-exist arbitration. The alert stays an audit tripwire;
 *   *enforcement* of the same condition is the synchronous belief check below,
 *   not a wait on this alert. So an action-subject alert does **not** gate here.
 */
function alertGatesAction(
  alert: SentinelAlertPayload,
  action: Action,
  backingBeliefIds: ReadonlySet<string>,
): boolean {
  const subject = alert.subject
  switch (subject.kind) {
    case "belief":
      return backingBeliefIds.has(subject.id)
    case "decision":
      return action.decision_id !== undefined && subject.id === action.decision_id
    case "tool_sequence":
      return true
    case "action":
      return false
  }
}

/**
 * Apply the arbitrate hook to a base verdict. Pure: a function of
 * `(base, action, context, escalation)`, no I/O, no clock — so a host can
 * re-run it deterministically. Collects every fired signal, then takes the
 * strictest effect; returns the base unchanged when nothing fired or when the
 * base was already at least as strict (the hook never weakens).
 */
function applyArbitration(
  base: PolicyEvaluation,
  action: Action,
  context: ArbitrationContext,
  escalation: ResolvedEscalation,
): PolicyEvaluation {
  // `deny` is already the strictest verdict; nothing can strengthen it, and the
  // hook must not weaken it. Short-circuit so an L5 / deny-rule reason survives.
  if (base.verdict === "deny") return base

  const beliefs = context.beliefs ?? []
  const backingIds = new Set(beliefs.map((b) => b.id))
  const fired: ArbitrationSignalRecord[] = []

  // (A) Sentinel alerts, scoped to this action's own subjects.
  for (const alert of context.alerts ?? []) {
    if (!alertGatesAction(alert, action, backingIds)) continue
    const effect = escalation.severityEffect(alert.severity)
    if (effect === "none") continue
    fired.push({
      signal: "sentinel_alert",
      effect,
      reason:
        `sentinel '${alert.sentinel_name}' (${alert.severity}) flagged ` +
        `${alert.subject.kind} ${alert.subject.id}: ${alert.message}`,
      detail: {
        alert_id: alert.alert_id,
        sentinel_name: alert.sentinel_name,
        rule: alert.rule,
        severity: alert.severity,
        subject: alert.subject,
      },
    })
  }

  // (B) Calibration flags, scoped to the action's backing belief classes.
  const flagged = new Set(context.calibration?.flagged_classes ?? [])
  if (flagged.size > 0) {
    const hits = beliefs.filter((b) => flagged.has(b.calibration_class))
    if (hits.length > 0) {
      const classes = [...new Set(hits.map((b) => b.calibration_class))]
      const classList = classes.map((c) => `'${c}'`).join(", ")
      fired.push({
        signal: "calibration_flag",
        effect: "hold",
        reason: `backing belief(s) in calibrator-flagged class(es) ${classList} — confidence is historically miscalibrated, approval required`,
        detail: { flagged_classes: classes, belief_ids: hits.map((b) => b.id) },
      })
    }
  }

  // (C) Synchronous low-confidence belief check — the enforcement of the
  // low-confidence-action condition that does NOT wait on its (racy) alert.
  if (action.contract.required_level >= escalation.lowConfidenceMinLevel) {
    const weak = beliefs.filter(
      (b) =>
        (typeof b.confidence === "number" && b.confidence < escalation.lowConfidenceFloor) ||
        b.truth_status === "unverified",
    )
    if (weak.length > 0) {
      fired.push({
        signal: "low_confidence_belief",
        effect: "hold",
        reason:
          `action at L${action.contract.required_level} rests on under-supported ` +
          `belief(s) ${weak.map((b) => b.id).join(", ")} ` +
          `(confidence < ${escalation.lowConfidenceFloor} or unverified) — approval required`,
        detail: {
          floor: escalation.lowConfidenceFloor,
          weak_beliefs: weak.map((b) => ({
            id: b.id,
            confidence: b.confidence,
            truth_status: b.truth_status,
          })),
        },
      })
    }
  }

  if (fired.length === 0) return base

  // Strictest fired effect wins; the hook only strengthens.
  const effect: PolicyVerdict = fired.some((f) => f.effect === "deny") ? "deny" : "hold"
  if (VERDICT_RANK[effect] <= VERDICT_RANK[base.verdict]) return base

  const decisive = fired.find((f) => f.effect === effect)
  // `effect` is derived from `fired` (non-empty), so a matching record always
  // exists; the guard is for the type-checker, not a reachable branch.
  if (!decisive) return base

  return {
    verdict: effect,
    reason: decisive.reason,
    decider_id: base.decider_id,
    // `matched` keeps where the *base* verdict came from — the audit shows both
    // "the rule allowed it" and, in `escalation`, "the alert held it".
    matched: base.matched,
    // An escalation-induced hold has no rule authority to inherit (the base was
    // allow); default to `{}` — any approver — exactly as the floor's allow→hold.
    required_authority: effect === "hold" ? (base.required_authority ?? {}) : undefined,
    escalation: { from: base.verdict, fired },
  }
}

/** The first rule (in document order) whose `match` holds, or null. */
function firstMatchingRule(
  policy: Policy,
  contract: ActionContract,
  tool: string,
): { index: number; rule: Policy["rules"][number] } | null {
  for (const [index, rule] of policy.rules.entries()) {
    if (matchesRule(rule.match, contract, tool)) return { index, rule }
  }
  return null
}

const BLAST_ORDER: readonly BlastRadius[] = ["self", "session", "project", "external"]

function blastRank(b: BlastRadius): number {
  return BLAST_ORDER.indexOf(b)
}

/**
 * A rule matches an action when every *present* match field holds (AND); an
 * absent field is a wildcard. An empty `match` matches every action.
 */
function matchesRule(match: PolicyMatch, contract: ActionContract, tool: string): boolean {
  if (match.tool !== undefined && !globMatch(match.tool, tool)) return false
  if (
    match.max_blast_radius !== undefined &&
    blastRank(contract.blast_radius) > blastRank(match.max_blast_radius)
  ) {
    return false
  }
  if (match.reversibility !== undefined && !match.reversibility.includes(contract.reversibility)) {
    return false
  }
  if (
    match.data_sensitivity !== undefined &&
    match.data_sensitivity !== contract.data_sensitivity
  ) {
    return false
  }
  if (
    match.required_level_lte !== undefined &&
    contract.required_level > match.required_level_lte
  ) {
    return false
  }
  if (match.scope !== undefined && !scopeMatches(match.scope, contract.scope)) return false
  return true
}

/** Glob over a tool registry key. `*` is the only wildcard; `.` is literal. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`)
  return re.test(value)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * v0 scope match: exact level + identifier. A rule with a `scope` constraint
 * fires only on an exactly-scoped action; anything else falls through to the
 * deny default (the conservative direction). Hierarchical containment (a
 * project-scoped rule covering its repos/sessions) is a later refinement.
 */
function scopeMatches(want: ResourceScope, got: ResourceScope): boolean {
  return want.level === got.level && want.identifier === got.identifier
}
