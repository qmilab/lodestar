import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import {
  ActionKernel,
  lookupTool,
  unregisterTool,
  type PolicyGate,
  type PreconditionChecker,
} from "@qmilab/lodestar-action-kernel"
import { canonicalHash, EventLogWriter } from "@qmilab/lodestar-event-log"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import {
  CognitiveCore,
  ExplanationGenerator,
  InMemoryWorldModel,
  type IngestResult,
} from "@qmilab/lodestar-cognitive-core"
import type {
  Action,
  ActionContract,
  Observation,
  Reversibility,
} from "@qmilab/lodestar-core"
import {
  autoApprovePolicy,
  alwaysHoldsChecker,
} from "@qmilab/lodestar-guard"
import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import type { ProxyConfig, ToolContractDefaults } from "./config.js"
import { DownstreamConnection } from "./downstream.js"
import {
  MCPAwareEvidenceLinker,
  type MCPToolResultObservationPayload,
  registerMCPProxyExtractors,
} from "./observation.js"
import {
  buildPolicyDeniedResult,
  type CallToolContentBlock,
  type CallToolResultLike,
} from "./policy-result.js"
import {
  CONSERVATIVE_TOOL_DEFAULTS,
  namespacedToolName,
  registerDownstreamToolsWithKernel,
} from "./tool-adapter.js"
import { UpstreamServer } from "./upstream.js"

const SERVER_INFO = {
  name: "lodestar-guard-mcp",
  version: "0.1.5",
} as const

/**
 * Optional dependency injection for tests and probes. Production
 * callers use the defaults: the proxy constructs an UpstreamServer
 * that speaks stdio and DownstreamConnections that spawn child
 * processes. Tests substitute these to drive the proxy in-process.
 */
export interface MCPProxyOverrides {
  /**
   * Construct downstream connections from config. Probes substitute
   * this with an in-process fake that exposes synthetic tools and
   * returns canned CallToolResults — including hostile-content
   * fixtures for the injection-defense probe.
   */
  downstreamFactory?: (config: ProxyConfig) => DownstreamConnection[]
  /**
   * Construct an upstream server. Probes substitute this with an
   * in-process loopback that drives `tools/call` invocations
   * directly without a stdio transport.
   */
  upstreamFactory?: (
    tools: MCPTool[],
    handler: (req: { name: string; arguments: Record<string, unknown> }) => Promise<CallToolResultLike>,
  ) => UpstreamServer
  /**
   * Override the policy gate. Defaults to `autoApprovePolicy`
   * configured from `config.auto_approve_ceiling`.
   */
  policyGate?: PolicyGate
  /**
   * Override the precondition checker. Defaults to
   * `alwaysHoldsChecker` (MCP tools don't currently emit
   * preconditions; a future batch may add some).
   */
  preconditionChecker?: PreconditionChecker
}

/**
 * The composed MCP proxy. Owns one session: one event log, one
 * firewall, one cognitive core, one kernel, one upstream server,
 * one set of downstream connections.
 *
 * Lifetime is a single MCP session — from the wrapped agent's
 * `initialize` to its stdio close. The proxy is not multi-tenant:
 * if the operator wants a second wrapped agent, they spin up a
 * second proxy.
 */
export class MCPProxy {
  private readonly sessionId: string
  private readonly logRoot: string
  private readonly writer: EventLogWriter
  private readonly downstreams: DownstreamConnection[]
  private readonly policyGate: PolicyGate
  private readonly preconditionChecker: PreconditionChecker
  private readonly upstreamFactory?: MCPProxyOverrides["upstreamFactory"]

  private firewall?: MemoryFirewall
  private evidenceStore?: InMemoryEvidenceStore
  private cognitive?: CognitiveCore
  private kernel?: ActionKernel
  private upstream?: UpstreamServer
  private namespacedTools: MCPTool[] = []
  /**
   * Captures keyed by the kernel action's `id` (which the kernel
   * also uses as `observation.source.invocation_id`). Concurrent
   * `tools/call` requests would have raced on a single-slot capture
   * box — the observation sink for call A could overwrite the slot
   * before call B's `handleCallTool` read it, leaking A's
   * observation into B's response or throwing
   * "completed without producing an observation". Per-invocation
   * keying makes each call atomic with respect to the others.
   */
  private readonly captures = new Map<
    string,
    { observation: Observation; ingest: IngestResult }
  >()
  /**
   * Names this proxy registered with the action-kernel tool
   * registry. Tracked so `stop()` can deregister them and let the
   * process recycle the names cleanly for a subsequent `MCPProxy`.
   * Without this, a second proxy in the same process would either
   * fail to register (registry rejects duplicates) or, worse,
   * silently route through a stale closure bound to a dead child
   * process — the bug Codex flagged.
   */
  private readonly registeredToolNames: string[] = []
  private started = false

  constructor(public readonly config: ProxyConfig, overrides?: MCPProxyOverrides) {
    this.sessionId =
      config.session_id === "auto" ? `session-${randomUUID()}` : config.session_id
    this.logRoot = resolvePath(process.cwd(), config.log_root)
    this.writer = new EventLogWriter(this.logRoot)
    this.downstreams =
      overrides?.downstreamFactory?.(config) ??
      config.downstream_servers.map(
        (entry) => new DownstreamConnection(entry, SERVER_INFO),
      )
    this.policyGate =
      overrides?.policyGate ??
      autoApprovePolicy({
        auto_approve_up_to: config.auto_approve_ceiling as 0 | 1 | 2 | 3 | 4,
        approver_id: `policy:auto-approve-up-to-${config.auto_approve_ceiling}`,
      })
    this.preconditionChecker =
      overrides?.preconditionChecker ?? alwaysHoldsChecker
    if (overrides?.upstreamFactory !== undefined) {
      this.upstreamFactory = overrides.upstreamFactory
    }
  }

  /**
   * The session_id this proxy will tag every event with. Generated
   * once at construction. Exposed so the operator (and probes) can
   * find the right session when running `lodestar report`.
   */
  get session_id(): string {
    return this.sessionId
  }

  /** Where the event log NDJSON files are written. */
  get log_root(): string {
    return this.logRoot
  }

  /**
   * Start the proxy: open downstream connections, register their
   * tools with the kernel, build the upstream catalog, open the
   * upstream stdio server.
   *
   * Returns a promise that resolves when the upstream transport
   * closes (typically because the wrapped agent exited). The
   * promise rejects only on a fatal startup error; runtime errors
   * during normal operation are logged to the event stream, never
   * thrown out of this method.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error("MCPProxy: already started")
    }
    this.started = true

    // 1. Register the MCP-specific schema + extractor with the
    //    cognitive-core registries. Idempotent across calls.
    registerMCPProxyExtractors()

    // 2. Build the in-memory firewall/cognitive stack. One per
    //    session.
    const claims = new InMemoryClaimStore()
    const beliefs = new InMemoryBeliefStore()
    const evidence = new InMemoryEvidenceStore()
    this.evidenceStore = evidence
    const worldModel = new InMemoryWorldModel()
    this.firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
      await this.emit(`firewall.${event.kind}`, event)
    })
    const linker = new MCPAwareEvidenceLinker(evidence, beliefs)
    const explanations = new ExplanationGenerator(this.config.actor_id)
    this.cognitive = new CognitiveCore(this.firewall, linker, explanations, worldModel)

    // 3. Build the kernel with the real session/project IDs. No
    //    stubs — Round 5 invariant.
    this.kernel = new ActionKernel(
      this.policyGate,
      this.preconditionChecker,
      (obs) => this.observationSink(obs),
      () => ({ session_id: this.sessionId, project_id: this.config.project_id }),
    )

    await this.emit("guard.session.started", {
      project_id: this.config.project_id,
      session_id: this.sessionId,
      actor_id: this.config.actor_id,
      mode: "mcp-proxy",
      started_at: new Date().toISOString(),
    })

    try {
      // 4. Start downstreams in parallel. If any fail, fail the
      //    whole start: a partially-connected proxy advertises
      //    tools it can't actually call.
      await Promise.all(this.downstreams.map((d) => d.start()))

      // 5. Register every downstream tool in the action-kernel
      //    registry. Build the upstream catalog at the same time.
      //    Track every name we register so `stop()` can deregister
      //    them; without that, two proxies in the same process leak
      //    stale closures bound to the prior downstream connection.
      const defaultsByTool: Record<string, ToolContractDefaults> = this.config.tool_defaults
      for (const downstream of this.downstreams) {
        const registered = registerDownstreamToolsWithKernel({
          downstream,
          defaultsByTool,
          conservativeDefaults: CONSERVATIVE_TOOL_DEFAULTS,
        })
        for (const { lodestarName, mcpTool } of registered) {
          this.namespacedTools.push({ ...mcpTool, name: lodestarName })
          this.registeredToolNames.push(lodestarName)
        }
      }

      // 6. Start the upstream server with the aggregated catalog and
      //    a handler that drives each call through the kernel.
      this.upstream =
        this.upstreamFactory?.(
          this.namespacedTools,
          (req) => this.handleCallTool(req),
        ) ??
        new UpstreamServer(
          this.namespacedTools,
          (req) => this.handleCallTool(req),
          SERVER_INFO,
        )
      await this.upstream.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.emit("guard.session.failed", {
        reason: message,
        at: new Date().toISOString(),
      })
      // Roll back the partial side effects of start():
      // - any tools the proxy managed to register before the failure
      //   must be removed so a retry doesn't trip the
      //   "tool already registered" guard in
      //   `registerDownstreamToolsWithKernel`;
      // - downstream child processes that did start must be stopped;
      // - if `start()` got far enough to instantiate the upstream
      //   before throwing (e.g., the throw came from
      //   `upstream.start()` itself), close it best-effort.
      this.deregisterTools()
      await this.stopDownstreamsQuiet()
      if (this.upstream !== undefined) {
        try {
          await this.upstream.stop()
        } catch {
          // best-effort — upstream may have only partially started
        }
        this.upstream = undefined
      }
      // Clear `started` so the CLI's catch path (which calls
      // `proxy.stop()` after we rethrow) does NOT emit a misleading
      // `guard.session.ended` on top of the `guard.session.failed`
      // we already emitted. Without this reset the trust report
      // would show a failed startup as if it closed cleanly.
      this.started = false
      throw err
    }
  }

  /**
   * Resolves when the upstream transport closes (because the wrapped
   * agent disconnected) or when `stop()` is called. The CLI awaits
   * this after `start()` so the process stays alive as long as the
   * wrapped agent is connected; in-process callers (probes, the
   * `claude-code-wrapped` example) can ignore it.
   */
  async waitUntilClosed(): Promise<void> {
    if (this.upstream === undefined) return
    await this.upstream.waitUntilClosed()
  }

  /**
   * Handle one `tools/call` from the wrapped agent. Returns the
   * CallToolResult-shaped object that gets sent back over the MCP
   * transport.
   */
  async handleCallTool(req: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<CallToolResultLike> {
    if (this.kernel === undefined) {
      // Belt-and-braces: handleCallTool is only invoked after
      // start() wires the kernel. If we ever reach this branch the
      // proxy is in a broken state and the safer response is a
      // synthetic denial — never a downstream call.
      return buildPolicyDeniedResult({
        tool_name: req.name,
        args: req.arguments,
        reason: "proxy is not initialised",
        kind: "proxy_not_initialised",
      })
    }

    const tool = lookupTool(req.name)
    if (tool === undefined) {
      // The wrapped agent is asking for a tool the proxy never
      // advertised. This is not a policy denial — it's a malformed
      // request. Synthesize an MCP-style tool error rather than a
      // policy_denied payload so sentinels watching for denials
      // don't confuse the two.
      return {
        content: [
          {
            type: "text",
            text:
              `Unknown tool '${req.name}'. The Lodestar MCP proxy does not advertise this tool — ` +
              `check the wrapped agent's tool list or the proxy config.`,
          },
        ],
        isError: true,
        _meta: {
          _lodestar: {
            kind: "tool_not_registered",
            tool_name: req.name,
            reason: "lookupTool returned undefined",
            args: req.arguments,
          },
        },
      }
    }

    // Build the ActionContract from the registered tool's metadata
    // plus the namespaced ceiling. The contract is single-valued
    // per registration (one set of defaults per downstream tool);
    // per-call overrides from the wrapped agent are NOT honoured —
    // an agent that asked for "make this reversible" cannot weaken
    // the operator-declared contract.
    const contract: ActionContract = {
      required_level: tool.required_trust_level,
      blast_radius: this.blastRadiusFor(req.name),
      reversibility: tool.reversibility as Reversibility,
      scope: this.config.default_scope,
      data_sensitivity: this.dataSensitivityFor(this.config.default_sensitivity),
      preconditions: [],
    }

    const proposed = this.kernel.propose({
      intent: `forward MCP tool call ${req.name} via proxy`,
      tool: req.name,
      inputs: req.arguments,
      contract,
      proposed_by: this.config.actor_id,
    })
    await this.emit("action.proposed", proposed)

    const arbitrated = await this.kernel.arbitrate(proposed)
    if (arbitrated.phase !== "approved") {
      await this.emit("action.rejected", arbitrated)
      const reason = arbitrated.approval?.reason ?? "policy gate rejected this action"
      return buildPolicyDeniedResult({
        tool_name: req.name,
        args: req.arguments,
        reason,
        kind: "policy_denied",
        action_id: arbitrated.id,
      })
    }
    await this.emit("action.approved", arbitrated)

    // Capture slot is keyed by action id (== invocation_id on the
    // emitted Observation). Don't pre-clear a global slot — that
    // would race with overlapping calls.
    const executed = await this.kernel.execute(arbitrated)
    if (executed.phase === "completed") {
      await this.emit("action.completed", executed)
    } else if (executed.phase === "rejected") {
      // Precondition revalidation killed the action between
      // arbitration and execution (TOCTOU defense). Emit as
      // rejected and synthesise a denial result so the agent
      // treats this the same as a policy denial.
      await this.emit("action.rejected", executed)
      const reason = lastFailureDetail(executed) ?? "precondition no longer holds"
      return buildPolicyDeniedResult({
        tool_name: req.name,
        args: req.arguments,
        reason,
        kind: "precondition_failed",
        action_id: executed.id,
      })
    } else {
      await this.emit("action.failed", executed)
      const detail = lastFailureDetail(executed) ?? "tool execution failed"
      return {
        content: [
          {
            type: "text",
            text:
              `Tool '${req.name}' failed during execution: ${detail}. ` +
              `This is a kernel-level failure, not a policy denial — the downstream MCP server ` +
              `returned an error or the proxy could not validate its output.`,
          },
        ],
        isError: true,
        _meta: {
          _lodestar: {
            kind: "execution_failed",
            tool_name: req.name,
            reason: detail,
            action_id: executed.id,
            args: req.arguments,
          },
        },
      }
    }

    // The observation sink stashed the captured Observation +
    // IngestResult under the action's id. Reconstruct the
    // CallToolResult from the observation payload so the wrapped
    // agent sees the faithful downstream output.
    const captured = this.takeCapture(executed.id, req.name)
    const payload = captured.observation.payload as MCPToolResultObservationPayload
    return payloadToCallToolResult(payload)
  }

  /**
   * The kernel's observation sink. Routes a freshly-validated
   * observation through the cognitive core and stashes the result
   * in the capture box so handleCallTool can pair it with the
   * returning Action.
   */
  private async observationSink(raw: Observation): Promise<void> {
    if (this.cognitive === undefined) {
      throw new Error("observationSink invoked before cognitive core was constructed")
    }
    // Rewrite the observation context to ensure the host-supplied
    // session/project IDs win even if the kernel falls back. Lift
    // sensitivity to at least the session's default — never below.
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
    for (const claim of ingest.claims) {
      await this.emit("claim.extracted", claim)
    }
    // Emit evidence sets alongside beliefs (dedup by id). The
    // injection-defense probe inspects these to assert that
    // external_document evidence flowed correctly.
    if (this.evidenceStore !== undefined) {
      const seenEvidenceIds = new Set<string>()
      for (const belief of ingest.beliefs) {
        const sets = await this.evidenceStore.forClaim(belief.claim_id)
        for (const set of sets) {
          if (seenEvidenceIds.has(set.id)) continue
          seenEvidenceIds.add(set.id)
          await this.emit("evidence.assessed", set)
        }
      }
    }
    for (const belief of ingest.beliefs) {
      await this.emit("belief.adopted", belief)
    }
    // Key by invocation_id (== kernel action.id). Overlapping
    // tools/call requests each land in their own slot; no race.
    this.captures.set(observation.source.invocation_id, { observation, ingest })
  }

  /**
   * Stop the proxy gracefully: emit `guard.session.ended`, stop
   * the upstream transport, then stop each downstream connection.
   * Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.started) return
    try {
      await this.emit("guard.session.ended", {
        ended_at: new Date().toISOString(),
      })
    } finally {
      try {
        await this.upstream?.stop()
      } catch {
        // Closing upstream is best-effort — the wrapped agent may
        // have already closed its side.
      }
      await this.stopDownstreamsQuiet()
      // Drop every action-kernel registration this proxy installed
      // so a subsequent MCPProxy in the same process can register
      // overlapping names cleanly. Without this, the second proxy
      // would either fail to register (registry rejects duplicates)
      // or — worse, pre-Codex-review — silently route through this
      // proxy's now-dead closure.
      this.deregisterTools()
      this.started = false
    }
  }

  private async stopDownstreamsQuiet(): Promise<void> {
    await Promise.allSettled(this.downstreams.map((d) => d.stop()))
  }

  private async emit(type: string, payload: unknown): Promise<void> {
    await this.writer.append({
      id: randomUUID(),
      type,
      schema_version: "0.1.0",
      project_id: this.config.project_id,
      session_id: this.sessionId,
      actor_id: this.config.actor_id,
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
  }

  private blastRadiusFor(_toolName: string): ActionContract["blast_radius"] {
    // The tool_defaults block carries blast_radius alongside
    // reversibility etc. We don't have a typed handle on it from
    // the action-kernel `Tool` (which stores reversibility but not
    // blast_radius). Re-derive from config.
    const defaults = this.config.tool_defaults[_toolName] ?? CONSERVATIVE_TOOL_DEFAULTS
    return defaults.blast_radius
  }

  private dataSensitivityFor(
    sessionSensitivity: ProxyConfig["default_sensitivity"],
  ): ActionContract["data_sensitivity"] {
    switch (sessionSensitivity) {
      case "public":
        return "public"
      case "secret":
        return "secret"
      case "internal":
      case "confidential":
        return "private"
    }
  }

  private takeCapture(
    actionId: string,
    toolName: string,
  ): { observation: Observation; ingest: IngestResult } {
    const captured = this.captures.get(actionId)
    this.captures.delete(actionId)
    if (captured === undefined) {
      throw new Error(
        `MCPProxy: tool '${toolName}' (action ${actionId}) completed without producing an observation`,
      )
    }
    return captured
  }

  /**
   * Drop every action-kernel registration this proxy made at
   * `start()`. Idempotent: callable from both `stop()` and the
   * start-error rollback path without double-unregistering.
   */
  private deregisterTools(): void {
    while (this.registeredToolNames.length > 0) {
      const name = this.registeredToolNames.pop()
      if (name !== undefined) unregisterTool(name)
    }
  }
}

/**
 * Reconstruct an MCP `CallToolResult`-shaped object from the
 * observation payload, faithful to what the downstream returned.
 *
 * Text, image, audio, and resource blocks pass through unchanged
 * (the upstream MCP transport accepts the same union). For an
 * `"unknown"` block — recorded when a downstream emits a content
 * kind Lodestar's schema doesn't model yet — we surface the
 * original wire bytes as a text descriptor; the agent loses the
 * non-textual payload in that path, but only for content kinds the
 * SDK itself doesn't yet recognise, which is a much narrower
 * failure than the pre-fix behavior (text-only round-trip for
 * everything).
 *
 * Pre-Codex review this function downgraded image/audio/resource
 * blocks to text placeholders, which silently corrupted any
 * downstream tool that returned non-text content. The widened
 * `CallToolContentBlock` union (see `policy-result.ts`) is what
 * makes the typed round-trip below possible.
 */
function payloadToCallToolResult(
  payload: MCPToolResultObservationPayload,
): CallToolResultLike {
  const content: CallToolContentBlock[] = payload.content.map((block) => {
    // For every known block kind we copy the documented fields then
    // pass any preserved extras (annotations, block-level _meta,
    // future spec additions) through unchanged. The observation
    // schema's `.catchall(z.unknown())` keeps these extras alive on
    // the inbound side; this loop ensures the upstream round-trip
    // emits them too. Pre-Codex review the round-trip cherry-picked
    // documented fields and silently lost the rest.
    if (block.type === "text") {
      const out: Record<string, unknown> = { type: "text", text: block.text }
      copyBlockExtras(block, out, ["type", "text"])
      return out as CallToolContentBlock
    }
    if (block.type === "image") {
      const out: Record<string, unknown> = {
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      }
      copyBlockExtras(block, out, ["type", "data", "mimeType"])
      return out as CallToolContentBlock
    }
    if (block.type === "audio") {
      const out: Record<string, unknown> = {
        type: "audio",
        data: block.data,
        mimeType: block.mimeType,
      }
      copyBlockExtras(block, out, ["type", "data", "mimeType"])
      return out as CallToolContentBlock
    }
    if (block.type === "resource") {
      const resource: Record<string, unknown> = { uri: block.resource.uri }
      if (block.resource.mimeType !== undefined) resource.mimeType = block.resource.mimeType
      if (block.resource.text !== undefined) resource.text = block.resource.text
      if (block.resource.blob !== undefined) resource.blob = block.resource.blob
      copyBlockExtras(
        block.resource as unknown as Record<string, unknown>,
        resource,
        ["uri", "mimeType", "text", "blob"],
      )
      const out: Record<string, unknown> = {
        type: "resource",
        resource,
      }
      copyBlockExtras(block, out, ["type", "resource"])
      return out as CallToolContentBlock
    }
    if (block.type === "resource_link") {
      const out: Record<string, unknown> = {
        type: "resource_link",
        uri: block.uri,
        name: block.name,
      }
      if (block.title !== undefined) out.title = block.title
      if (block.description !== undefined) out.description = block.description
      if (block.mimeType !== undefined) out.mimeType = block.mimeType
      if (block.size !== undefined) out.size = block.size
      copyBlockExtras(block, out, [
        "type",
        "uri",
        "name",
        "title",
        "description",
        "mimeType",
        "size",
      ])
      return out as CallToolContentBlock
    }
    // type === "unknown" — Lodestar can't classify this block kind.
    // Surface it as a text descriptor so the agent sees something
    // rather than silently dropping it; the raw block is still in
    // the observation payload for audit.
    return {
      type: "text",
      text: `[Lodestar proxy: downstream returned a content block of kind '${block.original_type}' that Lodestar does not yet model. The raw block is preserved in the event log.]`,
    }
  })
  const result: CallToolResultLike = {
    content,
    isError: payload.is_error,
  }
  // Round-trip `structuredContent` if the downstream supplied it.
  // Tools with declared output schemas use it to expose typed data.
  if (payload.structured_content !== undefined) {
    result.structuredContent = payload.structured_content
  }
  // Round-trip result-level `_meta` (progress tokens, task
  // associations, server-defined extensions). Pre-Codex review this
  // was dropped, breaking agents that consume the field.
  if (payload.meta !== undefined) {
    result._meta = payload.meta
  }
  return result
}

/**
 * Copy any forward-compatible MCP fields from `block` onto `out`,
 * skipping the documented keys the caller has already populated.
 * Mirrors `copyExtras` in tool-adapter.ts but lives in proxy.ts to
 * keep round-trip-time and capture-time logic close to their
 * respective entry points.
 */
function copyBlockExtras(
  block: unknown,
  out: Record<string, unknown>,
  excluded: string[],
): void {
  if (block === null || typeof block !== "object") return
  const skip = new Set(excluded)
  for (const key of Object.keys(block as Record<string, unknown>)) {
    if (skip.has(key)) continue
    out[key] = (block as Record<string, unknown>)[key]
  }
}

function liftSensitivity(
  observed: Observation["sensitivity"],
  floor: ProxyConfig["default_sensitivity"],
): Observation["sensitivity"] {
  const order: Record<Observation["sensitivity"], number> = {
    public: 0,
    internal: 1,
    confidential: 2,
    secret: 3,
  }
  return order[observed] >= order[floor] ? observed : floor
}

function lastFailureDetail(action: Action): string | undefined {
  for (let i = action.audit.length - 1; i >= 0; i--) {
    const step = action.audit[i]
    if (step && (step.phase === "failed" || step.phase === "rejected")) {
      return step.detail
    }
  }
  return undefined
}
