import type {
  ApprovalOutcome,
  PolicyGate,
  PreconditionChecker,
} from "@qmilab/lodestar-action-kernel"
import type { EvidenceLinkerLike, IngestResult } from "@qmilab/lodestar-cognitive-core"
import type {
  Action,
  ActionContract,
  ApprovalRequest,
  Decision,
  Observation,
  ResourceScope,
  Sensitivity,
} from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"
import type { CompiledPolicy } from "@qmilab/lodestar-policy-kernel"
import type { SentinelArbiter } from "./sentinel-arbiter.js"

/**
 * Resolves a held action's `ApprovalRequest` into an `ApprovalOutcome`.
 *
 * The in-process counterpart of the MCP proxy's out-of-band hold loop: because
 * a `guard.wrap()` agent loop is suspendable JS, a hold can simply *await* this
 * resolver. The resolver is where a human (via an approval UI), an auto-rule, or
 * a test stub answers — it is the seam, not the policy.
 *
 * The resolver is responsible for *authorisation*: it should match an approver's
 * `Actor` against `request.required_authority` (the `authorizeResolution` helper
 * from `@qmilab/lodestar-policy-kernel` does exactly this) and return a bound
 * outcome. The outcome's `action_id` / `request_id` MUST come from the request —
 * `ActionKernel.resolve()` refuses to apply an outcome bound to a different
 * action, so a stray grant cannot un-park the wrong held action.
 *
 * Security-relevant: a `GuardConfig` whose policy can hold MUST supply a
 * resolver. There is no silent default — `callTool` throws (rather than
 * silently approving or denying) if an action is held and no resolver is set.
 * It is optional on the type only because guard cannot statically introspect an
 * opaque `PolicyGate` to know whether it ever holds; the runtime check is the
 * load-bearing guard.
 */
export type ApprovalResolver = (request: ApprovalRequest) => Promise<ApprovalOutcome>

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
 *
 * `policy_gate` may be either a bare {@link PolicyGate} function or a
 * {@link CompiledPolicy} (from `@qmilab/lodestar-policy-kernel`). When a
 * `CompiledPolicy` is supplied, guard re-runs its pure `evaluate()` after a
 * hold to recover the matched rule's `required_authority` for the opened
 * `ApprovalRequest`; a bare gate falls back to "any configured resolver".
 *
 * If the policy can produce a *hold* (the three-valued gate's third outcome —
 * e.g. the trust-ladder floor on an L4 action), `approval_resolver` MUST be
 * supplied; a held action with no resolver throws rather than silently
 * resolving (no silent default for a security-relevant path).
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

  policy_gate: PolicyGate | CompiledPolicy
  precondition_checker: PreconditionChecker

  /**
   * Resolves an action the policy held for approval (`pending_approval`). See
   * {@link ApprovalResolver}. Required whenever `policy_gate` can hold; omit it
   * only for a policy that provably never holds (e.g. an allow/deny-only gate).
   * A hold with no resolver is a hard error at `callTool` time, not a silent
   * approval or denial.
   */
  approval_resolver?: ApprovalResolver

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
      claims: ClaimStore
    }) => EvidenceLinkerLike
  }

  /**
   * Wire sentinel→action arbitration into this session. When supplied, the host
   * feeds every emitted event to the arbiter (which runs the sentinels and
   * projects the chain), emits the `sentinel.alerted@1` events the arbiter
   * surfaces, and — because the arbiter's `resolveContext` is compiled into
   * `policy_gate` — lets a landed alert (or calibration flag, or low-confidence
   * belief) escalate a *dependent* action to `pending_approval`.
   *
   * The arbiter and `policy_gate` MUST be the matched pair from
   * `compileWithSentinels(policy, { sentinels, … })` — or hand-wired, with the
   * gate compiled from `arbitration.resolveContext = a => arbiter.resolveContext(a)`.
   * Passing an arbiter whose `resolveContext` is not compiled into the gate
   * observes the stream but gates nothing (the alerts are still logged). Because
   * arbitration can produce a *hold*, `approval_resolver` is required alongside it.
   */
  arbiter?: SentinelArbiter
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
   *
   * Security note: events emitted here are **not** trusted to drive sentinel
   * arbitration — a raw agent emit cannot reset or mutate the arbiter's
   * enforcement state (a forged `guard.session.ended` or `belief.adopted` is
   * inert to the gate). To declare the beliefs an action depends on — the input a
   * belief-scoped sentinel alert is gated against — use {@link recordDecision},
   * the trusted channel.
   */
  emit(type: string, payload: unknown): Promise<void>

  /**
   * Record a {@link import("@qmilab/lodestar-core").Decision} the agent made:
   * validates it and emits a host-authored `decision.made`. This is the trusted
   * path that feeds the `SentinelArbiter` — its `belief_dependencies` are how a
   * belief-scoped sentinel alert (or the low-confidence signal) finds the action
   * that leans on a flagged belief. Without a recorded decision, an action is
   * gated only by subject-agnostic signals. No-op on enforcement when no
   * `arbiter` is configured (the event is still logged for the chain).
   */
  recordDecision(decision: Decision): Promise<void>
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
