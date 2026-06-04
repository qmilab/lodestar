import type { PolicyDecision, PolicyGate } from "@qmilab/lodestar-action-kernel"
import {
  type Action,
  type ActionContract,
  type BlastRadius,
  type Policy,
  type PolicyMatch,
  PolicySchema,
  type RequiredAuthority,
  type ResourceScope,
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
}

/** A policy compiled into a gate plus its pure evaluator. */
export interface CompiledPolicy {
  readonly policy: Policy
  /** The `PolicyGate` the Action Kernel calls at arbitration. */
  readonly gate: PolicyGate
  /** The pure verdict, re-runnable by the host (no I/O, no clock). */
  evaluate(action: Action): PolicyEvaluation
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
  const evaluate = (action: Action): PolicyEvaluation => evaluatePolicy(parsed, action, decider_id)
  const gate: PolicyGate = async (action) => decisionOf(evaluate(action))
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
