import { randomUUID } from "node:crypto"
import { type ApprovalOutcome, sensitivityForContract } from "@qmilab/lodestar-action-kernel"
import type {
  Action,
  Actor,
  ApprovalRequest,
  RequiredAuthority,
  ResourceScope,
  Sensitivity,
} from "@qmilab/lodestar-core"
import type { PolicyEvaluation } from "./gate.js"

/**
 * The approval lifecycle. Core owns the wire format (`ApprovalRequest`, the
 * `approval.*` events); this module is the behaviour:
 *
 *   hold (gate) → openApprovalRequest → [out-of-band resolution]
 *                 → authorizeResolution / expireRequest → ApprovalOutcome
 *                 → ActionKernel.resolve()  (the Action Kernel applies it)
 *
 * The Policy Kernel *decides* who may resolve (matching an `Actor` against the
 * request's `required_authority`); the Action Kernel *applies* the resulting
 * `ApprovalOutcome` as a phase transition. Neither imports the other's runtime
 * state.
 */

export interface OpenApprovalRequestOptions {
  /** ISO 8601 hold deadline — the proxy path's timeout. Omitted entirely
   *  in-process (a `guard.wrap()` hold simply awaits the resolver). */
  deadline?: string
  /** When the request was opened. Defaults to now. */
  requested_at?: string
  /** Override the generated request_id (deterministic logs / tests). */
  request_id?: string
}

/**
 * Open an `ApprovalRequest` for a held action. The request's
 * `required_authority` is the matched rule's authority *enriched with the
 * action's `data_sensitivity` mapped into the 4-value clearance* (via the
 * Action Kernel's `sensitivityForContract`), so an approver must clear at
 * least the action's sensitivity. `deadline` is set only when supplied —
 * never written as `undefined` (the canonical-hash discipline the
 * `approval.*` payloads hold).
 */
export function openApprovalRequest(
  action: Action,
  evaluation: PolicyEvaluation,
  options: OpenApprovalRequestOptions = {},
): ApprovalRequest {
  if (evaluation.verdict !== "hold") {
    throw new Error(
      `policy-kernel: openApprovalRequest called for a '${evaluation.verdict}' verdict; only a hold opens a request`,
    )
  }
  const request: ApprovalRequest = {
    request_id: options.request_id ?? randomUUID(),
    action_id: action.id,
    reason: evaluation.reason,
    required_authority: withActionSensitivity(evaluation.required_authority ?? {}, action),
    requested_at: options.requested_at ?? new Date().toISOString(),
  }
  if (options.deadline !== undefined) {
    request.deadline = options.deadline
  }
  return request
}

export type AuthorizationResult =
  | { authorized: true; outcome: ApprovalOutcome }
  | { authorized: false; reason: string }

/**
 * Decide whether `approver` may resolve `request` with the given verdict, and
 * if so produce the `ApprovalOutcome` the Action Kernel's `resolve()` applies.
 * The approver must clear every present field of the request's
 * `required_authority`. A shortfall returns `{ authorized: false, reason }`;
 * the host then leaves the action parked (or re-routes to another approver)
 * rather than un-parking it.
 */
export function authorizeResolution(
  request: ApprovalRequest,
  approver: Actor,
  kind: "granted" | "denied",
  options: { reason?: string; at?: string } = {},
): AuthorizationResult {
  const shortfall = approverShortfall(approver, request.required_authority)
  if (shortfall !== null) {
    return {
      authorized: false,
      reason: `approver '${approver.id}' may not resolve request '${request.request_id}': ${shortfall}`,
    }
  }
  // Bind the outcome to the request's action so resolve() can refuse to apply
  // it to any other pending action.
  const bind = { action_id: request.action_id, request_id: request.request_id }
  const outcome: ApprovalOutcome =
    kind === "granted"
      ? {
          kind: "granted",
          ...bind,
          approver_id: approver.id,
          reason: options.reason,
          at: options.at,
        }
      : {
          kind: "denied",
          ...bind,
          approver_id: approver.id,
          reason: options.reason,
          at: options.at,
        }
  return { authorized: true, outcome }
}

/**
 * The deadline-passed outcome — a held request whose `deadline` elapsed with
 * no resolution. Carries no approver (the deadline, not an actor, resolved
 * it) but stays bound to its request's action. The Action Kernel rejects the
 * parked action on receipt; v0 treats a timed-out hold as a soft denial the
 * agent re-proposes.
 */
export function expireRequest(
  request: ApprovalRequest,
  options: { at?: string; reason?: string } = {},
): ApprovalOutcome {
  return {
    kind: "expired",
    action_id: request.action_id,
    request_id: request.request_id,
    reason: options.reason,
    at: options.at,
  }
}

// -----------------------------------------------------------------------------
// Authority matching
// -----------------------------------------------------------------------------

const SENSITIVITY_ORDER: readonly Sensitivity[] = ["public", "internal", "confidential", "secret"]

function sensitivityRank(s: Sensitivity): number {
  return SENSITIVITY_ORDER.indexOf(s)
}

function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) >= sensitivityRank(b) ? a : b
}

/** Merge the action's mapped `data_sensitivity` into the rule's authority. */
function withActionSensitivity(ra: RequiredAuthority, action: Action): RequiredAuthority {
  const mapped = sensitivityForContract(action.contract.data_sensitivity)
  const out: RequiredAuthority = {
    sensitivity_clearance: ra.sensitivity_clearance
      ? maxSensitivity(ra.sensitivity_clearance, mapped)
      : mapped,
  }
  if (ra.min_trust_baseline !== undefined) out.min_trust_baseline = ra.min_trust_baseline
  if (ra.scope !== undefined) out.scope = ra.scope
  return out
}

/** `null` if the approver clears the authority, else a human-readable reason. */
function approverShortfall(approver: Actor, ra: RequiredAuthority): string | null {
  if (ra.min_trust_baseline !== undefined && approver.trust_baseline < ra.min_trust_baseline) {
    return `trust_baseline ${approver.trust_baseline} is below the required ${ra.min_trust_baseline}`
  }
  if (
    ra.sensitivity_clearance !== undefined &&
    sensitivityRank(approver.sensitivity_clearance) < sensitivityRank(ra.sensitivity_clearance)
  ) {
    return `sensitivity_clearance '${approver.sensitivity_clearance}' does not clear '${ra.sensitivity_clearance}'`
  }
  if (ra.scope !== undefined && !holdsScope(approver.authority_scope, ra.scope)) {
    return `does not hold the required scope ${ra.scope.level}:${ra.scope.identifier}`
  }
  return null
}

/**
 * v0 scope authority: an approver holds the required scope if any of their
 * `authority_scope` entries is `global` (covers everything) or an exact
 * level+identifier match. Hierarchical containment is a later refinement —
 * the same conservative direction as the gate's `scopeMatches`.
 */
function holdsScope(held: ResourceScope[], required: ResourceScope): boolean {
  return held.some(
    (s) =>
      s.level === "global" || (s.level === required.level && s.identifier === required.identifier),
  )
}
