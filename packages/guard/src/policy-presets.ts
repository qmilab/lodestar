import type {
  PolicyDecision,
  PolicyGate,
  PreconditionChecker,
} from "@qmilab/lodestar-action-kernel"
import type { Action } from "@qmilab/lodestar-core"

/**
 * Policy preset that auto-approves at the configured ceiling and
 * rejects anything above it. Required for getting started; not a
 * substitute for the Policy Kernel (Batch 4+).
 *
 * No silent default — callers must pass an explicit `auto_approve_up_to`.
 *
 * L5 is "prohibited" in the trust ladder: it can never run in this
 * context. The preset rejects it unconditionally, even when the
 * caller writes `auto_approve_up_to: 5`. Constraining the type to
 * `0..4` would surface this at compile time too, but the runtime
 * check is the load-bearing one — typed callers can still pass a
 * widened number through `unknown`.
 */
export function autoApprovePolicy(input: {
  auto_approve_up_to: 0 | 1 | 2 | 3 | 4
  approver_id: string
}): PolicyGate {
  // Validate the ceiling at construction time. The TypeScript narrowing
  // is helpful but not load-bearing — callers that hand us a value
  // typed as `unknown` (config files, CLI args, JS hosts) can sneak
  // through. The L5 check in the returned gate stops L5 actions but
  // does NOT stop a ceiling of 5+: under such a ceiling, L4 actions
  // would silently auto-approve.
  if (
    !Number.isInteger(input.auto_approve_up_to) ||
    input.auto_approve_up_to < 0 ||
    input.auto_approve_up_to > 4
  ) {
    throw new Error(
      `autoApprovePolicy: auto_approve_up_to must be an integer in [0,4]; got ${String(input.auto_approve_up_to)}. L5 is prohibited and cannot be used as an auto-approve ceiling.`,
    )
  }
  return async (action: Action): Promise<PolicyDecision> => {
    const level = action.contract.required_level

    // L5 is prohibited in the trust ladder. Never approve it.
    if (level >= 5) {
      return {
        approved: false,
        reason: `L${level} is prohibited and cannot run under any auto-approve ceiling`,
        approver_id: input.approver_id,
      }
    }

    if (level <= input.auto_approve_up_to) {
      return {
        approved: true,
        reason: `auto-approved at L${level} (ceiling L${input.auto_approve_up_to})`,
        approver_id: input.approver_id,
      }
    }
    return {
      approved: false,
      reason: `L${level} exceeds auto-approve ceiling L${input.auto_approve_up_to}`,
      approver_id: input.approver_id,
    }
  }
}

/**
 * Precondition checker that treats every precondition as still
 * holding. Suitable only for examples and probes — production callers
 * must supply a real checker that interrogates live state.
 */
export const alwaysHoldsChecker: PreconditionChecker = async () => ({
  holds: true,
  observed: null,
})
