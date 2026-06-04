import type { PreconditionChecker } from "@qmilab/lodestar-action-kernel"

/**
 * Precondition checker that treats every precondition as still
 * holding. Suitable only for examples and probes — production callers
 * must supply a real checker that interrogates live state.
 *
 * `autoApprovePolicy` used to live here too. It has graduated into
 * `@qmilab/lodestar-policy-kernel` (where it is the canonical one-rule
 * "ceiling" policy over the structural deny default, honouring the
 * trust-ladder floor: L4 always holds, L5 denies). Guard re-exports it from
 * there for source compatibility — see `src/index.ts`.
 */
export const alwaysHoldsChecker: PreconditionChecker = async () => ({
  holds: true,
  observed: null,
})
