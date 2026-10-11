import type { ApprovalOutcome } from "@qmilab/lodestar-action-kernel"
import {
  type Action,
  type ApprovalRequest,
  type RepresentableAction,
  actionRepresentationHash,
  canonicalJsonValue,
} from "@qmilab/lodestar-core"

/**
 * The host side of ADR-0042 — binding an approval to the operation it authorizes.
 *
 * Loopjacking's *representation mismatch* is an approver shown something other
 * than what will run. The approval surface now names the held operation
 * (`ApprovalRequest.action_type` / `inputs_hash`), and an approver's tooling binds
 * the representation it *rendered* into the signed resolution. Neither is a
 * boundary on its own: the event log is not authenticated per event, so the
 * request a host reads back, and the record an approver was shown, can both be a
 * local writer's story. The boundary is here, in the one party that holds **the
 * action it is about to run**.
 *
 * Every governance host — `guard.wrap()`, the MCP proxy, the runtime gate —
 * calls {@link representationMismatch} at **every** site where a resolution would
 * be promoted (written to the log as `approval.granted@1` / `approval.denied@1`,
 * or applied through `resolve()`), recomputing the hash from the held action at
 * that moment rather than trusting a remembered value. A non-null result means
 * the resolution is refused: not promoted, audited, and the hold left to expire.
 * One shared predicate so the three hosts cannot drift on what counts as a
 * mismatch.
 */

/** The prefix every representation-refusal reason carries, in audits and errors. */
export const REPRESENTATION_MISMATCH_PREFIX = "representation mismatch:"

/**
 * Why a resolution may not be promoted against `action` — the action the host
 * will execute — or `null` when the binding holds. Checks, in order:
 *
 *   1. the request's `action_type`, when present, is the action's tool;
 *   2. the request's `inputs_hash`, when present, is the action's representation
 *      hash — the request still describes the held action (a request rebuilt from
 *      a planted log record, or a held action whose live inputs changed, fails);
 *   3. the resolution's signed `inputs_hash`, when present, is the action's
 *      representation hash — the approver authorized *this* operation.
 *
 * Any absent field is the legacy, unbound shape and is not checked — binding is
 * verify-if-present (ADR-0042 §3).
 */
export function representationMismatch(
  action: RepresentableAction,
  request: Pick<ApprovalRequest, "action_type" | "inputs_hash">,
  resolution?: { inputs_hash?: string },
): string | null {
  if (request.action_type !== undefined && request.action_type !== action.tool) {
    return `${REPRESENTATION_MISMATCH_PREFIX} the approval request names tool '${request.action_type}', but the held action runs '${action.tool}'`
  }
  const actual = actionRepresentationHash(action)
  if (request.inputs_hash !== undefined && request.inputs_hash !== actual) {
    return `${REPRESENTATION_MISMATCH_PREFIX} the approval request is bound to ${request.inputs_hash}, but the held action hashes to ${actual} — the request no longer describes the action it would authorize`
  }
  if (resolution?.inputs_hash !== undefined && resolution.inputs_hash !== actual) {
    return `${REPRESENTATION_MISMATCH_PREFIX} the approver authorized ${resolution.inputs_hash}, but the held action hashes to ${actual} — they were shown a different operation`
  }
  return null
}

/**
 * The held action with its `inputs` and `contract` replaced by their canonical
 * JSON values, for the cross-process hosts to execute once the binding check has
 * passed (ADR-0042 §1).
 *
 * Canonical JSON treats objects as unordered and cannot express `-0`, so two
 * values a tool could tell apart can share a representation hash. Executing the
 * canonical value closes that by construction: the tool receives byte-for-byte
 * the value the approver's hash covers. The representation hash is unchanged by
 * the replacement — canonical JSON is a fixed point.
 *
 * The MCP proxy and the runtime gate use it; their inputs arrive as JSON anyway,
 * so only key order and `-0` can change. `guard.wrap()` does not: in process, a
 * tool schema may produce non-JSON values (a `Date`) that this would destroy.
 *
 * Only a **bound** request (one carrying `inputs_hash`) is canonicalized. A
 * pre-ADR-0042 request — a runtime gate resuming a hold from an older log — binds
 * no representation, so its action executes exactly as it did before: its
 * behaviour, and the bytes of its `action.approved`, are unchanged.
 */
export function canonicalForExecution(
  action: Action,
  request: Pick<ApprovalRequest, "inputs_hash">,
): Action {
  if (request.inputs_hash === undefined) return action
  return {
    ...action,
    inputs: canonicalJsonValue(action.inputs),
    // An ActionContract is JSON-shaped by schema (its one open field,
    // `expected_at_approval`, is `unknown`), so normalization keeps the shape.
    contract: canonicalJsonValue(action.contract) as Action["contract"],
  }
}

/**
 * The outcome a host hands `ActionKernel.resolve()`, bound to the request's
 * representation when the outcome does not already carry one — so the kernel's
 * backstop re-checks, at the moment of the transition, that the held action is
 * still the operation the request named. It closes the window between a host's
 * promote-time check and `resolve()` (an awaited log write sits between them).
 *
 * Apply it to the outcome passed to `resolve()` ONLY, never to the one written to
 * the log: a promoted `approval.granted@1` must carry exactly the fields its
 * approver signed, or it would no longer verify.
 */
export function bindOutcomeToRequest(
  outcome: ApprovalOutcome,
  request: Pick<ApprovalRequest, "inputs_hash">,
): ApprovalOutcome {
  if (outcome.kind === "expired" || outcome.inputs_hash !== undefined) return outcome
  if (request.inputs_hash === undefined) return outcome
  return { ...outcome, inputs_hash: request.inputs_hash }
}
