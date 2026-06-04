import type { PolicyGate } from "@qmilab/lodestar-action-kernel"
import type { Policy } from "@qmilab/lodestar-core"
import { type CompiledPolicy, compile } from "./gate.js"

/**
 * The graduated "ceiling" preset. `autoApprovePolicy({ auto_approve_up_to: N })`
 * is the one-rule policy `[{ match: { required_level_lte: N }, effect: allow }]`
 * over the structural deny default — getting-started stays one line, but the
 * underlying object is now an inspectable, signable `Policy`.
 *
 * The ceiling caps at **L3**. Auto-approving L4 is not expressible: the
 * trust-ladder floor always holds L4 for approval and denies L5, regardless of
 * any rule. (This is deliberately *tighter* than the legacy
 * `@qmilab/lodestar-guard` preset, which accepted a ceiling of 4 and
 * auto-approved L4 — that preset is unchanged until the guard host wiring
 * lands; this one honours the floor.)
 */
export interface AutoApproveInput {
  /** Auto-approve actions at or below this level. L4 always holds, L5 denies. */
  auto_approve_up_to: 0 | 1 | 2 | 3
  /** actor_id stamped onto the gate's decisions. */
  approver_id: string
}

/** Build the (unsigned) `Policy` document behind the ceiling preset. */
export function autoApprovePolicyDocument(input: AutoApproveInput): Policy {
  validateCeiling(input.auto_approve_up_to)
  return {
    id: "auto-approve",
    version: `ceiling-L${input.auto_approve_up_to}`,
    rules: [
      {
        match: { required_level_lte: input.auto_approve_up_to },
        effect: "allow",
        reason: `auto-approved at or below L${input.auto_approve_up_to} (ceiling)`,
      },
    ],
  }
}

/** Compile the ceiling preset, returning the full `CompiledPolicy`. */
export function autoApprovePolicyCompiled(input: AutoApproveInput): CompiledPolicy {
  const policy = autoApprovePolicyDocument(input)
  // Getting-started convenience: the preset is an unsigned draft, compiled
  // under an explicit opt-in. A production deployment signs its policy and
  // compiles without `allow_unsigned`.
  return compile(policy, { decider_id: input.approver_id, allow_unsigned: true })
}

/** Compile the ceiling preset down to a bare `PolicyGate` for the Action Kernel. */
export function autoApprovePolicy(input: AutoApproveInput): PolicyGate {
  return autoApprovePolicyCompiled(input).gate
}

function validateCeiling(n: number): void {
  // Runtime guard is load-bearing: the typed literal helps, but a JS host or a
  // config value typed as `unknown` can widen it.
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw new Error(
      `autoApprovePolicy: auto_approve_up_to must be an integer in [0,3]; got ${String(n)}. L4 always requires approval and L5 is prohibited — neither is an expressible auto-approve ceiling.`,
    )
  }
}
