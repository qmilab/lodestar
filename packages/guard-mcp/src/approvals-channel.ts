/**
 * The approval side-channel **graduated to `@qmilab/lodestar-guard`** (ADR-0025)
 * once a second governance host appeared (`@qmilab/lodestar-runtime-core`, the
 * runtime-adapter gate, ADR-0024). It is the cross-process transport for a
 * *signed* approval resolution (ADR-0010 / ADR-0015) and now lives next to the
 * Ed25519 sign/verify primitives it pairs with, so the security-critical
 * signed-format reader has exactly one implementation across the proxy and the
 * gate rather than a copy in each.
 *
 * This module is a thin re-export shim so the proxy, the `lodestar approve` CLI,
 * and the probes keep importing the same names from
 * `@qmilab/lodestar-guard-mcp` unchanged.
 */
export {
  type ApprovalResolution,
  ApprovalResolutionSchema,
  approvalResolutionPath,
  approvalsChannelDir,
  deleteApprovalResolution,
  readApprovalResolution,
  resolutionToOutcome,
  writeApprovalResolution,
} from "@qmilab/lodestar-guard"
