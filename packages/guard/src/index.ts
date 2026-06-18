/**
 * @qmilab/lodestar-guard — the write-side meta-package.
 *
 * Bundles the action-kernel, memory-firewall, cognitive-core, and
 * event-log surfaces a developer needs to govern an agent loop, plus
 * the `wrap()` / `runGuarded()` helpers that wire them up.
 *
 * The package itself adds two things on top of the lower-level packages:
 *
 *  1. `wrap(loop)` — accepts a user-supplied agent loop function and
 *     returns a wrapped version that, when called with a {@link GuardConfig},
 *     runs the loop with a guarded context: every tool call goes through
 *     the Action Kernel and every observation through the Cognitive Core.
 *  2. The Policy Kernel surface — `autoApprovePolicy` (the graduated ceiling
 *     preset), `compile`, and the approval-lifecycle helpers — re-exported from
 *     `@qmilab/lodestar-policy-kernel`, plus the local `alwaysHoldsChecker`
 *     precondition stub, so an example or host can wire a guarded session from
 *     this one package.
 *
 * Everything else is re-exported so a consumer can `import { ... }
 * from "@qmilab/lodestar-guard"` without picking each underlying package.
 */

// ── Helpers and types defined here ──────────────────────────────────────────
export { wrap, runGuarded } from "./wrap.js"
export type { GuardRunResult } from "./wrap.js"

// ── Signed approval side-channel (ADR-0010 / ADR-0015) ───────────────────────
// The cross-process transport for a signed approval resolution, graduated here
// from `@qmilab/lodestar-guard-mcp` once a second consumer appeared
// (`@qmilab/lodestar-runtime-core`, ADR-0024 / ADR-0025). It lives next to the
// Ed25519 sign/verify primitives it pairs with (`signApprovalResolution` /
// `verifyApprovalSignature`, re-exported below), so a security-critical
// signed-format reader has exactly one implementation. guard-mcp re-exports
// these names unchanged.
export {
  type ApprovalResolution,
  ApprovalResolutionSchema,
  approvalResolutionPath,
  approvalsChannelDir,
  deleteApprovalResolution,
  readApprovalResolution,
  resolutionToOutcome,
  writeApprovalResolution,
} from "./approvals-channel.js"
export type {
  AgentLoop,
  ApprovalResolver,
  CallToolOptions,
  CallToolResult,
  GuardConfig,
  GuardContext,
  GuardInternals,
} from "./types.js"
export { alwaysHoldsChecker } from "./policy-presets.js"

// ── Sentinel→action arbitration bridge ───────────────────────────────────────
// The host-side glue that gives sentinel alerts teeth: it runs the sentinels over
// the guarded session's event stream and projects their landed alerts (plus the
// action's backing beliefs and an optional calibration snapshot) into the Policy
// Kernel's arbitrate hook. `compileWithSentinels` is the one-call form that wires
// the arbiter's `resolveContext` into the compiled gate. See
// `.claude/adr/0001-sentinel-action-arbitration-bridge.md`.
export { SentinelArbiter, compileWithSentinels } from "./sentinel-arbiter.js"
export type {
  SentinelArbiterOptions,
  CompileWithSentinelsOptions,
} from "./sentinel-arbiter.js"

// ── Policy Kernel surface (graduated preset + approval lifecycle) ────────────
// `autoApprovePolicy` graduated here from guard's own preset: it now honours the
// trust-ladder floor (L4 always holds, L5 denies) and its ceiling caps at L3.
// Re-exported so a host can author/compile a policy and wire the in-process
// approval seam without importing `@qmilab/lodestar-policy-kernel` directly.
export {
  autoApprovePolicy,
  autoApprovePolicyCompiled,
  autoApprovePolicyDocument,
  compile,
  decisionOf,
  verifyPolicySignature,
  openApprovalRequest,
  authorizeResolution,
  expireRequest,
  holdEvaluationForParkedAction,
  canonicalPolicyHash,
  PolicyCompileError,
  // Signed approval resolutions (P3): real Ed25519 over the canonical resolution,
  // so a host (the MCP proxy promotion path, the `lodestar approve` CLI signer)
  // can verify a cross-process approval without importing policy-kernel directly.
  canonicalApprovalResolutionDocument,
  canonicalApprovalResolutionHash,
  signApprovalResolution,
  verifyApprovalSignature,
  generateApproverKeyPair,
  assertValidApproverKeys,
  ApprovalSignatureError,
} from "@qmilab/lodestar-policy-kernel"
export type {
  AutoApproveInput,
  CompiledPolicy,
  CompileOptions,
  PolicyEvaluation,
  PolicyVerdict,
  AuthorizationResult,
  OpenApprovalRequestOptions,
  ApprovalResolutionDoc,
  AuthorizedApproverKeys,
  VerifyApprovalSignatureOptions,
} from "@qmilab/lodestar-policy-kernel"

// ── Re-exports from the underlying packages ─────────────────────────────────

// Event log surface
export { EventLogWriter, EventLogReader, canonicalHash } from "@qmilab/lodestar-event-log"

// Action kernel surface
export {
  ActionKernel,
  registerTool,
  lookupTool,
  listTools,
} from "@qmilab/lodestar-action-kernel"
export type {
  PolicyGate,
  PolicyDecision,
  ApprovalOutcome,
  PreconditionChecker,
  Tool,
  SandboxProfile,
  Permission,
  Effect,
  ToolContext,
} from "@qmilab/lodestar-action-kernel"

// Memory firewall surface
export {
  MemoryFirewall,
  GatedRetrieval,
  InMemoryClaimStore,
  InMemoryBeliefStore,
  InMemoryEvidenceStore,
  aggregateStrength,
  isTransitionAllowed,
} from "@qmilab/lodestar-memory-firewall"
export type {
  FirewallAuditEvent,
  ClaimStore,
  BeliefStore,
  EvidenceStore,
  LifecycleAxis,
  TransitionAuthority,
  Transition,
  RetrievalQuery,
  RetrievalResult,
} from "@qmilab/lodestar-memory-firewall"

// Cognitive core surface
export {
  CognitiveCore,
  EvidenceLinker,
  DocAwareEvidenceLinker,
  DocumentationExtractor,
  DOCUMENTATION_SOURCE_SCHEMA_KEY,
  ExplanationGenerator,
  InMemoryWorldModel,
  registerBuiltInExtractors,
  registerExtractor,
  lookupExtractor,
} from "@qmilab/lodestar-cognitive-core"
export type {
  IngestInput,
  IngestResult,
  WorldModel,
  WorldModelEntry,
  ClaimExtractor,
  ExtractionInput,
  EvidenceLinkerLike,
  LinkForClaimInput,
  DocumentationSourcePayload,
} from "@qmilab/lodestar-cognitive-core"

// Core types (the ones an agent loop typically touches)
export type {
  Action,
  ActionContract,
  ActionPrecondition,
  Actor,
  ApprovalRequest,
  Policy,
  PolicyRule,
  RequiredAuthority,
  Belief,
  Claim,
  EvidenceSet,
  EvidenceItem,
  Observation,
  ResourceScope,
  Sensitivity,
  TruthStatus,
  RetrievalStatus,
  SecurityStatus,
  FreshnessStatus,
  BeliefAuthority,
} from "@qmilab/lodestar-core"
