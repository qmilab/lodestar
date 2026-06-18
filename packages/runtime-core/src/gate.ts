import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import {
  ActionKernel,
  type ApprovalOutcome,
  type PolicyGate,
  type PreconditionChecker,
  type Tool,
  registerTool,
  unregisterTool,
} from "@qmilab/lodestar-action-kernel"
import {
  CognitiveCore,
  ExplanationGenerator,
  InMemoryWorldModel,
  type IngestResult,
} from "@qmilab/lodestar-cognitive-core"
import {
  ApprovalDeniedPayloadSchema,
  ApprovalGrantedPayloadSchema,
  SENTINEL_ALERTED_EVENT_TYPE,
  SENTINEL_ALERTED_SCHEMA_VERSION,
} from "@qmilab/lodestar-core"
import type {
  Action,
  ActionContract,
  ApprovalGrantedPayload,
  ApprovalRequest,
  Decision,
  EventEnvelope,
  Observation,
  Sensitivity,
  Signature,
} from "@qmilab/lodestar-core"
import { EventLogReader, EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  type ApprovalResolution,
  type ApprovalResolutionDoc,
  ApprovalSignatureError,
  type CompiledPolicy,
  type PolicyEvaluation,
  type SentinelArbiter,
  alwaysHoldsChecker,
  assertValidApproverKeys,
  autoApprovePolicyCompiled,
  deleteApprovalResolution,
  holdEvaluationForParkedAction,
  openApprovalRequest,
  readApprovalResolution,
  verifyApprovalSignature,
} from "@qmilab/lodestar-guard"
import {
  type BeliefStore,
  type ClaimStore,
  type EvidenceStore,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { z } from "zod"
import {
  CONSERVATIVE_TOOL_DEFAULTS,
  type RuntimeGateConfig,
  hasUnauthenticatedApprovalGap,
} from "./config.js"
import type { RpcChannel } from "./connection.js"
import {
  RUNTIME_TOOL_RESULT_SCHEMA_KEY,
  RuntimeAwareEvidenceLinker,
  type RuntimeToolResultObservationPayload,
  registerRuntimeExtractors,
} from "./observation.js"
import type { GovernResultMessage, InboundMessage, OutboundMessage } from "./protocol.js"
import { InboundMessageSchema } from "./protocol.js"

/**
 * The `made_by` (and emitted envelope `actor_id`) of a decision the gate
 * **synthesizes** from the arbiter's observed-belief set — the opaque-runtime
 * decision source (ADR-0003). A wrapped runtime hook forwards tool calls only and
 * cannot declare its `belief_dependencies`, so the gate infers the link. Never the
 * agent, so the audit shows it as the gate's inference. Mirrors the MCP proxy's
 * `PROXY_DECISION_SYNTHESIS_ACTOR`.
 */
export const RUNTIME_DECISION_SYNTHESIS_ACTOR = "lodestar-runtime-synthesis"

/** How often a `resume(wait_ms)` re-reads the log/side-channel while block-polling. */
const RESOLUTION_POLL_INTERVAL_MS = 50

/** Optional dependency injection — the CLI supplies the compiled gate, arbiter,
 *  and Postgres stores; probes substitute fakes. */
export interface RuntimeGateOverrides {
  /** The gate's `PolicyGate`. A `CompiledPolicy` enables richer hold authority +
   *  arbitration; a bare function is the minimal form. Default: the
   *  `auto_approve_ceiling` preset compiled. */
  policyGate?: PolicyGate | CompiledPolicy
  /** Wire the sentinel→action arbitrate bridge (must be the matched pair of a
   *  `compileWithSentinels` gate; ADR-0001 / ADR-0003). */
  arbiter?: SentinelArbiter
  /** Injected, caller-owned firewall stores (e.g. Postgres for cross-session). */
  stores?: { claims: ClaimStore; beliefs: BeliefStore; evidence: EvidenceStore }
  /** Override the precondition checker. Default: `alwaysHoldsChecker`. */
  preconditionChecker?: PreconditionChecker
}

interface Capture {
  observation: Observation
  ingest: IngestResult
}

/**
 * The governance-gate sidecar (ADR-0024). Reuses the SAME engine the MCP proxy
 * runs — `ActionKernel` two-phase, the `CompiledPolicy` gate, `CognitiveCore`
 * ingestion, `SentinelArbiter` decision synthesis, the signed-approval hold path
 * — and exposes it to a non-MCP runtime hook over a thin NDJSON-RPC channel.
 *
 * The only genuinely new logic here (vs. the proxy) is the RPC dispatch, the
 * re-entrant remoted execute (the tool body runs back in the hook, only inside
 * the TS execute phase), and the durable/idempotent hold reconstruction that
 * survives a sidecar restart and a duplicate resume.
 */
export class RuntimeGate {
  private readonly config: RuntimeGateConfig
  private readonly sessionId: string
  private readonly logRoot: string

  private readonly policyGate: PolicyGate
  private readonly compiledPolicy?: CompiledPolicy
  private readonly preconditionChecker: PreconditionChecker
  private readonly arbiter?: SentinelArbiter
  private readonly injectedStores?: RuntimeGateOverrides["stores"]

  private writer?: EventLogWriter
  private firewall?: MemoryFirewall
  private evidenceStore?: EvidenceStore
  private cognitive?: CognitiveCore
  private kernel?: ActionKernel

  private channel?: RpcChannel
  private started = false
  private stopping = false

  /** Maps a hook's tool name → the registry-namespaced name the kernel knows it
   *  by (`runtime.<sanitized>`, like the proxy's `mcp.<server>.<tool>`). The
   *  action-kernel registry requires `namespace.action` names, but a native
   *  runtime tool ("search_web") has none. Used for govern lookup, clean
   *  deregistration, and idempotent re-register; a fresh instance after a restart
   *  re-registers the same mapping deterministically. */
  private readonly ownedTools = new Map<string, string>()
  /** Parked actions held in this process (fast path; the durable log is the
   *  fallback a fresh instance reconstructs from). */
  private readonly pendingActions = new Map<string, Action>()
  /** Observation + ingest result keyed by action id, set by the observation sink. */
  private readonly captures = new Map<string, Capture>()
  /** In-flight remoted tool runs keyed by the gate-assigned correlation id. */
  private readonly pendingToolRuns = new Map<
    number,
    {
      resolve: (out: { output: unknown; documents: { text: string; source?: string }[] }) => void
      reject: (err: Error) => void
    }
  >()
  private runToolCounter = 0
  /** Threads the action id into `tool.execute` (the kernel does not pass it). */
  private readonly als = new AsyncLocalStorage<{ actionId: string }>()
  /** Dedup for signature-rejected diagnostics, so a persistent bad file/event is
   *  logged once across polls. */
  private readonly warnedSignatureRejections = new Set<string>()

  constructor(config: RuntimeGateConfig, overrides?: RuntimeGateOverrides) {
    this.config = config
    this.sessionId = config.session_id === "auto" ? randomUUID() : config.session_id
    this.logRoot = config.log_root

    const gateOverride = overrides?.policyGate
    if (gateOverride === undefined) {
      this.compiledPolicy = autoApprovePolicyCompiled({
        auto_approve_up_to: config.auto_approve_ceiling as 0 | 1 | 2 | 3,
        approver_id: `policy:auto-approve-up-to-${config.auto_approve_ceiling}`,
      })
      this.policyGate = this.compiledPolicy.gate
    } else if (typeof gateOverride === "function") {
      this.policyGate = gateOverride
    } else {
      this.compiledPolicy = gateOverride
      this.policyGate = gateOverride.gate
    }
    const compiledPolicyInjected = gateOverride !== undefined && typeof gateOverride !== "function"
    // A declared `policy` with no injected CompiledPolicy would silently fall back
    // to the ceiling preset — a silent default for a security-relevant setting.
    if (config.policy !== undefined && !compiledPolicyInjected) {
      throw new Error(
        "RuntimeGate: config.policy is set but no compiled policy was injected. Compile it " +
          "(compileRuntimePolicy from @qmilab/lodestar-runtime-core) and pass the result via " +
          "RuntimeGateOverrides.policyGate. The `lodestar runtime gate` CLI does this for you.",
      )
    }
    this.preconditionChecker = overrides?.preconditionChecker ?? alwaysHoldsChecker
    if (overrides?.stores !== undefined) this.injectedStores = overrides.stores
    if (overrides?.arbiter !== undefined) this.arbiter = overrides.arbiter

    if (config.persistence?.backend === "postgres" && this.injectedStores === undefined) {
      throw new Error(
        "RuntimeGate: config.persistence.backend is 'postgres' but no stores were injected. " +
          "Construct the Postgres stores and pass them via RuntimeGateOverrides.stores.",
      )
    }
    // Signed approvals: when the gate can resolve a hold out-of-band, the
    // resolution's approver_id is unauthenticated — require a pinned key or an
    // explicit allow_unsigned (same predicate as the schema superRefine).
    if (hasUnauthenticatedApprovalGap(config)) {
      throw new Error(
        "RuntimeGate: approval_timeout_ms > 0 lets the gate promote an out-of-band approval " +
          "whose approver_id is unauthenticated. Pin at least one approvals.authorized_keys " +
          "entry so resolutions are Ed25519-verified, or set approvals.allow_unsigned: true.",
      )
    }
    assertValidApproverKeys(config.approvals?.authorized_keys ?? [])

    // Sentinel enforcement needs BOTH an arbiter to run them AND a CompiledPolicy
    // gate whose arbitrate hook consults it — the same four guards the proxy uses.
    if ((config.sentinels?.length ?? 0) > 0 && this.arbiter === undefined) {
      throw new Error(
        "RuntimeGate: config.sentinels is set but no arbiter was injected. Resolve the ids " +
          "against FIRST_PARTY_SENTINELS and inject a SentinelArbiter via " +
          "RuntimeGateOverrides.arbiter, with policyGate compiled from the same arbiter " +
          "(compileRuntimePolicyWithSentinels / compileWithSentinels).",
      )
    }
    if (this.arbiter !== undefined && !compiledPolicyInjected) {
      throw new Error(
        "RuntimeGate: an arbiter was injected but no CompiledPolicy gate was — the default " +
          "preset and a bare PolicyGate have no arbitrate hook, so the arbiter's alerts could " +
          "never hold an action. Inject a policyGate compiled from the SAME arbiter.",
      )
    }
    if (
      this.arbiter !== undefined &&
      this.compiledPolicy !== undefined &&
      this.compiledPolicy.bindingToken !== this.arbiter.bindingToken
    ) {
      throw new Error(
        "RuntimeGate: the injected CompiledPolicy gate was not compiled from the injected " +
          "arbiter (bindingToken mismatch). Compile them together " +
          "(compileRuntimePolicyWithSentinels / compileWithSentinels).",
      )
    }
    if (this.arbiter === undefined && this.compiledPolicy?.bindingToken !== undefined) {
      throw new Error(
        "RuntimeGate: a sentinel-compiled CompiledPolicy gate (bindingToken set) was injected " +
          "but no arbiter — the sentinels it was compiled with would be inert. Inject the " +
          "matching arbiter via RuntimeGateOverrides.arbiter.",
      )
    }
  }

  get session_id(): string {
    return this.sessionId
  }

  get log_root(): string {
    return this.logRoot
  }

  /**
   * Build the firewall/cognitive/kernel stack and register the extractors. One
   * per gate instance; idempotent so a probe can call it once before serving.
   */
  async init(): Promise<void> {
    if (this.kernel !== undefined) return
    registerRuntimeExtractors()
    this.writer = new EventLogWriter(this.logRoot)

    const claims = this.injectedStores?.claims ?? new InMemoryClaimStore()
    const beliefs = this.injectedStores?.beliefs ?? new InMemoryBeliefStore()
    const evidence = this.injectedStores?.evidence ?? new InMemoryEvidenceStore()
    this.evidenceStore = evidence
    const worldModel = new InMemoryWorldModel()
    this.firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
      const causal_parent_ids =
        "causal_parent_ids" in event && event.causal_parent_ids
          ? event.causal_parent_ids
          : undefined
      await this.emit(
        `firewall.${event.kind}`,
        event,
        causal_parent_ids ? { causal_parent_ids } : undefined,
      )
    })
    const linker = new RuntimeAwareEvidenceLinker(evidence, beliefs)
    const explanations = new ExplanationGenerator(this.config.actor_id)
    this.cognitive = new CognitiveCore(this.firewall, linker, explanations, worldModel)
    this.kernel = new ActionKernel(
      this.policyGate,
      this.preconditionChecker,
      (obs) => this.observationSink(obs),
      { session_id: this.sessionId, project_id: this.config.project_id },
    )
  }

  /**
   * Wire a transport and serve until it closes. The hook drives `register_tool`
   * → `govern` / `resume`, and the gate calls back with `run_tool`. Returns a
   * promise that resolves when the channel closes (the hook disconnected).
   */
  async serve(channel: RpcChannel): Promise<void> {
    if (this.kernel === undefined) await this.init()
    if (this.started) throw new Error("RuntimeGate: already serving")
    this.started = true
    this.channel = channel
    return await new Promise<void>((resolve) => {
      channel.onMessage((raw) => void this.dispatch(raw))
      channel.onClose(() => resolve())
      this.send({
        type: "ready",
        session_id: this.sessionId,
        project_id: this.config.project_id,
        log_root: this.logRoot,
      })
    })
  }

  /** Tear down: signal in-flight waits, emit session-ended, deregister tools. */
  async stop(): Promise<void> {
    if (!this.started && this.ownedTools.size === 0) return
    this.stopping = true
    try {
      await this.emit("guard.session.ended", { ended_at: new Date().toISOString() })
    } catch {
      // best-effort
    }
    for (const internal of this.ownedTools.values()) {
      try {
        unregisterTool(internal)
      } catch {
        // best-effort — a name may already be gone
      }
    }
    this.ownedTools.clear()
    this.started = false
  }

  // ── RPC dispatch ───────────────────────────────────────────────────────────

  private send(msg: OutboundMessage): void {
    this.channel?.send(msg)
  }

  private async dispatch(raw: unknown): Promise<void> {
    const parsed = InboundMessageSchema.safeParse(raw)
    if (!parsed.success) {
      const id =
        typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : undefined
      this.send({ type: "error", id, message: `invalid message: ${parsed.error.message}` })
      return
    }
    const msg: InboundMessage = parsed.data
    switch (msg.type) {
      case "register_tool":
        await this.handleRegisterTool(msg)
        break
      case "govern":
        await this.handleGovern(msg)
        break
      case "resume":
        await this.handleResume(msg)
        break
      case "tool_result":
        this.handleToolResult(msg)
        break
      case "tool_error":
        this.handleToolError(msg)
        break
      case "shutdown":
        await this.stop()
        this.channel?.close()
        break
    }
  }

  private async handleRegisterTool(msg: { id: number; name: string }): Promise<void> {
    if (this.ownedTools.has(msg.name)) {
      // Idempotent: this instance already owns it.
      this.send({
        type: "registered",
        id: msg.id,
        name: msg.name,
        required_level: this.contractFor(msg.name).required_level,
      })
      return
    }
    const internal = internalToolName(msg.name)
    // Two distinct hook names that sanitise to the same registry name would
    // collide and ambiguate the audit — reject rather than silently merge.
    for (const existing of this.ownedTools.values()) {
      if (existing === internal) {
        this.send({
          type: "error",
          id: msg.id,
          message: `tool '${msg.name}' maps to the already-registered namespaced name '${internal}'`,
        })
        return
      }
    }
    const tool = this.buildRemotingTool(msg.name, internal)
    try {
      registerTool(tool)
    } catch (err) {
      this.send({
        type: "error",
        id: msg.id,
        message: `cannot register tool '${msg.name}' (as '${internal}'): ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    this.ownedTools.set(msg.name, internal)
    this.send({
      type: "registered",
      id: msg.id,
      name: msg.name,
      required_level: tool.required_trust_level,
    })
  }

  private async handleGovern(msg: {
    id: number
    tool: string
    args: Record<string, unknown>
  }): Promise<void> {
    const kernel = this.requireKernel()
    // Fail closed on the unrecognised: a call for a tool with no compiled
    // contract is denied, never allowed (ADR-0024 §3). No propose, no execute.
    if (!this.ownedTools.has(msg.tool)) {
      const actionId = randomUUID()
      await this.emit("runtime.call_refused", {
        kind: "unregistered_tool",
        tool: msg.tool,
        args: msg.args,
        refused_at: new Date().toISOString(),
      })
      this.send({
        type: "govern_result",
        id: msg.id,
        phase: "rejected",
        action_id: actionId,
        reason: `tool '${msg.tool}' is not governed by this gate (unregistered) — fail closed`,
        kind: "unregistered_tool",
      })
      return
    }

    const internal = this.ownedTools.get(msg.tool)
    if (internal === undefined) throw new Error("RuntimeGate: owned tool lost its namespaced name")
    const decisionId = await this.synthesizeDecision()
    const proposed = kernel.propose({
      decision_id: decisionId,
      intent: `forward runtime tool call ${msg.tool} via gate`,
      tool: internal,
      inputs: msg.args,
      contract: this.contractFor(msg.tool),
      proposed_by: this.config.actor_id,
    })
    await this.emit("action.proposed", proposed)
    const arbitrated = await kernel.arbitrate(proposed)

    if (arbitrated.phase === "pending_approval") {
      const held = await this.openHold(arbitrated)
      this.send({ ...held, id: msg.id })
      return
    }
    if (arbitrated.phase !== "approved") {
      await this.emit("action.rejected", arbitrated)
      this.send({
        type: "govern_result",
        id: msg.id,
        phase: "rejected",
        action_id: arbitrated.id,
        reason: arbitrated.approval?.reason ?? "policy gate rejected this action",
        kind: "policy_denied",
      })
      return
    }
    await this.emit("action.approved", arbitrated)
    const result = await this.executeAction(arbitrated)
    this.send({ ...result, id: msg.id })
  }

  /**
   * Open a hold: emit `action.pending_approval` + `approval.requested@1` (with a
   * deadline when out-of-band resolution is enabled), and return the held state.
   * When `approval_timeout_ms === 0`, the hold is a terminal soft denial (no
   * out-of-band resolution path). Otherwise it parks and the hook resolves it via
   * `resume` (the LangGraph `interrupt()` idiom).
   */
  private async openHold(parked: Action): Promise<Omit<GovernResultMessage, "id">> {
    await this.emit("action.pending_approval", parked)
    const timeoutMs = this.config.approval_timeout_ms ?? 0
    let evaluation: PolicyEvaluation = holdEvaluationForParkedAction(parked)
    if (this.compiledPolicy) {
      const reevaluated = this.compiledPolicy.evaluate(parked)
      if (reevaluated.verdict === "hold") evaluation = reevaluated
    }
    if (timeoutMs <= 0) {
      const request = openApprovalRequest(parked, evaluation, {})
      await this.emit("approval.requested", request)
      return {
        type: "govern_result",
        phase: "rejected",
        action_id: parked.id,
        request_id: request.request_id,
        reason: request.reason,
        kind: "approval_required",
      }
    }
    const deadline = new Date(Date.now() + timeoutMs).toISOString()
    const request = openApprovalRequest(parked, evaluation, { deadline })
    await this.emit("approval.requested", request)
    this.pendingActions.set(parked.id, parked)
    return {
      type: "govern_result",
      phase: "pending_approval",
      action_id: parked.id,
      request_id: request.request_id,
      deadline,
    }
  }

  private async handleResume(msg: {
    id: number
    action_id: string
    request_id: string
    wait_ms?: number
  }): Promise<void> {
    const kernel = this.requireKernel()

    // Exactly-once (§4/§5): a terminal event for this action in the durable log
    // means it already settled — return the recorded outcome, never re-execute.
    const terminal = await this.terminalOutcomeFromLog(msg.action_id)
    if (terminal !== undefined) {
      this.send({ ...terminal, id: msg.id })
      return
    }

    // Reconstruct the parked action — from memory (fast path) or the durable log
    // (a fresh instance after a restart). The deadline comes from the log's
    // approval.requested@1, never recomputed, so a restart cannot reset it.
    const parked =
      this.pendingActions.get(msg.action_id) ?? (await this.reconstructParkedAction(msg.action_id))
    if (parked === undefined) {
      this.send({
        type: "govern_result",
        id: msg.id,
        phase: "rejected",
        action_id: msg.action_id,
        reason: "no held action found for this id",
        kind: "unknown_action",
      })
      return
    }
    const recovered = await this.reconstructRequest(msg.action_id)
    const requestId = recovered?.request_id ?? msg.request_id
    const deadlineAt =
      recovered?.deadline !== undefined ? Date.parse(recovered.deadline) : undefined

    const waitMs = msg.wait_ms ?? 0
    const startedAt = Date.now()
    for (;;) {
      if (this.stopping) {
        this.send({
          type: "govern_result",
          id: msg.id,
          phase: "pending_approval",
          action_id: msg.action_id,
          request_id: requestId,
        })
        return
      }
      const resolution = await this.checkResolution(requestId, msg.action_id, deadlineAt)
      if (resolution !== undefined) {
        if (resolution.source === "channel") {
          await this.emitCanonicalResolution(resolution.outcome, resolution.signature)
          await deleteApprovalResolution(this.logRoot, this.config.project_id, requestId)
        }
        const resolved = kernel.resolve(parked, resolution.outcome)
        if (resolved.phase !== "approved") {
          await this.emit("action.rejected", resolved)
          this.send({
            type: "govern_result",
            id: msg.id,
            phase: "rejected",
            action_id: msg.action_id,
            reason: resolution.outcome.reason ?? "approval denied",
            kind: "approval_denied",
          })
          return
        }
        await this.emit("action.approved", resolved)
        const result = await this.executeAction(resolved)
        this.send({ ...result, id: msg.id })
        return
      }
      // Fail closed on the deadline: once it passes, the action expires and a
      // late resolution can never un-park it.
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        const expired: ApprovalOutcome = {
          kind: "expired",
          action_id: msg.action_id,
          request_id: requestId,
        }
        const rejected = kernel.resolve(parked, expired)
        await this.emit("approval.expired", {
          request_id: requestId,
          action_id: msg.action_id,
          at: rejected.approval?.at ?? new Date().toISOString(),
        })
        await this.emit("action.rejected", rejected)
        this.send({
          type: "govern_result",
          id: msg.id,
          phase: "rejected",
          action_id: msg.action_id,
          reason: "approval deadline passed with no valid resolution",
          kind: "approval_timeout",
        })
        return
      }
      if (waitMs > 0 && Date.now() - startedAt < waitMs) {
        await delay(RESOLUTION_POLL_INTERVAL_MS)
        continue
      }
      // Single check (or wait window elapsed) with no resolution and no deadline
      // breach: still held. The hook resumes again later.
      this.send({
        type: "govern_result",
        id: msg.id,
        phase: "pending_approval",
        action_id: msg.action_id,
        request_id: requestId,
        ...(recovered?.deadline !== undefined ? { deadline: recovered.deadline } : {}),
      })
      return
    }
  }

  private handleToolResult(msg: {
    id: number
    output?: unknown
    documents: { text: string; source?: string }[]
  }): void {
    const pending = this.pendingToolRuns.get(msg.id)
    if (pending === undefined) return // stray / late result; ignore
    this.pendingToolRuns.delete(msg.id)
    pending.resolve({ output: msg.output, documents: msg.documents })
  }

  private handleToolError(msg: { id: number; message: string }): void {
    const pending = this.pendingToolRuns.get(msg.id)
    if (pending === undefined) return
    this.pendingToolRuns.delete(msg.id)
    pending.reject(new Error(msg.message))
  }

  // ── Engine helpers ───────────────────────────────────────────────────────

  private requireKernel(): ActionKernel {
    if (this.kernel === undefined) throw new Error("RuntimeGate: not initialised (call init/serve)")
    return this.kernel
  }

  private contractFor(name: string): ActionContract {
    const defaults = this.config.tool_defaults[name] ?? CONSERVATIVE_TOOL_DEFAULTS
    return {
      required_level: defaults.required_trust_level,
      blast_radius: defaults.blast_radius,
      reversibility: defaults.reversibility,
      scope: this.config.default_scope,
      data_sensitivity: dataSensitivityFor(this.config.default_sensitivity),
      preconditions: [],
    }
  }

  private buildRemotingTool(
    originalName: string,
    internalName: string,
  ): Tool<Record<string, unknown>, RuntimeToolResultObservationPayload> {
    const defaults = this.config.tool_defaults[originalName] ?? CONSERVATIVE_TOOL_DEFAULTS
    return {
      // The kernel knows the tool by its namespaced name; the remoted execute
      // runs the body back in the hook under the ORIGINAL name (the closure
      // captures it).
      name: internalName,
      // Passthrough: the runtime tool owns its real input schema; the gate does
      // not re-validate the agent's args (it never sees the tool's body anyway).
      inputs: passthroughArgsSchema,
      output_schema_key: RUNTIME_TOOL_RESULT_SCHEMA_KEY,
      effects: [{ kind: "external_call", description: `governed runtime tool '${originalName}'` }],
      reversibility: defaults.reversibility,
      permissions: defaults.permissions,
      required_trust_level: defaults.required_trust_level,
      sandbox: defaults.sandbox,
      preconditions: () => [],
      execute: (inputs) => this.remoteExecute(originalName, inputs),
    }
  }

  /** The re-entrant remoted execute: ask the hook to run the real tool body, and
   *  wrap its result into the runtime tool-result observation payload. The body
   *  runs ONLY here, inside the kernel's execute phase. */
  private async remoteExecute(
    name: string,
    inputs: Record<string, unknown>,
  ): Promise<RuntimeToolResultObservationPayload> {
    const actionId = this.als.getStore()?.actionId ?? "unknown"
    const corr = ++this.runToolCounter
    const raw = await new Promise<{
      output: unknown
      documents: { text: string; source?: string }[]
    }>((resolve, reject) => {
      this.pendingToolRuns.set(corr, { resolve, reject })
      this.send({ type: "run_tool", id: corr, tool: name, args: inputs, action_id: actionId })
    })
    return { tool_name: name, args: inputs, output: raw.output, documents: raw.documents }
  }

  /** Run an approved action's execute phase (threading the action id) and turn the
   *  kernel's terminal phase into a `govern_result`, emitting the terminal event. */
  private async executeAction(approved: Action): Promise<Omit<GovernResultMessage, "id">> {
    const kernel = this.requireKernel()
    const executed = await this.als.run({ actionId: approved.id }, () => kernel.execute(approved))
    if (executed.phase === "completed") {
      await this.emit("action.completed", executed)
      const capture = this.captures.get(approved.id)
      this.captures.delete(approved.id)
      const output = (
        capture?.observation.payload as RuntimeToolResultObservationPayload | undefined
      )?.output
      return { type: "govern_result", phase: "completed", action_id: approved.id, output }
    }
    if (executed.phase === "rejected") {
      await this.emit("action.rejected", executed)
      return {
        type: "govern_result",
        phase: "rejected",
        action_id: approved.id,
        reason: lastFailureDetail(executed) ?? "precondition no longer holds at execution",
        kind: "precondition_failed",
      }
    }
    await this.emit("action.failed", executed)
    return {
      type: "govern_result",
      phase: "failed",
      action_id: approved.id,
      reason: lastFailureDetail(executed) ?? "tool execution failed",
      kind: "execution_failed",
    }
  }

  private async synthesizeDecision(): Promise<string | undefined> {
    if (this.arbiter === undefined) return undefined
    const beliefIds = this.arbiter.observedBeliefIds()
    if (beliefIds.length === 0) return undefined
    const id = randomUUID()
    const decision: Decision = {
      id,
      question:
        "synthesized: which beliefs observed this session could the governed tool call depend on?",
      options: [{ id: "proceed", description: "proceed with the governed tool call" }],
      selected_option_id: "proceed",
      rationale_id: `synthesized-decision-rationale:${id}`,
      belief_dependencies: beliefIds,
      policy_dependencies: [],
      made_by: RUNTIME_DECISION_SYNTHESIS_ACTOR,
      made_at: new Date().toISOString(),
    }
    await this.emit("decision.made", decision, { actor_id: RUNTIME_DECISION_SYNTHESIS_ACTOR })
    return id
  }

  private async observationSink(raw: Observation): Promise<void> {
    if (this.cognitive === undefined) throw new Error("observationSink before cognitive core built")
    const observation: Observation = {
      ...raw,
      context: {
        session_id: this.sessionId,
        project_id: this.config.project_id,
        actor_id: this.config.actor_id,
      },
      sensitivity: liftSensitivity(raw.sensitivity, this.config.default_sensitivity),
    }
    await this.emit("observation.recorded", observation)
    const ingest = await this.cognitive.ingest({
      observation,
      context: {
        actor_id: this.config.actor_id,
        project_id: this.config.project_id,
        session_id: this.sessionId,
        default_scope: this.config.default_scope,
        default_sensitivity: observation.sensitivity,
      },
    })
    await this.emit("cognitive.ingested", {
      observation_id: ingest.observation_id,
      claim_count: ingest.claims.length,
      belief_count: ingest.beliefs.length,
      world_model_keys: ingest.worldModelUpdates,
    })
    for (const claim of ingest.claims) await this.emit("claim.extracted", claim)
    if (this.evidenceStore !== undefined) {
      const seen = new Set<string>()
      for (const belief of ingest.beliefs) {
        const sets = await this.evidenceStore.forClaim(belief.claim_id)
        for (const set of sets) {
          if (seen.has(set.id)) continue
          seen.add(set.id)
          await this.emit("evidence.assessed", set)
        }
      }
    }
    for (const belief of ingest.beliefs) await this.emit("belief.adopted", belief)
    this.captures.set(observation.source.invocation_id, { observation, ingest })
  }

  // ── Hold resolution ──────────────────────────────────────────────────────

  /** Scan the durable log + the signed side-channel for a *verified* resolution
   *  bound to this request/action, deadline-gated. A forged / unsigned / tampered
   *  resolution is recorded once and (for the side-channel) deleted; polling
   *  continues. Returns undefined when no valid resolution is present yet. */
  private async checkResolution(
    requestId: string,
    actionId: string,
    deadlineAt: number | undefined,
  ): Promise<
    { outcome: ApprovalOutcome; source: "log" | "channel"; signature?: Signature } | undefined
  > {
    // Log path: an in-process resolver (or a forged append on the sibling NDJSON
    // log) — both clear the same signature gate.
    const reader = new EventLogReader(this.logRoot)
    let events: EventEnvelope[] = []
    try {
      events = await reader.readSession(this.config.project_id, this.sessionId)
    } catch {
      events = []
    }
    const logHit = this.resolutionFromLog(events, requestId, actionId, deadlineAt)
    if (logHit !== undefined) {
      if (this.resolutionVerified(logHit.doc, logHit.signature)) {
        return { outcome: outcomeFromDoc(logHit.doc), source: "log" }
      }
      await this.emitSignatureRejected(`log:${logHit.eventId}`, logHit.doc)
    }
    // Side-channel path: the separate-process resolver.
    const resolution = await readApprovalResolution(this.logRoot, this.config.project_id, requestId)
    if (resolution !== undefined && resolution.action_id === actionId) {
      if (!withinDeadline(resolution.at, deadlineAt)) {
        // A resolution dated after the deadline is a timeout, never a late
        // approval — leave it; the deadline branch in handleResume will expire.
        return undefined
      }
      if (this.resolutionVerified(resolution, resolution.signature)) {
        return {
          outcome: outcomeFromResolution(resolution),
          source: "channel",
          ...(resolution.signature !== undefined ? { signature: resolution.signature } : {}),
        }
      }
      await this.emitSignatureRejected(`req:${resolution.request_id}`, resolution)
      await deleteApprovalResolution(this.logRoot, this.config.project_id, requestId)
    }
    return undefined
  }

  private resolutionFromLog(
    events: EventEnvelope[],
    requestId: string,
    actionId: string,
    deadlineAt: number | undefined,
  ): { doc: ApprovalResolutionDoc; signature?: Signature; eventId: string } | undefined {
    for (const ev of events) {
      if (ev.type !== "approval.granted" && ev.type !== "approval.denied") continue
      if (this.warnedSignatureRejections.has(`log:${ev.id}`)) continue
      const kind = ev.type === "approval.granted" ? "granted" : "denied"
      const schema = kind === "granted" ? ApprovalGrantedPayloadSchema : ApprovalDeniedPayloadSchema
      const parsed = schema.safeParse(ev.payload)
      if (!parsed.success) continue
      const payload = parsed.data
      if (payload.request_id !== requestId || payload.action_id !== actionId) continue
      if (!withinDeadline(payload.at, deadlineAt) || !withinDeadline(ev.timestamp, deadlineAt))
        continue
      const doc: ApprovalResolutionDoc = {
        request_id: payload.request_id,
        action_id: payload.action_id,
        kind,
        approver_id: payload.approver_id,
        at: payload.at,
      }
      if (payload.reason !== undefined) doc.reason = payload.reason
      return { doc, signature: payload.signature, eventId: ev.id }
    }
    return undefined
  }

  private resolutionVerified(
    doc: ApprovalResolutionDoc,
    signature: Signature | undefined,
  ): boolean {
    const authorizedKeys = this.config.approvals?.authorized_keys ?? []
    const allowUnsigned = this.config.approvals?.allow_unsigned === true
    if (authorizedKeys.length === 0 && allowUnsigned) return true
    try {
      verifyApprovalSignature(doc, signature, { authorizedKeys, allowUnsigned: false })
      return true
    } catch (err) {
      if (err instanceof ApprovalSignatureError) return false
      throw err
    }
  }

  private async emitSignatureRejected(dedupKey: string, doc: ApprovalResolutionDoc): Promise<void> {
    if (this.warnedSignatureRejections.has(dedupKey)) return
    try {
      await this.emit("guard.approval.signature_rejected", {
        request_id: doc.request_id,
        action_id: doc.action_id,
        approver_id: doc.approver_id,
        reason: "resolution failed Ed25519 verification against pinned approver keys",
        at: new Date().toISOString(),
      })
      this.warnedSignatureRejections.add(dedupKey)
    } catch {
      // best-effort; leave unmarked so a later successful emit records it
    }
  }

  private async emitCanonicalResolution(
    outcome: ApprovalOutcome,
    signature?: Signature,
  ): Promise<void> {
    if (outcome.kind !== "granted" && outcome.kind !== "denied") return
    const at = outcome.at ?? new Date().toISOString()
    const payload: ApprovalGrantedPayload = {
      request_id: outcome.request_id,
      action_id: outcome.action_id,
      approver_id: outcome.approver_id,
      at,
    }
    if (outcome.reason !== undefined) payload.reason = outcome.reason
    if (signature !== undefined) payload.signature = signature
    await this.emit(outcome.kind === "granted" ? "approval.granted" : "approval.denied", payload)
  }

  // ── Durable reconstruction (restart durability + exactly-once) ─────────────

  private async readSessionEvents(): Promise<EventEnvelope[]> {
    const reader = new EventLogReader(this.logRoot)
    try {
      return await reader.readSession(this.config.project_id, this.sessionId)
    } catch {
      return []
    }
  }

  private async reconstructParkedAction(actionId: string): Promise<Action | undefined> {
    const events = await this.readSessionEvents()
    // The latest action.pending_approval event for this id carries the full parked
    // Action (phase pending_approval, with audit) — kernel.resolve accepts it.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev?.type !== "action.pending_approval") continue
      const action = ev.payload as Action
      if (action?.id === actionId && action.phase === "pending_approval") return action
    }
    return undefined
  }

  private async reconstructRequest(
    actionId: string,
  ): Promise<{ request_id: string; deadline?: string } | undefined> {
    const events = await this.readSessionEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev?.type !== "approval.requested") continue
      const req = ev.payload as ApprovalRequest
      if (req?.action_id === actionId) {
        return req.deadline !== undefined
          ? { request_id: req.request_id, deadline: req.deadline }
          : { request_id: req.request_id }
      }
    }
    return undefined
  }

  /** Exactly-once: the recorded terminal outcome for an action, if it already
   *  settled in the durable log. A completed action's output is recovered from its
   *  observation.recorded so a duplicate resume returns it without re-executing. */
  private async terminalOutcomeFromLog(
    actionId: string,
  ): Promise<Omit<GovernResultMessage, "id"> | undefined> {
    const events = await this.readSessionEvents()
    let output: unknown
    let completed = false
    let rejected: { reason: string; kind: string } | undefined
    let failed: string | undefined
    for (const ev of events) {
      if (ev.type === "observation.recorded") {
        const obs = ev.payload as Observation
        if (obs?.source?.invocation_id === actionId) {
          output = (obs.payload as RuntimeToolResultObservationPayload | undefined)?.output
        }
      } else if (ev.type === "action.completed") {
        if ((ev.payload as Action)?.id === actionId) completed = true
      } else if (ev.type === "action.failed") {
        const a = ev.payload as Action
        if (a?.id === actionId) failed = lastFailureDetail(a) ?? "tool execution failed"
      } else if (ev.type === "action.rejected") {
        const a = ev.payload as Action
        if (a?.id === actionId)
          rejected = { reason: lastFailureDetail(a) ?? "action rejected", kind: "policy_denied" }
      } else if (ev.type === "approval.expired") {
        const p = ev.payload as { action_id?: string }
        if (p?.action_id === actionId)
          rejected = { reason: "approval deadline passed", kind: "approval_timeout" }
      }
    }
    if (completed) {
      return { type: "govern_result", phase: "completed", action_id: actionId, output }
    }
    if (failed !== undefined) {
      return {
        type: "govern_result",
        phase: "failed",
        action_id: actionId,
        reason: failed,
        kind: "execution_failed",
      }
    }
    if (rejected !== undefined) {
      return {
        type: "govern_result",
        phase: "rejected",
        action_id: actionId,
        reason: rejected.reason,
        kind: rejected.kind,
      }
    }
    return undefined
  }

  // ── Event emission (+ arbiter feed) ────────────────────────────────────────

  private async emit(
    type: string,
    payload: unknown,
    options?: {
      causal_parent_ids?: string[]
      actor_id?: string
      schema_version?: string
      feedArbiter?: boolean
    },
  ): Promise<void> {
    if (this.writer === undefined) throw new Error("RuntimeGate: writer not initialised")
    const envelope = await this.writer.append({
      id: randomUUID(),
      type,
      schema_version: options?.schema_version ?? "0.1.0",
      project_id: this.config.project_id,
      session_id: this.sessionId,
      actor_id: options?.actor_id ?? this.config.actor_id,
      timestamp: new Date().toISOString(),
      causal_parent_ids: options?.causal_parent_ids ?? [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
    if (this.arbiter !== undefined && options?.feedArbiter !== false) {
      try {
        const alerts = await this.arbiter.observe(envelope)
        for (const alert of alerts) {
          await this.emit(SENTINEL_ALERTED_EVENT_TYPE, alert.payload, {
            causal_parent_ids: alert.causal_parent_ids,
            actor_id: this.arbiter.actorId,
            schema_version: SENTINEL_ALERTED_SCHEMA_VERSION,
            feedArbiter: false,
          })
        }
      } catch (err) {
        const failure = {
          for_event_id: envelope.id,
          for_event_type: envelope.type,
          error: err instanceof Error ? err.message : String(err),
        }
        await this.writer
          .append({
            id: randomUUID(),
            type: "guard.sentinel.failed",
            schema_version: "0.1.0",
            project_id: this.config.project_id,
            session_id: this.sessionId,
            actor_id: this.config.actor_id,
            timestamp: new Date().toISOString(),
            causal_parent_ids: [envelope.id],
            payload: failure,
            payload_hash: canonicalHash(failure),
            versions: { schema_registry_version: "0.1.0" },
          })
          .catch(() => {})
      }
    }
  }
}

// ── module-level helpers ─────────────────────────────────────────────────────

const passthroughArgsSchema = z.record(z.unknown())

/**
 * Namespace a hook's tool name into a registry-valid `runtime.<sanitised>` name
 * — the action-kernel registry requires `namespace.action`, but a native runtime
 * tool ("search_web", "writeFile") has no namespace. Mirrors the MCP proxy's
 * `mcp.<server>.<tool>`. Deterministic, so a fresh gate instance after a restart
 * derives the same internal name and resolves a reconstructed action's tool.
 */
function internalToolName(name: string): string {
  let seg = name.toLowerCase().replace(/[^a-z0-9_]/g, "_")
  if (!/^[a-z]/.test(seg)) seg = `t_${seg}`
  return `runtime.${seg}`
}

const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
}

function liftSensitivity(observed: Sensitivity, floor: Sensitivity): Sensitivity {
  return SENSITIVITY_ORDER[observed] >= SENSITIVITY_ORDER[floor] ? observed : floor
}

function dataSensitivityFor(s: Sensitivity): ActionContract["data_sensitivity"] {
  switch (s) {
    case "public":
      return "public"
    case "secret":
      return "secret"
    default:
      return "private"
  }
}

function lastFailureDetail(action: Action): string | undefined {
  for (let i = action.audit.length - 1; i >= 0; i--) {
    const step = action.audit[i]
    if (step && (step.phase === "failed" || step.phase === "rejected")) return step.detail
  }
  return undefined
}

/** A resolution time is within the deadline when there is no deadline, or its
 *  `at` is at-or-before it (numeric, offset-safe). */
function withinDeadline(at: string, deadlineAt: number | undefined): boolean {
  if (deadlineAt === undefined) return true
  const t = Date.parse(at)
  return Number.isNaN(t) ? false : t <= deadlineAt
}

function outcomeFromDoc(doc: ApprovalResolutionDoc): ApprovalOutcome {
  return {
    kind: doc.kind,
    action_id: doc.action_id,
    request_id: doc.request_id,
    approver_id: doc.approver_id,
    reason: doc.reason,
    at: doc.at,
  }
}

function outcomeFromResolution(r: ApprovalResolution): ApprovalOutcome {
  return {
    kind: r.kind,
    action_id: r.action_id,
    request_id: r.request_id,
    approver_id: r.approver_id,
    reason: r.reason,
    at: r.at,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
