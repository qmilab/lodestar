import type { Action } from "@orrery/core"
import type { PolicyDecision, PolicyGate, PreconditionChecker } from "@orrery/action-kernel"

/**
 * Policy preset that auto-approves at the configured ceiling and
 * rejects anything above it. Required for getting started; not a
 * substitute for the Policy Kernel (Batch 4+).
 *
 * No silent default — callers must pass an explicit `auto_approve_up_to`.
 */
export function autoApprovePolicy(input: {
  auto_approve_up_to: 0 | 1 | 2 | 3 | 4 | 5
  approver_id: string
}): PolicyGate {
  return async (action: Action): Promise<PolicyDecision> => {
    const level = action.contract.required_level
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
