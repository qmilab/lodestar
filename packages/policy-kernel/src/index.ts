/**
 * @qmilab/lodestar-policy-kernel
 *
 * The Policy Kernel. Compiles a declarative, signable `Policy` document
 * (`@qmilab/lodestar-core`) into the Action Kernel's `PolicyGate`, gives the
 * gate a third outcome — `hold` — and owns the approval-request lifecycle.
 *
 * Design lock: docs/architecture/policy-kernel.md
 */

export {
  compile,
  decisionOf,
  verifyPolicySignature,
  PolicyCompileError,
  type CompiledPolicy,
  type CompileOptions,
  type PolicyEvaluation,
  type PolicyVerdict,
  // The arbitrate hook (slice 2): the host-injected snapshot + escalation config
  // that give sentinel alerts and calibration flags teeth.
  type ArbitrationConfig,
  type ArbitrationContext,
  type ArbitrationSignalRecord,
  type BackingBelief,
  type CalibrationSnapshot,
  type EscalationConfig,
  type EscalationEffect,
} from "./gate.js"

export {
  openApprovalRequest,
  authorizeResolution,
  expireRequest,
  holdEvaluationForParkedAction,
  type ApproverAuthority,
  type AuthorizationResult,
  type OpenApprovalRequestOptions,
} from "./approval.js"

// M-of-N quorum adjudication (ADR-0041). Pure — no I/O, no clock, no key access
// of its own — so a read-side consumer can re-adjudicate a logged quorum against
// its own pinned roster without importing the write-side runtime.
export {
  evaluateQuorum,
  type EvaluateQuorumOptions,
  type QuorumEvaluation,
  type QuorumRejectionCode,
  type QuorumVeto,
  type QuorumVote,
  type RejectedQuorumVote,
} from "./quorum.js"

export {
  autoApprovePolicy,
  autoApprovePolicyCompiled,
  autoApprovePolicyDocument,
  type AutoApproveInput,
} from "./presets.js"

export { canonicalPolicyDocument, canonicalPolicyHash } from "./hash.js"

export {
  canonicalApprovalResolutionDocument,
  canonicalApprovalResolutionHash,
  signApprovalResolution,
  verifyApprovalSignature,
  generateApproverKeyPair,
  assertValidApproverKeys,
  ApprovalSignatureError,
  type ApprovalResolutionDoc,
  type AuthorizedApproverKeys,
  type VerifyApprovalSignatureOptions,
} from "./approval-signature.js"
