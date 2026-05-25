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
 *  2. Policy presets — minimal `autoApprovePolicy` and `alwaysHoldsChecker`
 *     to get an example running. Anything beyond that lives in the
 *     forthcoming `@qmilab/lodestar-policy-kernel`.
 *
 * Everything else is re-exported so a consumer can `import { ... }
 * from "@qmilab/lodestar-guard"` without picking each underlying package.
 */

// ── Helpers and types defined here ──────────────────────────────────────────
export { wrap, runGuarded } from "./wrap.js"
export type { GuardRunResult } from "./wrap.js"
export type {
  AgentLoop,
  CallToolOptions,
  CallToolResult,
  GuardConfig,
  GuardContext,
  GuardInternals,
} from "./types.js"
export { autoApprovePolicy, alwaysHoldsChecker } from "./policy-presets.js"

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
} from "@qmilab/lodestar-cognitive-core"

// Core types (the ones an agent loop typically touches)
export type {
  Action,
  ActionContract,
  ActionPrecondition,
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
