import type { PolicyGate, PreconditionChecker } from "@qmilab/lodestar-action-kernel"
import type { EvidenceLinkerLike, IngestResult } from "@qmilab/lodestar-cognitive-core"
import type {
  Action,
  ActionContract,
  Observation,
  ResourceScope,
  Sensitivity,
} from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"

/**
 * Configuration for a guarded session.
 *
 * No silent defaults are allowed for security-relevant settings:
 * the caller must explicitly supply `project_id`, `actor_id`, and the
 * `default_sensitivity` / `default_scope` it wants observations to inherit.
 *
 * `log_root` defaults to `.lodestar/events` under the current working
 * directory. Override it to write the log somewhere else, but the
 * convention exists so `lodestar report` can find logs without flags.
 *
 * `policy_gate` and `precondition_checker` are required. Guard
 * deliberately does not provide auto-approve defaults — the trust
 * layer must not silently approve actions on behalf of the caller.
 */
export interface GuardConfig {
  project_id: string
  actor_id: string
  default_scope: ResourceScope
  default_sensitivity: Sensitivity

  /** Override the session_id; defaults to `session-${Date.now()}`. */
  session_id?: string

  /** Where event NDJSON files are written. Defaults to `<cwd>/.lodestar/events`. */
  log_root?: string

  policy_gate: PolicyGate
  precondition_checker: PreconditionChecker

  /**
   * Inject the firewall's belief/claim/evidence stores instead of the
   * fresh in-memory ones this session would otherwise build. Pass the
   * three Postgres-backed stores (from
   * `@qmilab/lodestar-memory-firewall/postgres`) to give a guarded run
   * durable state that other sessions — guarded or proxied — can see.
   *
   * Stores are caller-owned: `runGuarded` never opens or closes their
   * connection. The same handles are returned on `GuardRunResult.internals`
   * so a probe or embedder can inspect what was persisted. Omit for the
   * single-session in-memory default.
   */
  stores?: {
    claims: ClaimStore
    beliefs: BeliefStore
    evidence: EvidenceStore
  }

  /**
   * Override how the Cognitive Core is composed for this session. The one
   * seam exposed in v0 is `evidenceLinkerFactory`: called once with the
   * session's evidence/belief stores, it must return an
   * {@link EvidenceLinkerLike}. Use it to plug in a document-aware,
   * MCP-aware, or LLM-driven linker without forking `wrap`. When omitted,
   * the built-in `EvidenceLinker` is used.
   *
   * This is the seam the documentation-agent example uses to attach
   * `DocAwareEvidenceLinker`, which tags file-content claims as
   * `external_document` (so the Round 5 gate keeps them `unverified`) and
   * records each claim's source file. The object is intentionally a
   * nested bag so future cognitive-core overrides can be added without
   * widening `GuardConfig` again.
   */
  cognitive?: {
    evidenceLinkerFactory?: (deps: {
      evidence: EvidenceStore
      beliefs: BeliefStore
    }) => EvidenceLinkerLike
  }
}

/**
 * The guarded context handed to an agent loop. Calls on this object
 * are routed through the Action Kernel + Memory Firewall + Cognitive
 * Core, and every step is recorded in the event log.
 */
export interface GuardContext {
  readonly project_id: string
  readonly session_id: string
  readonly actor_id: string
  readonly default_scope: ResourceScope
  readonly default_sensitivity: Sensitivity

  /**
   * Propose, arbitrate, and execute a tool call. Returns the result of
   * the tool's `execute` function on success, or throws an error if the
   * action was rejected at any phase.
   *
   * The kernel validates inputs and outputs against the tool's schemas;
   * a successful return means the result has been routed through the
   * cognitive core (claims extracted, evidence linked, beliefs
   * proposed) before this promise resolves.
   */
  callTool<TOut = unknown>(
    toolName: string,
    inputs: unknown,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TOut>>

  /**
   * Inject a synthetic observation that did not come from the Action
   * Kernel (e.g. a webhook payload). The observation still goes through
   * the Cognitive Core and the Memory Firewall. The trust layer cannot
   * vouch for the upstream source — the caller assumes responsibility
   * for the observation's `trust` field.
   */
  ingestObservation(observation: Observation): Promise<IngestResult>

  /**
   * Emit an arbitrary event to the log. Use for chain primitives the
   * action kernel doesn't generate directly — e.g. `claim.extracted`
   * events whose payload embeds the full Claim. Keeps reports rich.
   */
  emit(type: string, payload: unknown): Promise<void>
}

export interface CallToolOptions {
  /** Human-readable intent. Defaults to `invoke ${toolName}`. */
  intent?: string
  /**
   * Overrides for the action contract. Defaults are derived from the
   * tool's registered metadata (`required_trust_level`, `reversibility`).
   */
  contract?: Partial<ActionContract>
  /** Override the decision_id this action is bound to. Optional. */
  decision_id?: string
}

export interface CallToolResult<TOut = unknown> {
  /** The validated tool output. */
  output: TOut
  /** The completed Action record (phase = `completed`). */
  action: Action
  /** The observation the kernel generated, after schema validation. */
  observation: Observation
  /** The result of routing that observation through the cognitive core. */
  ingest: IngestResult
}

/**
 * A function that drives an agent loop using the guarded context.
 * Returned values flow back to the caller of `wrap(loop)(config)`.
 */
export type AgentLoop<T> = (ctx: GuardContext) => Promise<T>

/**
 * Internal handles for tests and probes. Not part of the user-facing
 * API; surfaced via `guard.runGuarded` and the `__internals` field on
 * `GuardSession` for the example to introspect what was recorded.
 */
export interface GuardInternals {
  readonly firewall: import("@qmilab/lodestar-memory-firewall").MemoryFirewall
  // The store interfaces, not the in-memory classes: a guarded run can be
  // pointed at injected (e.g. Postgres-backed) stores via `GuardConfig.stores`.
  readonly claims: ClaimStore
  readonly beliefs: BeliefStore
  readonly evidence: EvidenceStore
  readonly cognitive: import("@qmilab/lodestar-cognitive-core").CognitiveCore
  readonly worldModel: import("@qmilab/lodestar-cognitive-core").InMemoryWorldModel
  readonly kernel: import("@qmilab/lodestar-action-kernel").ActionKernel
}
