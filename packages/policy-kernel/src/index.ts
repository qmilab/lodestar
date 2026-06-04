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
  type AuthorizationResult,
  type OpenApprovalRequestOptions,
} from "./approval.js"

export {
  autoApprovePolicy,
  autoApprovePolicyCompiled,
  autoApprovePolicyDocument,
  type AutoApproveInput,
} from "./presets.js"

export { canonicalPolicyDocument, canonicalPolicyHash } from "./hash.js"
