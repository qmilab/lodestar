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
  FIREWALL_EVENT_SCHEMA_VERSION,
  FirewallAuditPayloadSchema,
  GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE,
  GUARD_APPROVAL_SIGNATURE_REJECTED_SCHEMA_VERSION,
  SENTINEL_ALERTED_EVENT_TYPE,
  SENTINEL_ALERTED_SCHEMA_VERSION,
  firewallEventType,
} from "@qmilab/lodestar-core"
import type {
  Action,
  ActionContract,
  ApprovalGrantedPayload,
  ApprovalRequest,
  Decision,
  EventEnvelope,
  GuardApprovalSignatureRejectedPayload,
  Observation,
  Sensitivity,
  Signature,
} from "@qmilab/lodestar-core"
import { EventLogReader, EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  type ApprovalChannel,
  type ApprovalRef,
  type ApprovalResolution,
  type ApprovalResolutionDoc,
  ApprovalSignatureError,
  type CompiledPolicy,
  type PolicyEvaluation,
  type SecretValue,
  type SentinelArbiter,
  alwaysHoldsChecker,
  assertValidApproverKeys,
  autoApprovePolicyCompiled,
  createApprovalChannel,
  holdEvaluationForParkedAction,
  httpChannelForbidsUnsigned,
  openApprovalRequest,
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
  type ToolContractDefaults,
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

/** Floor on a single poll's channel-fetch budget — one poll interval's worth — so a
 *  fast channel (incl. the default file channel on a `wait_ms: 0` resume) still gets
 *  one fair fetch attempt even when the resume wait window is zero. Never lets the
 *  fetch exceed the approval deadline (the budget is min'd against it). */
const MIN_CHANNEL_FETCH_BUDGET_MS = RESOLUTION_POLL_INTERVAL_MS

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
  /** Inject the approval transport directly (a probe / library stub), instead of
   *  building it from `config.approvals.channel` (ADR-0015). Wins over config. */
  approvalChannel?: ApprovalChannel
  /** Resolve an http channel's `token_env` to its bearer token. The gate never
   *  reads `process.env` — the host (the CLI) resolves the env var and injects this,
   *  the same discipline as the proxy's `resolveApprovalToken`. */
  resolveApprovalToken?: (envName: string) => SecretValue
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
  /**
   * The approval **transport** (ADR-0015): where {@link checkResolution} reads an
   * out-of-band resolution and how it consumes a promoted/rejected one. The default
   * `.approvals/` file channel (byte-for-byte the prior behaviour), an `http`
   * channel from `config.approvals.channel`, or an injected override. The signature
   * gate ({@link resolutionVerified}) is untouched and runs AFTER `fetch`, so this
   * mediates only the *source*, never the forgery boundary.
   */
  private readonly approvalChannel: ApprovalChannel

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
  /** In-flight approval-channel fetches, keyed by `request_id:action_id`. A fetch
   *  that outlives a short poll's budget keeps running in the channel until its own
   *  `timeout_ms`; reusing it for the next poll (rather than starting another) caps
   *  concurrent fetches to one per hold, so a hook that short-polls repeatedly can't
   *  pile up abandoned GETs/sockets against the approval service (Codex P2). A GET is
   *  idempotent (it reads, never consumes), so reuse is safe; the entry self-clears
   *  when the fetch settles. */
  private readonly inflightFetches = new Map<string, Promise<ApprovalResolution | undefined>>()
  /** Per-action serialisation tail. Two concurrent `resume` messages for the same
   *  held action would otherwise both pass the terminal-event check before either
   *  appends `action.completed`, and both reach `executeAction` — double-running a
   *  side-effectful tool. Resume handling is serialised per action id so the second
   *  runs only after the first has settled (and so sees its terminal event). */
  private readonly actionLocks = new Map<string, Promise<unknown>>()

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

    // The approval transport (ADR-0015), built exactly as the MCP proxy does: an
    // injected channel (a probe / library stub) wins; otherwise build it from
    // `config.approvals.channel`, defaulting to the local `.approvals/` file
    // channel. An `http` channel is a remote forgery surface that only the
    // signature gate closes — require a pinned key and forbid `allow_unsigned`,
    // re-checked here with the SAME predicate the schema superRefine uses (a literal
    // config bypasses the schema). The signature gate (`resolutionVerified`) is
    // unchanged and runs AFTER `fetch`: a hostile channel can only delay an
    // approval, never forge one.
    if (overrides?.approvalChannel !== undefined) {
      this.approvalChannel = overrides.approvalChannel
    } else {
      const httpGuard = httpChannelForbidsUnsigned(config.approvals ?? {})
      if (!httpGuard.ok) throw new Error(`RuntimeGate: ${httpGuard.reason}`)
      this.approvalChannel = createApprovalChannel(config.approvals?.channel ?? { kind: "file" }, {
        logRoot: this.logRoot,
        resolveToken: overrides?.resolveApprovalToken,
      })
    }

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
      // Validate + stamp the stable wire contract (ADR-0029, #137): the
      // firewall.*@1 payload is owned by `@qmilab/lodestar-core`. Feeding
      // the arbiter is preserved (a `belief.adopted` populates
      // `observedBeliefIds`), so no `feedArbiter: false`.
      const payload = FirewallAuditPayloadSchema.parse(event)
      const causal_parent_ids =
        "causal_parent_ids" in event && event.causal_parent_ids
          ? event.causal_parent_ids
          : undefined
      await this.emit(firewallEventType(payload.kind), payload, {
        schema_version: FIREWALL_EVENT_SCHEMA_VERSION,
        ...(causal_parent_ids ? { causal_parent_ids } : {}),
      })
    })
    const linker = new RuntimeAwareEvidenceLinker(evidence, beliefs, claims)
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
      // `raw` may be any JSON value — a primitive like `null` or `42` parses but
      // fails the schema. Coalesce to {} before reading fields so a non-object
      // never throws here (which would reject dispatch without a protocol reply).
      const shape =
        typeof raw === "object" && raw !== null ? (raw as { type?: unknown; id?: unknown }) : {}
      const id = typeof shape.id === "number" ? shape.id : undefined
      if (id !== undefined && (shape.type === "tool_result" || shape.type === "tool_error")) {
        // A malformed `tool_result` / `tool_error` (e.g. a hostile or buggy hook
        // returning an invalid `documents` shape) must not strand its remoted
        // execute waiting forever — reject the pending run so the action fails
        // cleanly (the kernel's execute catch turns it into a terminal `failed`).
        const pending = this.pendingToolRuns.get(id)
        if (pending !== undefined) {
          this.pendingToolRuns.delete(id)
          pending.reject(
            new Error(`malformed ${String(shape.type)} callback: ${parsed.error.message}`),
          )
        }
        // This `id` is the gate-assigned `run_tool` correlation id, NOT a hook
        // request id — the two id spaces overlap as plain integers. Echoing it as
        // a request-scoped `error` would let the hook route it to an unrelated
        // in-flight `govern`/`resume` whose request id happens to match. The
        // action is already failed via `pending.reject`, so emit an id-less
        // diagnostic instead (the hook ignores it).
        this.send({
          type: "error",
          message: `invalid ${String(shape.type)} callback: ${parsed.error.message}`,
        })
        return
      }
      // A malformed request (govern/resume/register): the id IS a hook request
      // id, so echo it so the waiting request fails rather than hanging.
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
    const kernel = this.requireKernel()
    await this.emit("action.pending_approval", parked)
    const timeoutMs = this.config.approval_timeout_ms ?? 0
    let evaluation: PolicyEvaluation = holdEvaluationForParkedAction(parked)
    if (this.compiledPolicy) {
      const reevaluated = this.compiledPolicy.evaluate(parked)
      if (reevaluated.verdict === "hold") evaluation = reevaluated
    }
    if (timeoutMs <= 0) {
      // No out-of-band resolution path (the documented timeout-0 contract): the
      // hold is a TERMINAL soft denial. Resolve the parked action to rejected and
      // emit the terminal `action.rejected`, so it is never left durably parked
      // with no terminal — a later `resume` would otherwise reconstruct it and,
      // if a resolution happened to exist, execute it. With the terminal recorded,
      // a `resume` returns it idempotently and never runs the body. The hook
      // re-proposes if it wants. (This gate also refuses to resume at all when
      // timeout-0; see resolveResume.)
      const request = openApprovalRequest(parked, evaluation, {})
      await this.emit("approval.requested", request)
      const expired: ApprovalOutcome = {
        kind: "expired",
        action_id: parked.id,
        request_id: request.request_id,
      }
      const rejected = kernel.resolve(parked, expired)
      // Emit `approval.expired@1` (not just `action.rejected`) so read-side
      // approval tooling — `lodestar approve list`, the viewer — sees the request
      // resolved rather than stuck "pending" forever (it keys resolution on the
      // approval.* terminal events). This gate never reads the side-channel for a
      // timeout-0 hold, so the request is genuinely done.
      await this.emit("approval.expired", {
        request_id: request.request_id,
        action_id: parked.id,
        at: rejected.approval?.at ?? new Date().toISOString(),
      })
      await this.emit("action.rejected", rejected)
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
    let reply: Omit<GovernResultMessage, "id">
    try {
      // Serialise per action id (P1#2): a second concurrent resume for the same
      // action runs only after the first settles, so it sees the first's terminal
      // event and returns it idempotently rather than double-executing.
      reply = await this.serialize(msg.action_id, () => this.resolveResume(msg))
    } catch (err) {
      reply = {
        type: "govern_result",
        phase: "failed",
        action_id: msg.action_id,
        reason: err instanceof Error ? err.message : String(err),
        kind: "internal_error",
      }
    }
    this.send({ ...reply, id: msg.id })
  }

  /** Run `fn` after any in-flight operation for `key` has settled, recording this
   *  one as the new tail. Errors are swallowed for chaining; the cleanup removes
   *  the entry once this run is the settled tail. */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.actionLocks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => {},
      () => {},
    )
    this.actionLocks.set(key, tail)
    void tail.then(() => {
      if (this.actionLocks.get(key) === tail) this.actionLocks.delete(key)
    })
    return run
  }

  private async resolveResume(msg: {
    action_id: string
    request_id: string
    wait_ms?: number
  }): Promise<Omit<GovernResultMessage, "id">> {
    const kernel = this.requireKernel()

    // Exactly-once (§4/§5): a terminal event for this action in the durable log
    // means it already settled — return the recorded outcome, never re-execute.
    const terminal = await this.terminalOutcomeFromLog(msg.action_id)
    if (terminal !== undefined) return terminal

    // A timeout-0 gate has no out-of-band resolution path (P1#1) — a hold under it
    // is a terminal soft denial, never resumable into execution. Refuse to resume
    // (defence in depth beyond openHold's terminal `action.rejected`).
    if ((this.config.approval_timeout_ms ?? 0) <= 0) {
      return {
        type: "govern_result",
        phase: "rejected",
        action_id: msg.action_id,
        reason: "this gate does not resolve holds out-of-band (approval_timeout_ms is 0)",
        kind: "approval_required",
      }
    }

    // Reconstruct the parked action — from memory (fast path) or the durable log
    // (a fresh instance after a restart). The deadline comes from the log's
    // approval.requested@1, never recomputed, so a restart cannot reset it.
    const parked =
      this.pendingActions.get(msg.action_id) ?? (await this.reconstructParkedAction(msg.action_id))
    if (parked === undefined) {
      return {
        type: "govern_result",
        phase: "rejected",
        action_id: msg.action_id,
        reason: "no held action found for this id",
        kind: "unknown_action",
      }
    }
    const recovered = await this.reconstructRequest(msg.action_id)
    const requestId = recovered?.request_id ?? msg.request_id
    const deadlineAt =
      recovered?.deadline !== undefined ? Date.parse(recovered.deadline) : undefined

    const waitMs = msg.wait_ms ?? 0
    const startedAt = Date.now()
    for (;;) {
      if (this.stopping) {
        return {
          type: "govern_result",
          phase: "pending_approval",
          action_id: msg.action_id,
          request_id: requestId,
        }
      }
      // Cap this poll's channel fetch by the SMALLER of the remaining approval
      // deadline and the remaining resume wait window, so a stalled channel cannot
      // make a short-poll / non-blocking resume hang to the channel's own timeout
      // (Codex P2). A small floor still guarantees one fair fetch attempt per poll,
      // so a fast channel — including the default file channel on a `wait_ms: 0`
      // resume — is always read; the floor never exceeds the deadline.
      const fetchBudgetMs = channelFetchBudgetMs(deadlineAt, startedAt, waitMs)
      const resolution = await this.checkResolution(
        requestId,
        msg.action_id,
        deadlineAt,
        fetchBudgetMs,
      )
      if (resolution !== undefined) {
        if (resolution.source === "channel") {
          await this.emitCanonicalResolution(resolution.outcome, resolution.signature)
          // Consume the promoted resolution best-effort (fire-and-forget): a slow
          // remote DELETE must not delay executing the now-approved action, and
          // exactly-once keys on the durable terminal event, not the file's absence.
          this.consumeResolution(this.approvalRef(requestId, msg.action_id))
        }
        const resolved = kernel.resolve(parked, resolution.outcome)
        if (resolved.phase !== "approved") {
          await this.emit("action.rejected", resolved)
          this.pendingActions.delete(msg.action_id)
          return {
            type: "govern_result",
            phase: "rejected",
            action_id: msg.action_id,
            reason: resolution.outcome.reason ?? "approval denied",
            kind: "approval_denied",
          }
        }
        await this.emit("action.approved", resolved)
        const result = await this.executeAction(resolved)
        this.pendingActions.delete(msg.action_id)
        return result
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
        this.pendingActions.delete(msg.action_id)
        return {
          type: "govern_result",
          phase: "rejected",
          action_id: msg.action_id,
          reason: "approval deadline passed with no valid resolution",
          kind: "approval_timeout",
        }
      }
      if (waitMs > 0 && Date.now() - startedAt < waitMs) {
        await delay(RESOLUTION_POLL_INTERVAL_MS)
        continue
      }
      // Single check (or wait window elapsed) with no resolution and no deadline
      // breach: still held. The hook resumes again later.
      return {
        type: "govern_result",
        phase: "pending_approval",
        action_id: msg.action_id,
        request_id: requestId,
        ...(recovered?.deadline !== undefined ? { deadline: recovered.deadline } : {}),
      }
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

  /**
   * The operator's contract defaults for a tool, or the conservative fallback.
   *
   * `tool_defaults` is a plain object, so a hook-chosen tool name that collides
   * with an inherited `Object.prototype` member (`toString`, `constructor`,
   * `hasOwnProperty`, …) would resolve to the prototype function on a bare index
   * read — making the contract fields `undefined` and letting an untrusted hook
   * dodge the conservative default by naming a tool cleverly. Gate on an
   * *own*-property check so only an operator-declared entry is ever used; anything
   * else falls through to `CONSERVATIVE_TOOL_DEFAULTS`.
   */
  private defaultsFor(name: string): ToolContractDefaults {
    const own = Object.hasOwn(this.config.tool_defaults, name)
      ? this.config.tool_defaults[name]
      : undefined
    return own ?? CONSERVATIVE_TOOL_DEFAULTS
  }

  private contractFor(name: string): ActionContract {
    const defaults = this.defaultsFor(name)
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
    const defaults = this.defaultsFor(originalName)
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
    const timeoutMs = this.config.tool_exec_timeout_ms ?? 0
    const raw = await new Promise<{
      output: unknown
      documents: { text: string; source?: string }[]
    }>((resolve, reject) => {
      // Bound the wait so a lost, never-sent, or uncorrelatable (malformed, no-id)
      // `tool_result` fails the action (the kernel's execute catch → terminal
      // `failed`) instead of stranding the kernel awaiting forever. The timer is
      // cleared when a real callback settles the run (resolve/reject below).
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pendingToolRuns.delete(corr)) {
            reject(new Error(`remoted tool '${name}' did not return within ${timeoutMs}ms`))
          }
        }, timeoutMs)
      }
      const clear = (): void => {
        if (timer !== undefined) clearTimeout(timer)
      }
      this.pendingToolRuns.set(corr, {
        resolve: (out) => {
          clear()
          resolve(out)
        },
        reject: (err) => {
          clear()
          reject(err)
        },
      })
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
      world_model_withheld: ingest.worldModelWithheld,
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

  /** Build the {@link ApprovalRef} a channel keys a resolution by. */
  private approvalRef(requestId: string, actionId: string): ApprovalRef {
    return {
      project_id: this.config.project_id,
      session_id: this.sessionId,
      request_id: requestId,
      action_id: actionId,
    }
  }

  /** Best-effort `consume` (delete a spent / rejected resolution), fire-and-forget.
   *  Cleanup must never block or delay hold resolution; the channel bounds the
   *  request by its own wall-clock timeout, and any error is swallowed. Mirrors the
   *  proxy's `consumeResolution`. */
  private consumeResolution(ref: ApprovalRef): void {
    void Promise.resolve(this.approvalChannel.consume?.(ref)).catch(() => {})
  }

  /** One `channel.fetch`, capped at `budgetMs` (already the min of the remaining
   *  approval deadline and the remaining resume wait window — see
   *  {@link channelFetchBudgetMs}). The channel has its OWN wall-clock timeout
   *  (`timeout_ms` for HTTP, default 15s) that can dwarf BOTH the approval deadline
   *  AND a short `resume(wait_ms)`; without this cap a single stalled fetch would
   *  (a) overshoot the deadline and execute a before-deadline grant late, and (b)
   *  hang a short-poll / non-blocking resume to the channel timeout. Race the fetch
   *  against the budget; if the budget wins, abandon the (now irrelevant) fetch and
   *  report "no resolution this poll" — the loop then expires or re-polls. A
   *  rejecting custom channel resolves to `undefined` (fail closed). `Infinity`
   *  means no bound (no deadline and an unbounded wait). */
  private async fetchWithinBudget(
    ref: ApprovalRef,
    budgetMs: number,
  ): Promise<ApprovalResolution | undefined> {
    // Reuse a single in-flight fetch per hold: one that outlived an earlier short
    // poll's budget is still running in the channel (until its own `timeout_ms`), so
    // the next poll racing a NEW fetch would pile up abandoned GETs/sockets against
    // the service (Codex P2). A GET is idempotent, so sharing the pending one is safe.
    const key = `${ref.request_id}:${ref.action_id}`
    let inflight = this.inflightFetches.get(key)
    if (inflight === undefined) {
      const fetchPromise = Promise.resolve(this.approvalChannel.fetch(ref)).catch(() => undefined)
      this.inflightFetches.set(key, fetchPromise)
      // Self-clear on settle (identity-guarded so a newer fetch's entry survives).
      void fetchPromise.finally(() => {
        if (this.inflightFetches.get(key) === fetchPromise) this.inflightFetches.delete(key)
      })
      inflight = fetchPromise
    }
    if (!Number.isFinite(budgetMs)) return inflight
    if (budgetMs <= 0) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        inflight,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), budgetMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Scan the durable log + the signed side-channel for a *verified* resolution
   *  bound to this request/action, deadline-gated. A forged / unsigned / tampered
   *  resolution is recorded once and (for the side-channel) deleted; polling
   *  continues. Returns undefined when no valid resolution is present yet. */
  private async checkResolution(
    requestId: string,
    actionId: string,
    deadlineAt: number | undefined,
    fetchBudgetMs: number,
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
      await this.emitSignatureRejected(`log:${logHit.eventId}`, logHit.doc, {
        source: "log",
        rejectedEventId: logHit.eventId,
      })
    }
    // Channel path: the separate-process resolver, read through the pluggable
    // ApprovalChannel (ADR-0015). The default file channel reads the same
    // `.approvals/` bytes as before; an http channel reads a remote service. The
    // fetch is CAPPED at `fetchBudgetMs` (the min of the remaining deadline and the
    // resume wait window): the HTTP channel's own `timeout_ms` can dwarf both, and
    // an uncapped slow fetch would (a) overshoot the deadline and execute a
    // before-deadline grant LATE, and (b) hang a short-poll resume. A fetch that
    // outlasts the budget (or a rejecting custom channel) yields `undefined`, so the
    // loop expires or re-polls.
    const resolution = await this.fetchWithinBudget(
      this.approvalRef(requestId, actionId),
      fetchBudgetMs,
    )
    // Bind the fetched resolution to BOTH this request AND this action. The channel
    // is untrusted transport (ADR-0015): the HTTP channel binds request_id at the
    // transport, but the file channel and any custom/injected channel do not — so
    // the consumer must, or a channel could replay a (validly signed) resolution for
    // a DIFFERENT request on the same action into this hold. Mirrors the proxy's
    // `channelOutcomeFor` (both ids), not just action_id.
    if (
      resolution !== undefined &&
      resolution.request_id === requestId &&
      resolution.action_id === actionId
    ) {
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
      await this.emitSignatureRejected(`req:${resolution.request_id}`, resolution, {
        source: "side_channel",
      })
      // Consume the spent forgery best-effort (fire-and-forget): a re-fetch before
      // the DELETE lands is harmless — the signature gate refuses it again and the
      // diagnostic is deduped, exactly the proxy's posture.
      this.consumeResolution(this.approvalRef(requestId, actionId))
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

  private async emitSignatureRejected(
    dedupKey: string,
    doc: ApprovalResolutionDoc,
    origin: { source: "log"; rejectedEventId: string } | { source: "side_channel" },
  ): Promise<void> {
    if (this.warnedSignatureRejections.has(dedupKey)) return
    try {
      // `source` + `rejected_event_id` let a read-side projection exclude the
      // *specific* forged log event rather than the whole request, so a genuine
      // grant submitted after the forgery still resolves. The id is recorded here
      // by the gate (the trusted writer); a side-channel forgery is never promoted
      // to a log event, so it carries no id.
      const payload: GuardApprovalSignatureRejectedPayload = {
        request_id: doc.request_id,
        action_id: doc.action_id,
        approver_id: doc.approver_id,
        reason: "resolution failed Ed25519 verification against pinned approver keys",
        at: new Date().toISOString(),
        source: origin.source,
      }
      if (origin.source === "log") payload.rejected_event_id = origin.rejectedEventId
      await this.emit(GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE, payload, {
        schema_version: GUARD_APPROVAL_SIGNATURE_REJECTED_SCHEMA_VERSION,
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
    let failed: string | undefined
    let rejectedDetail: string | undefined // a generic action.rejected (precondition / arbitrate)
    // The approval-lifecycle classifications. These are tracked SEPARATELY from
    // the trailing `action.rejected` the timeout/deny path also emits — otherwise a
    // replay would relabel an `approval_timeout` / `approval_denied` as a generic
    // `policy_denied` (the events are scanned in order and `action.rejected` comes
    // last), breaking callers that branch on the kind for re-planning.
    let expired = false
    let denied = false
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
        if (a?.id === actionId) rejectedDetail = lastFailureDetail(a) ?? "action rejected"
      } else if (ev.type === "approval.expired") {
        if ((ev.payload as { action_id?: string })?.action_id === actionId) expired = true
      } else if (ev.type === "approval.denied") {
        if ((ev.payload as { action_id?: string })?.action_id === actionId) denied = true
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
    // A rejection terminal requires the gate's OWN `action.rejected` — a
    // gate-authored event the gate emits only after it has itself resolved/expired
    // the action (and, for an out-of-band resolution, *after* verifying its
    // Ed25519 signature in checkResolution). `approval.expired` / `approval.denied`
    // only REFINE the kind; they never make an action terminal on their own.
    //
    // This is the forgery boundary: a local writer who appends a *bare*
    // `approval.denied` to the sibling NDJSON log (no gate-authored
    // `action.rejected`) must NOT permanently mask a later genuine signed grant.
    // Without `action.rejected` this returns undefined, so `resolveResume` falls
    // through to `checkResolution`, which signature-verifies before un-parking —
    // the forged denial is ignored and the real grant still wins. (A forged
    // `approval.granted` is likewise inert: `completed` keys on the gate's own
    // `action.completed`, never on `approval.granted`.)
    if (rejectedDetail !== undefined) {
      if (expired) {
        return {
          type: "govern_result",
          phase: "rejected",
          action_id: actionId,
          reason: "approval deadline passed with no valid resolution",
          kind: "approval_timeout",
        }
      }
      if (denied) {
        return {
          type: "govern_result",
          phase: "rejected",
          action_id: actionId,
          reason: "approval denied",
          kind: "approval_denied",
        }
      }
      return {
        type: "govern_result",
        phase: "rejected",
        action_id: actionId,
        reason: rejectedDetail,
        kind: "policy_denied",
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
 * The wall-clock budget for one poll's channel fetch: the SMALLER of the time left
 * before the approval deadline and the time left in the resume wait window, floored
 * to {@link MIN_CHANNEL_FETCH_BUDGET_MS} so a fast channel always gets one fair
 * attempt (the floor is itself capped by the deadline, so it can never overshoot).
 * `Infinity` when there is neither a deadline nor a wait bound. This keeps a stalled
 * channel from (a) executing a before-deadline grant late and (b) hanging a
 * short-poll / non-blocking resume to the channel's own timeout.
 */
function channelFetchBudgetMs(
  deadlineAt: number | undefined,
  startedAt: number,
  waitMs: number,
): number {
  const now = Date.now()
  const deadlineRemaining = deadlineAt !== undefined ? deadlineAt - now : Number.POSITIVE_INFINITY
  const waitRemaining = startedAt + waitMs - now
  return Math.max(
    0,
    Math.min(deadlineRemaining, Math.max(waitRemaining, MIN_CHANNEL_FETCH_BUDGET_MS)),
  )
}

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
