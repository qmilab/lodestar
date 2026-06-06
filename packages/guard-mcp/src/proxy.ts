import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js"
import {
  ActionKernel,
  type ApprovalOutcome,
  type PolicyGate,
  type PreconditionChecker,
  lookupTool,
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
  ApprovalDeniedPayload,
  ApprovalGrantedPayload,
  ApprovalRequest,
  Decision,
  EventEnvelope,
  Observation,
  Reversibility,
} from "@qmilab/lodestar-core"
import { EventLogReader, EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  alwaysHoldsChecker,
  autoApprovePolicyCompiled,
  expireRequest,
  holdEvaluationForParkedAction,
  openApprovalRequest,
} from "@qmilab/lodestar-guard"
import type { CompiledPolicy, PolicyEvaluation, SentinelArbiter } from "@qmilab/lodestar-guard"
import {
  type BeliefStore,
  type ClaimStore,
  type EvidenceStore,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import {
  type ApprovalResolution,
  deleteApprovalResolution,
  readApprovalResolution,
  resolutionToOutcome,
} from "./approvals-channel.js"
import type { ProxyConfig, ToolContractDefaults } from "./config.js"
import { DownstreamConnection } from "./downstream.js"
import {
  MCPAwareEvidenceLinker,
  type MCPToolResultObservationPayload,
  registerMCPProxyExtractors,
} from "./observation.js"
import {
  type CallToolContentBlock,
  type CallToolResultLike,
  buildPolicyDeniedResult,
} from "./policy-result.js"
import {
  CONSERVATIVE_TOOL_DEFAULTS,
  namespacedToolName,
  registerDownstreamToolsWithKernel,
  sanitizeAdvertisedTool,
} from "./tool-adapter.js"
import { UpstreamServer } from "./upstream.js"

const SERVER_INFO = {
  name: "lodestar-guard-mcp",
  version: "0.1.5",
} as const

/**
 * The `made_by` (and emitted `decision.made` envelope `actor_id`) of a decision
 * the proxy **synthesizes** from the causal-recency window — the opaque-agent
 * decision source (ADR-0003). A wrapped MCP agent speaks `tools/call` only and
 * cannot declare its `belief_dependencies`, so the proxy invents the link from
 * "the beliefs adopted since the previous action". Attributing it to this
 * dedicated actor — never the governed agent — keeps the audit honest: a
 * synthesized decision is visibly the proxy's inference, not a forged agent
 * claim. Mirrors how a `sentinel.alerted` is attributed to the sentinel actor.
 */
export const PROXY_DECISION_SYNTHESIS_ACTOR = "lodestar-proxy-synthesis"

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
    handler: (req: {
      name: string
      arguments: Record<string, unknown>
    }) => Promise<CallToolResultLike>,
  ) => UpstreamServer
  /**
   * Override the policy gate. Defaults to the graduated `autoApprovePolicy`
   * ceiling compiled from `config.auto_approve_ceiling`.
   *
   * Accepts either a bare `PolicyGate` or a full `CompiledPolicy`. The kernel
   * only ever needs the gate, but a `CompiledPolicy` additionally lets the hold
   * path re-run its pure `evaluate()` to recover a matched `require_approval`
   * rule's `required_authority` (`min_trust_baseline` / `scope`) for the opened
   * `ApprovalRequest`. A bare `PolicyGate` cannot expose that, so a hold under
   * one carries only the action's mapped `sensitivity_clearance`. This is the
   * seam the CLI uses to inject a compiled `ProxyConfig.policy` document.
   */
  policyGate?: PolicyGate | CompiledPolicy
  /**
   * Override the precondition checker. Defaults to
   * `alwaysHoldsChecker` (MCP tools don't currently emit
   * preconditions; a future batch may add some).
   */
  preconditionChecker?: PreconditionChecker
  /**
   * Inject the firewall's belief/claim/evidence stores instead of the
   * default per-session in-memory ones. This is the seam that gives a
   * proxy durable, cross-session state: point two proxy sessions at the
   * same Postgres-backed stores (via
   * `createPostgresStores` from `@qmilab/lodestar-memory-firewall/postgres`)
   * and session B sees the beliefs session A persisted. The
   * `tool-poisoning-cross-session` probe uses this, and so does the CLI
   * when `config.persistence.backend === "postgres"`.
   *
   * The proxy treats injected stores as caller-owned: it never opens or
   * closes their underlying connection. Whoever constructs them (the
   * probe, the CLI) is responsible for `ensureSchema()` beforehand and
   * `close()` after `stop()`.
   */
  stores?: {
    claims: ClaimStore
    beliefs: BeliefStore
    evidence: EvidenceStore
  }
  /**
   * Wire the sentinel→action bridge into the proxy (ADR-0001 / ADR-0003). When
   * present, the proxy (a) feeds every event it emits to `arbiter.observe()` and
   * surfaces the alerts it returns as `sentinel.alerted@1`, and (b) **synthesizes**
   * a `decision.made` from the arbiter's causal-recency window before each action
   * — the opaque-agent decision source — so a belief-scoped sentinel alert can
   * gate the dependent tool call through the existing hold path.
   *
   * The `policyGate` MUST be a `CompiledPolicy` compiled from the **same** arbiter
   * (use `compileWithSentinels(policy, { sentinels, … })` and pass its matched
   * `{ gate, arbiter }` pair here). The proxy cannot statically verify that
   * binding (the F6 deferred item); a mismatch observes-but-does-not-gate.
   *
   * Omit it and the proxy behaves exactly as it does today: it feeds nothing,
   * synthesizes nothing, and its event stream is byte-for-byte unchanged. The
   * arbiter is single-session — pass a fresh one per proxy.
   */
  arbiter?: SentinelArbiter
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
  /**
   * The compiled policy behind {@link policyGate}, when one is available — the
   * default ceiling preset, or a `CompiledPolicy` override (the CLI's compiled
   * `ProxyConfig.policy`). Held so {@link resolveProxyHold} can re-run its pure
   * `evaluate()` to recover a matched rule's `required_authority`. `undefined`
   * when the gate is a bare `PolicyGate` override, where no such re-derivation
   * is possible and a hold falls back to the parked action's audit.
   */
  private readonly compiledPolicy?: CompiledPolicy
  private readonly preconditionChecker: PreconditionChecker
  private readonly upstreamFactory?: MCPProxyOverrides["upstreamFactory"]
  private readonly injectedStores?: MCPProxyOverrides["stores"]
  /**
   * The sentinel→action bridge, when wired (ADR-0003). Drives the arbiter feed in
   * {@link emit} and the decision synthesis in {@link handleCallTool}. `undefined`
   * leaves the proxy in its pure, pre-sentinel behaviour.
   */
  private readonly arbiter?: SentinelArbiter

  private firewall?: MemoryFirewall
  private evidenceStore?: EvidenceStore
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
  private readonly captures = new Map<string, { observation: Observation; ingest: IngestResult }>()
  /**
   * Names this proxy registered with the action-kernel tool
   * registry. Tracked for two reasons:
   *
   *   1. `stop()` deregisters every entry so the process can recycle
   *      the names cleanly for a subsequent `MCPProxy`. Without
   *      this, a second proxy in the same process would either fail
   *      to register (registry rejects duplicates) or, worse,
   *      silently route through a stale closure bound to a dead
   *      child process.
   *
   *   2. `handleCallTool` gates on membership here BEFORE consulting
   *      `lookupTool`. The action-kernel registry is process-wide,
   *      so without this gate a wrapped agent connected to one
   *      proxy could invoke tools any other part of the host had
   *      registered (another in-process proxy, a library consumer
   *      that pre-registered `fs.read`, …) and trigger an execution
   *      that wouldn't conform to `mcp.tool_result@1`. Codex round 5
   *      flagged this as a security + correctness gap.
   *
   * `Set` for O(1) membership checks. Insertion-order iteration on
   * deregister is sufficient — the action-kernel registry doesn't
   * care about order.
   */
  private readonly registeredToolNames: Set<string> = new Set()
  private started = false
  /**
   * Set true at the very start of `stop()` so an in-flight approval wait
   * (`waitForResolution`) bails promptly instead of resolving/executing against
   * a half-torn-down proxy (tools deregistered, session ended). Distinct from
   * `started`, which `stop()` only clears after teardown completes.
   */
  private stopping = false

  constructor(
    public readonly config: ProxyConfig,
    overrides?: MCPProxyOverrides,
  ) {
    this.sessionId = config.session_id === "auto" ? `session-${randomUUID()}` : config.session_id
    this.logRoot = resolvePath(process.cwd(), config.log_root)
    this.writer = new EventLogWriter(this.logRoot)
    this.downstreams =
      overrides?.downstreamFactory?.(config) ??
      config.downstream_servers.map((entry) => new DownstreamConnection(entry, SERVER_INFO))
    const gateOverride = overrides?.policyGate
    if (gateOverride === undefined) {
      // Default: the graduated ceiling preset, kept as a `CompiledPolicy` so the
      // hold path goes through `evaluate()` uniformly. (The preset has no
      // `require_approval` rule, so its only holds are the L4 floor's, whose
      // authority is `{}` — but keeping the compiled handle means the one code
      // path serves both the preset and a richer injected policy.)
      this.compiledPolicy = autoApprovePolicyCompiled({
        auto_approve_up_to: config.auto_approve_ceiling as 0 | 1 | 2 | 3,
        approver_id: `policy:auto-approve-up-to-${config.auto_approve_ceiling}`,
      })
      this.policyGate = this.compiledPolicy.gate
    } else if (typeof gateOverride === "function") {
      // A bare `PolicyGate`: the kernel has all it needs, but a hold cannot
      // re-derive a matched rule's authority — it falls back to the parked
      // action's audit (authority `{}`).
      this.policyGate = gateOverride
    } else {
      // A `CompiledPolicy`: use its gate, and keep the compiled handle so a hold
      // can re-run `evaluate()` to recover the matched rule's `required_authority`.
      this.compiledPolicy = gateOverride
      this.policyGate = gateOverride.gate
    }
    // A `config.policy` with no injected `CompiledPolicy` is a wiring bug,
    // mirroring the postgres-stores check below. The proxy deliberately does not
    // read or compile the policy document itself (that keeps the file I/O +
    // signature verification in the host — `compileProxyPolicy`, which the CLI
    // calls). Falling through to the `auto_approve_ceiling` preset here would
    // silently *ignore* a declared, possibly stricter, signed policy and
    // under-enforce it — a silent default for a security-relevant setting, which
    // this package does not allow. The discriminator is whether a CompiledPolicy
    // reached us via the override (a bare `PolicyGate` and the default preset
    // both leave the declared policy unhonoured), so gate on the override shape,
    // not on `this.compiledPolicy` (the preset sets that too).
    const compiledPolicyInjected = gateOverride !== undefined && typeof gateOverride !== "function"
    if (config.policy !== undefined && !compiledPolicyInjected) {
      throw new Error(
        "MCPProxy: config.policy is set but no compiled policy was injected. The proxy " +
          "does not read or compile the policy document itself — compile it " +
          "(compileProxyPolicy from @qmilab/lodestar-guard-mcp) and pass the result via " +
          "MCPProxyOverrides.policyGate. The `lodestar guard mcp-proxy` CLI does this for you.",
      )
    }
    this.preconditionChecker = overrides?.preconditionChecker ?? alwaysHoldsChecker
    if (overrides?.upstreamFactory !== undefined) {
      this.upstreamFactory = overrides.upstreamFactory
    }
    if (overrides?.stores !== undefined) {
      this.injectedStores = overrides.stores
    }
    if (overrides?.arbiter !== undefined) {
      this.arbiter = overrides.arbiter
    }
    // A `persistence: postgres` config with no injected stores is a wiring
    // bug: the proxy deliberately does not open database connections itself
    // (that keeps `bun:sql` out of this package's import graph and leaves
    // connection lifecycle with the host that owns the process). Fail fast
    // at construction rather than silently running in-memory and losing the
    // cross-session durability the operator asked for.
    if (config.persistence?.backend === "postgres" && this.injectedStores === undefined) {
      throw new Error(
        "MCPProxy: config.persistence.backend is 'postgres' but no stores were injected. " +
          "Construct the Postgres stores (createPostgresStores from " +
          "@qmilab/lodestar-memory-firewall/postgres) and pass them via " +
          "MCPProxyOverrides.stores. The `lodestar guard mcp-proxy` CLI does this for you.",
      )
    }
    // Sentinel enforcement needs BOTH an injected arbiter (the proxy feeds it and
    // synthesizes decisions for it) AND a `CompiledPolicy` gate whose arbitrate
    // hook consults that arbiter. Two distinct silent-non-enforcement traps, two
    // guards — keyed on what each actually requires:
    //
    // (A) `config.sentinels` declared but no arbiter wired to run them. The CLI
    //     always injects an arbiter for declared sentinels; a non-CLI host that set
    //     the field but forgot the arbiter would run the sentinels nowhere.
    if ((config.sentinels?.length ?? 0) > 0 && this.arbiter === undefined) {
      throw new Error(
        "MCPProxy: config.sentinels is set but no arbiter was injected. Resolve the " +
          "ids against FIRST_PARTY_SENTINELS (@qmilab/lodestar-harness) and inject a " +
          "SentinelArbiter via MCPProxyOverrides.arbiter, with policyGate compiled from " +
          "the same arbiter (compileProxyPolicyWithSentinels / compileWithSentinels). " +
          "The `lodestar guard mcp-proxy` CLI does this for you.",
      )
    }
    // (B) an arbiter is wired but the gate cannot arbitrate. The default
    //     `auto_approve_ceiling` preset and a bare `PolicyGate` have NO arbitrate
    //     hook, so the proxy would synthesize decisions and emit `sentinel.alerted`
    //     that can never hold an action — silent non-enforcement. This keys on the
    //     ARBITER, not `config.sentinels`, so it also catches a library host that
    //     wires `MCPProxyOverrides.arbiter` directly and omits the compiled gate.
    //     Verifying the gate was compiled from THIS arbiter is the deferred F6
    //     binding-token item; `compileProxyPolicyWithSentinels` /
    //     `compileWithSentinels` is the safe path.
    if (this.arbiter !== undefined && !compiledPolicyInjected) {
      throw new Error(
        "MCPProxy: an arbiter was injected but no CompiledPolicy gate was — the default " +
          "auto_approve_ceiling preset and a bare PolicyGate have no arbitrate hook, so " +
          "the arbiter's sentinel alerts could never hold an action. Inject a policyGate " +
          "compiled from the SAME arbiter (compileProxyPolicyWithSentinels / " +
          "compileWithSentinels). The `lodestar guard mcp-proxy` CLI does this for you.",
      )
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
    this.stopping = false

    // 1. Register the MCP-specific schema + extractor with the
    //    cognitive-core registries. Idempotent across calls.
    registerMCPProxyExtractors()

    // 2. Build the firewall/cognitive stack. One per session.
    //    Stores are either injected (durable, caller-owned — e.g. the
    //    Postgres stores the CLI wires up for a `persistence: postgres`
    //    config, or the shared stores the cross-session probe passes)
    //    or fresh in-memory ones (the single-session default). The
    //    constructor already rejected a `persistence: postgres` config
    //    that arrived without injected stores, so by here the pairing is
    //    consistent.
    const claims = this.injectedStores?.claims ?? new InMemoryClaimStore()
    const beliefs = this.injectedStores?.beliefs ?? new InMemoryBeliefStore()
    const evidence = this.injectedStores?.evidence ?? new InMemoryEvidenceStore()
    this.evidenceStore = evidence
    const worldModel = new InMemoryWorldModel()
    this.firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
      // Honour `causal_parent_ids` when the firewall audit event
      // carries it — reflection-driven transitions cite the
      // `reflection.completed` event id this way (design doc Q4).
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

    // Reset the advertised catalog before the registration loop
    // repopulates it. Without this, a restart of the same
    // `MCPProxy` instance (or a retry after a startup failure that
    // landed past the registration loop and the catch reset
    // `started`) would append a second copy of every tool name and
    // upstream `tools/list` would advertise duplicates. The kernel
    // registrations are already cycled correctly by
    // `deregisterTools()`; this brings the upstream catalog in
    // sync with that.
    this.namespacedTools = []

    try {
      // Bind the sentinel arbiter (when wired) to this proxy's session BEFORE the
      // first emit feeds it — the arbiter is single-session and `resolveContext`
      // must report exactly this session, never "whichever event was seen last".
      // A fresh proxy carries a fresh arbiter, so this never collides; but a
      // caller that reuses a still-bound arbiter makes `bindSession` throw, so it
      // sits INSIDE the rollback try — otherwise the throw would escape with
      // `started=true` and a follow-up `stop()` would emit `guard.session.ended`
      // for a session that never started (Codex review, round 5).
      this.arbiter?.bindSession(this.sessionId)

      // 4. First I/O: write the session-start envelope. Inside the
      //    try so a bad `log_root` (unwritable directory, full
      //    disk, …) routes through the rollback path instead of
      //    escaping with `started=true` still set — pre-fix that
      //    left the CLI's follow-up `stop()` trying to write to
      //    the same broken log.
      await this.emit("guard.session.started", {
        project_id: this.config.project_id,
        session_id: this.sessionId,
        actor_id: this.config.actor_id,
        mode: "mcp-proxy",
        started_at: new Date().toISOString(),
      })

      // 5. Start downstreams in parallel. If any fail, fail the
      //    whole start: a partially-connected proxy advertises
      //    tools it can't actually call.
      await Promise.all(this.downstreams.map((d) => d.start()))

      // 6. Register every downstream tool in the action-kernel
      //    registry. Build the upstream catalog at the same time.
      //    Track every name we register so `stop()` can deregister
      //    them; without that, two proxies in the same process leak
      //    stale closures bound to the prior downstream connection.
      //
      //    Tools that require task-based execution (`execution.task
      //    Support === "required"`) are dropped — the helper signals
      //    them via `onTaskRequiredSkipped`. We surface those to
      //    stderr so the operator sees which advertised tools the
      //    v0 proxy is leaving behind.
      const defaultsByTool: Record<string, ToolContractDefaults> = this.config.tool_defaults
      for (const downstream of this.downstreams) {
        const registered = registerDownstreamToolsWithKernel({
          downstream,
          defaultsByTool,
          conservativeDefaults: CONSERVATIVE_TOOL_DEFAULTS,
          onTaskRequiredSkipped: (info) => {
            // `lodestarName` is undefined when the skip happened
            // before name validation (the downstream's native
            // name didn't match the action-kernel regex). Show
            // whichever we have; either case is useful operator
            // signal.
            const display = info.lodestarName ?? `mcp.${info.downstreamName}.<${info.toolName}>`
            process.stderr.write(
              `[mcp-proxy] skipping task-required tool '${display}' (downstream '${info.downstreamName}', native name '${info.toolName}'). The v0 proxy forwards synchronous CallTool only; task forwarding is deferred to a later batch.\n`,
            )
          },
        })
        // Track EVERY name the helper returned in
        // `registeredToolNames` BEFORE any further per-tool work
        // (sanitisation, audit emit). The helper has already put
        // each of these into the process-wide action-kernel
        // registry; if `sanitizeAdvertisedTool` later throws on
        // the Nth tool (e.g. an extremely deeply nested schema
        // that overflows the recursive sanitiser), the rollback's
        // `deregisterTools()` must see ALL of them, not just the
        // 1..N-1 we managed to process.
        for (const { lodestarName } of registered) {
          this.registeredToolNames.add(lodestarName)
        }
        for (const { lodestarName, mcpTool } of registered) {
          // Build the sanitised version we advertise upstream
          // (description replaced, annotations/_meta/icons
          // dropped, schema descriptions scrubbed,
          // execution.taskSupport forced to "forbidden"). The
          // original tool metadata is captured in an audit event
          // below so operators can still see what the downstream
          // claimed when they inspect the trust report.
          const safe = sanitizeAdvertisedTool({
            mcpTool,
            lodestarName,
            downstreamName: downstream.config.name,
          })
          this.namespacedTools.push(safe)
          // Best-effort emit — if the log is broken (sub-case P
          // path), we still want the proxy to advertise the
          // sanitised tool so the wrapped agent can function.
          try {
            await this.emit("mcp_proxy.tool_advertised", {
              lodestar_name: lodestarName,
              downstream_name: downstream.config.name,
              downstream_tool_name: mcpTool.name,
              original_tool: mcpTool,
              advertised_tool: safe,
              advertised_at: new Date().toISOString(),
            })
          } catch {
            // best-effort
          }
        }
      }

      // 7. Start the upstream server with the aggregated catalog and
      //    a handler that drives each call through the kernel.
      this.upstream =
        this.upstreamFactory?.(this.namespacedTools, (req) => this.handleCallTool(req)) ??
        new UpstreamServer(this.namespacedTools, (req) => this.handleCallTool(req), SERVER_INFO)
      await this.upstream.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Best-effort: try to record the failure. If the original
      // throw came from a bad `log_root`, this emit will fail too —
      // swallow that secondary error so the caller sees the
      // primary one. Without the best-effort wrapper, the rethrow
      // path below would never run when the log itself is the
      // problem.
      try {
        await this.emit("guard.session.failed", {
          reason: message,
          at: new Date().toISOString(),
        })
      } catch {
        // best-effort
      }
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
      // Drop the partial catalog so a retry on the same instance
      // doesn't compound it with the next start's tools.
      this.namespacedTools = []
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
      await this.emitCallRefused({
        kind: "proxy_not_initialised",
        tool_name: req.name,
        args: req.arguments,
        reason: "handleCallTool invoked before start() wired the kernel",
      })
      return buildPolicyDeniedResult({
        tool_name: req.name,
        args: req.arguments,
        reason: "proxy is not initialised",
        kind: "proxy_not_initialised",
      })
    }

    // Gate on THIS proxy's advertised catalog, NOT on the process-
    // wide action-kernel registry. The wrapped agent must only be
    // able to invoke tools we explicitly mapped from a configured
    // downstream — otherwise it could call any other tool the host
    // happens to have registered (a sibling MCPProxy, a library
    // consumer pre-registering `fs.read`, …), bypassing this
    // proxy's `downstream_servers` / `tool_defaults` and producing
    // results that don't conform to `mcp.tool_result@1`.
    if (!this.registeredToolNames.has(req.name)) {
      // Audit every refused call — wrapped agents attempting to
      // invoke tools outside the advertised catalog are
      // security-relevant `tools/call` requests and need to show
      // up in the trust report alongside approved/rejected
      // actions. Without this emit, bypass attempts and stale
      // calls leave no trace in the event log.
      await this.emitCallRefused({
        kind: "tool_not_advertised",
        tool_name: req.name,
        args: req.arguments,
        reason: "tool name is not in this MCPProxy's advertised catalog (registeredToolNames)",
      })
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool '${req.name}'. The Lodestar MCP proxy does not advertise this tool — check the wrapped agent's tool list or the proxy config.`,
          },
        ],
        isError: true,
        _meta: {
          _lodestar: {
            kind: "tool_not_advertised",
            tool_name: req.name,
            reason: "tool name is not in this MCPProxy's advertised catalog (registeredToolNames)",
            args: req.arguments,
          },
        },
      }
    }
    const tool = lookupTool(req.name)
    if (tool === undefined) {
      // Belt-and-braces: the name passed our membership check but
      // the kernel doesn't have it. Should only fire under a race
      // (someone called `unregisterTool` between our check and this
      // lookup). Surface as a distinct kind so sentinels can spot
      // the corruption.
      await this.emitCallRefused({
        kind: "tool_registration_lost",
        tool_name: req.name,
        args: req.arguments,
        reason: "registeredToolNames includes this name but lookupTool returned undefined",
      })
      return {
        content: [
          {
            type: "text",
            text: `Tool '${req.name}' is advertised by this proxy but the action-kernel registry no longer recognises it. This indicates an out-of-band deregistration race.`,
          },
        ],
        isError: true,
        _meta: {
          _lodestar: {
            kind: "tool_registration_lost",
            tool_name: req.name,
            reason: "registeredToolNames includes this name but lookupTool returned undefined",
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

    // Synthesize a decision linking this action to the beliefs the session has
    // observed — the opaque-agent decision source (ADR-0003). The wrapped MCP
    // agent cannot declare its `belief_dependencies`, so the proxy assumes the
    // conservative set (every observed belief; it never shrinks mid-session, so a
    // held/filler call cannot drain a later action's obligations). This must
    // precede `propose` (the gate maps `action.decision_id → belief_dependencies
    // → backing beliefs`) AND its `emit` must be awaited first (so the arbiter has
    // observed the `decision.made` — firing any belief-scoped sentinel — before
    // `arbitrate` calls `resolveContext`). No arbiter, or an empty set (the first
    // read of a session), leaves `decision_id` unset and the stream unchanged.
    const decisionId = await this.synthesizeDecision()

    const proposed = this.kernel.propose({
      decision_id: decisionId,
      intent: `forward MCP tool call ${req.name} via proxy`,
      tool: req.name,
      inputs: req.arguments,
      contract,
      proposed_by: this.config.actor_id,
    })
    await this.emit("action.proposed", proposed)

    const arbitrated = await this.kernel.arbitrate(proposed)

    // Three-valued gate. A held action (an L4 tool the trust-ladder floor always
    // holds) is parked at `pending_approval`; `resolveProxyHold` opens a request,
    // waits up to `approval_timeout_ms` for an out-of-band resolution, and either
    // returns a terminal synthetic result (no-wait / deny / timeout) the agent
    // re-plans around or the un-parked, approved action to execute. A rejection
    // becomes a synthetic `policy_denied` result. Either way the world stays
    // untouched until an action reaches `approved` (two-phase discipline).
    let approved: Action
    if (arbitrated.phase === "pending_approval") {
      const held = await this.resolveProxyHold(arbitrated, req)
      if ("result" in held) return held.result
      approved = held.approved
    } else if (arbitrated.phase !== "approved") {
      await this.emit("action.rejected", arbitrated)
      const reason = arbitrated.approval?.reason ?? "policy gate rejected this action"
      return buildPolicyDeniedResult({
        tool_name: req.name,
        args: req.arguments,
        reason,
        kind: "policy_denied",
        action_id: arbitrated.id,
      })
    } else {
      await this.emit("action.approved", arbitrated)
      approved = arbitrated
    }

    // Capture slot is keyed by action id (== invocation_id on the
    // emitted Observation). Don't pre-clear a global slot — that
    // would race with overlapping calls.
    const executed = await this.kernel.execute(approved)
    if (executed.phase === "completed") {
      await this.emit("action.completed", executed)
      // No window bookkeeping on execution: the belief-dependency set is
      // cumulative (ADR-0003). Removing a belief once an action "acted on" it
      // would let an opaque agent drain a later consequential action's
      // obligations via a soft-denial retry or a low-trust filler — both real
      // under-gating bypasses. The set is reset only at session end.
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
            text: `Tool '${req.name}' failed during execution: ${detail}. This is a kernel-level failure, not a policy denial — the downstream MCP server returned an error or the proxy could not validate its output.`,
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
   * Resolve an action the policy held for approval (`pending_approval`).
   *
   * Emits `action.pending_approval` then `approval.requested@1` (carrying the
   * deadline when one is configured), then waits up to `approval_timeout_ms`
   * polling the event log for an out-of-band `approval.granted@1` /
   * `approval.denied@1` written by the `lodestar approve` CLI or an approval UI.
   * Returns the un-parked, `approved` action to execute, or a terminal synthetic
   * `CallToolResult` the wrapped agent reads as a normal response and re-plans
   * around:
   *   - `approval_timeout_ms` is 0 (no wait) → `approval_required`
   *   - deadline passes with no resolution   → `approval_timeout` (after
   *                                             emitting `approval.expired@1`)
   *   - an out-of-band deny lands            → `approval_denied`
   *
   * A timed-out hold is a soft denial the agent re-proposes — durable resume of
   * the *same* approved call is deliberately deferred (`policy-kernel.md`).
   */
  private async resolveProxyHold(
    parked: Action,
    req: { name: string; arguments: Record<string, unknown> },
  ): Promise<{ approved: Action } | { result: CallToolResultLike }> {
    if (this.kernel === undefined) {
      throw new Error("resolveProxyHold invoked before start() wired the kernel")
    }
    // Record the parked Action (with its audit) before anything else, so the
    // held state is reconstructable directly from the event stream — not only
    // inferred from `approval.requested`.
    await this.emit("action.pending_approval", parked)

    // Coalesce defensively: the field is required on the parsed config, but a
    // JS caller or a cast literal can reach the constructor without it, and an
    // `undefined` here would make the wait loop unbounded (every `<= 0` / `>=`
    // comparison against undefined is false). Treat a missing value as 0.
    const timeoutMs = this.config.approval_timeout_ms ?? 0
    const deadlineAt = Date.now() + timeoutMs
    const deadline = timeoutMs > 0 ? new Date(deadlineAt).toISOString() : undefined
    // Recover the hold's `required_authority`. A `CompiledPolicy` can re-run its
    // pure `evaluate()` to read a matched `require_approval` rule's authority
    // (`min_trust_baseline` / `scope`) — but ONLY for a contract+rule hold: an
    // arbitration-escalated hold is invisible to a context-free re-run (see
    // gate.ts), so `evaluate()` returns the base verdict (e.g. allow). Default
    // to the parked action's audit (always a hold, authority `{}`) and upgrade
    // to the compiled evaluation only when it agrees the verdict is a hold — so
    // every kind of hold opens a request rather than tripping on a non-hold
    // re-evaluation. Mirrors `guard.wrap()`'s `resolveHold`.
    let evaluation: PolicyEvaluation = holdEvaluationForParkedAction(parked)
    if (this.compiledPolicy) {
      const reevaluated = this.compiledPolicy.evaluate(parked)
      if (reevaluated.verdict === "hold") evaluation = reevaluated
    }
    const request = openApprovalRequest(
      parked,
      evaluation,
      deadline !== undefined ? { deadline } : {},
    )
    await this.emit("approval.requested", request)

    // No wait configured: surface the hold immediately as a soft denial the
    // agent re-proposes (the pre-deadline behaviour).
    if (timeoutMs <= 0) {
      return {
        result: buildPolicyDeniedResult({
          tool_name: req.name,
          args: req.arguments,
          reason: request.reason,
          kind: "approval_required",
          action_id: parked.id,
        }),
      }
    }

    const resolution = await this.waitForResolution(request, parked.id, deadlineAt)

    // The proxy was stopped mid-wait: don't append post-teardown events or run
    // the tool (its registration may already be gone). Return a terminal result;
    // the wrapped agent is disconnecting anyway.
    if (this.stopping) {
      return {
        result: buildPolicyDeniedResult({
          tool_name: req.name,
          args: req.arguments,
          reason: "proxy stopped before the held action was resolved",
          kind: "approval_timeout",
          action_id: parked.id,
        }),
      }
    }

    // Deadline passed with no resolution → expire it (a soft denial).
    if (resolution === undefined) {
      const expired = expireRequest(request)
      const rejected = this.kernel.resolve(parked, expired)
      const at = rejected.approval?.at ?? new Date().toISOString()
      await this.emit("approval.expired", {
        request_id: request.request_id,
        action_id: parked.id,
        at,
      })
      await this.emit("action.rejected", rejected)
      return {
        result: buildPolicyDeniedResult({
          tool_name: req.name,
          args: req.arguments,
          reason: `approval deadline passed with no resolution after ${timeoutMs}ms`,
          kind: "approval_timeout",
          action_id: parked.id,
        }),
      }
    }

    const { outcome, source } = resolution
    // A side-channel resolution (the separate-process `lodestar approve` CLI)
    // carries no event yet — the writer deliberately never appends the log. The
    // proxy is the sole writer of its session's log, so it emits the canonical
    // `approval.granted@1` / `approval.denied@1` itself, then consumes the
    // spent file. A resolution found already in the log (an in-process resolver
    // that shares the single-writer mutex) is left as-is — re-emitting would
    // duplicate it.
    if (source === "channel") {
      await this.emitCanonicalResolution(outcome)
      await deleteApprovalResolution(this.logRoot, this.config.project_id, request.request_id)
    }

    // A resolution arrived out-of-band. resolve() validates the binding.
    const resolved = this.kernel.resolve(parked, outcome)
    if (resolved.phase !== "approved") {
      await this.emit("action.rejected", resolved)
      return {
        result: buildPolicyDeniedResult({
          tool_name: req.name,
          args: req.arguments,
          reason: resolved.approval?.reason ?? "approval denied by resolver",
          kind: "approval_denied",
          action_id: parked.id,
        }),
      }
    }
    await this.emit("action.approved", resolved)
    return { approved: resolved }
  }

  /**
   * Poll for an out-of-band resolution of `request`, until the absolute
   * `deadlineAt` (ms epoch). Returns the bound `ApprovalOutcome` (granted/denied)
   * recorded *before* the deadline plus its `source`, or `undefined` if the
   * deadline passes first (or the proxy stops).
   *
   * Two sources, checked in order each poll:
   *   - **`log`** — an `approval.granted@1` / `approval.denied@1` already in the
   *     event log. This is the *in-process* resolver path: a second
   *     `EventLogWriter` in the proxy's own process shares the single-writer
   *     mutex and seq counter, so its append is seq-safe and already canonical.
   *     The caller does not re-emit.
   *   - **`channel`** — a `<request_id>.json` resolution file the separate-process
   *     `lodestar approve` CLI dropped in the side-channel (`approvals-channel.ts`).
   *     The CLI never writes the log (cross-process appends would collide on
   *     `seq`/`logical_clock` with the proxy's own counters), so the caller
   *     promotes it: emits the canonical `approval.*` event into the proxy's own
   *     log and consumes the file. The proxy stays the sole writer of its log.
   *
   * Acceptance is gated on the resolver's *decision time*, not on poll timing —
   * a log event's own envelope timestamp ≤ the request's `deadline`, or a channel
   * file's `at` ≤ `deadlineAt` (compared numerically, so an offset timestamp in
   * the file is handled correctly). A resolution dated after the deadline is a
   * timeout, never a late approval. A torn / partially-written read on either
   * source is swallowed and polling continues until the deadline.
   */
  private async waitForResolution(
    request: ApprovalRequest,
    actionId: string,
    deadlineAt: number,
  ): Promise<{ outcome: ApprovalOutcome; source: "log" | "channel" } | undefined> {
    const reader = new EventLogReader(this.logRoot)
    for (;;) {
      if (this.stopping) return undefined
      let events: EventEnvelope[] = []
      try {
        events = await reader.readSession(this.config.project_id, this.sessionId)
      } catch {
        // A concurrent append may have left a torn trailing line; treat it as
        // "no resolution yet" and keep polling rather than failing the call.
        events = []
      }
      const logOutcome = resolutionOutcomeFor(
        events,
        request.request_id,
        actionId,
        request.deadline,
      )
      if (logOutcome !== undefined) return { outcome: logOutcome, source: "log" }
      // Then the separate-process side-channel. Read errors / malformed files
      // surface as `undefined` (the helper is tolerant); keep polling.
      const resolution = await readApprovalResolution(
        this.logRoot,
        this.config.project_id,
        request.request_id,
      )
      const channelOutcome = channelOutcomeFor(resolution, actionId, deadlineAt)
      if (channelOutcome !== undefined) return { outcome: channelOutcome, source: "channel" }
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) return undefined
      await delay(Math.min(APPROVAL_POLL_INTERVAL_MS, remaining))
    }
  }

  /**
   * Emit the canonical `approval.granted@1` / `approval.denied@1` event for a
   * resolution the proxy picked up from the side-channel (the in-process / log
   * path already has its event). `payload.at` carries the *approver's* decision
   * time from the outcome; the envelope timestamp (`emit`) is the proxy's write
   * time — the same record-vs-decision split `approval.expired@1` already uses.
   * `reason` is omitted entirely when unset (canonical-hash discipline). An
   * `expired` outcome never reaches here — the side-channel only carries
   * granted/denied; the deadline path emits `approval.expired@1` itself.
   */
  private async emitCanonicalResolution(outcome: ApprovalOutcome): Promise<void> {
    const at = outcome.at ?? new Date().toISOString()
    if (outcome.kind === "granted") {
      const payload: ApprovalGrantedPayload = {
        request_id: outcome.request_id,
        action_id: outcome.action_id,
        approver_id: outcome.approver_id,
        at,
      }
      if (outcome.reason !== undefined) payload.reason = outcome.reason
      await this.emit("approval.granted", payload)
    } else if (outcome.kind === "denied") {
      const payload: ApprovalDeniedPayload = {
        request_id: outcome.request_id,
        action_id: outcome.action_id,
        approver_id: outcome.approver_id,
        at,
      }
      if (outcome.reason !== undefined) payload.reason = outcome.reason
      await this.emit("approval.denied", payload)
    }
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
    // Signal any in-flight approval wait to bail before we tear down tools and
    // close the session, so it cannot resolve/execute against a dead proxy.
    this.stopping = true
    try {
      // Best-effort: if the log is unwritable (operator broke the
      // partition mid-session, disk filled up, …), do not let the
      // failed emit prevent the rest of stop() from running. The
      // finally block still tears down the upstream + downstreams
      // + tool registrations.
      try {
        await this.emit("guard.session.ended", {
          ended_at: new Date().toISOString(),
        })
      } catch {
        // best-effort
      }
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
      // Clear the advertised catalog too. If the SAME proxy
      // instance is later restarted, start() repopulates the
      // array; leaving the prior contents would let `tools/list`
      // advertise stale duplicates.
      this.namespacedTools = []
      this.started = false
    }
  }

  private async stopDownstreamsQuiet(): Promise<void> {
    await Promise.allSettled(this.downstreams.map((d) => d.stop()))
  }

  /**
   * Emit an audit event for a `tools/call` the proxy refused before
   * reaching the kernel. Covers three classes:
   *
   *   - `tool_not_advertised`: name outside this proxy's
   *     `registeredToolNames` (round-5 gate). A wrapped agent
   *     attempting to invoke a tool we never advertised — bypass
   *     attempt or stale call.
   *   - `tool_registration_lost`: name passed the membership check
   *     but the kernel registry returned undefined. Should be a
   *     no-op invariant; logged so sentinels can flag the race.
   *   - `proxy_not_initialised`: handleCallTool reached before
   *     `start()` wired the kernel. Defensive — should not happen
   *     in practice.
   *
   * Best-effort: if the event log itself is broken (sub-case P
   * territory), swallow the secondary error so the synthetic
   * CallToolResult still reaches the agent.
   */
  private async emitCallRefused(input: {
    kind: "tool_not_advertised" | "tool_registration_lost" | "proxy_not_initialised"
    tool_name: string
    args: Record<string, unknown>
    reason: string
  }): Promise<void> {
    try {
      await this.emit("mcp_proxy.call_refused", {
        ...input,
        refused_at: new Date().toISOString(),
      })
    } catch {
      // best-effort
    }
  }

  /**
   * Synthesize a `decision.made` for the next action from the arbiter's
   * conservative belief-dependency set (ADR-0003). Returns the new decision id,
   * or `undefined` when no arbiter is wired or the set is empty — the action then
   * carries no decision link and is gated by contract + rule + subject-agnostic
   * signals only, exactly as the pre-sentinel proxy.
   *
   * The set is cumulative and never shrinks mid-session (the proxy never removes
   * from it): an opaque agent must not be able to drain its own obligations by
   * re-proposing a held call or running a low-trust filler. The emit is awaited so
   * the arbiter has observed the `decision.made` (firing any belief-scoped
   * sentinel and projecting `decision_id → belief_dependencies`) before the caller
   * arbitrates.
   */
  private async synthesizeDecision(): Promise<string | undefined> {
    if (this.arbiter === undefined) return undefined
    const beliefIds = this.arbiter.observedBeliefIds()
    if (beliefIds.length === 0) return undefined
    const id = randomUUID()
    const decision: Decision = {
      id,
      question:
        "synthesized: which beliefs observed this session could the proxied tool call depend on?",
      options: [{ id: "proceed", description: "proceed with the proxied tool call" }],
      selected_option_id: "proceed",
      // Deterministic synthetic rationale; a full backing Explanation is a
      // follow-up (ADR-0003) and does not change gating.
      rationale_id: `synthesized-decision-rationale:${id}`,
      belief_dependencies: beliefIds,
      policy_dependencies: [],
      made_by: PROXY_DECISION_SYNTHESIS_ACTOR,
      made_at: new Date().toISOString(),
    }
    // Attribute the synthesized decision to the synthesis actor, not the agent —
    // the audit must show this link as the proxy's inference (ADR-0003).
    await this.emit("decision.made", decision, { actor_id: PROXY_DECISION_SYNTHESIS_ACTOR })
    return id
  }

  private async emit(
    type: string,
    payload: unknown,
    options?: {
      causal_parent_ids?: string[]
      /**
       * Override the envelope `actor_id`. Used for events the proxy authors on
       * behalf of a governance layer rather than the agent: the synthesis actor
       * for `decision.made`, the sentinel actor for `sentinel.alerted@1`. Defaults
       * to the agent `actor_id`.
       */
      actor_id?: string
      /**
       * Override the envelope `schema_version`. `sentinel.alerted@1` carries the
       * canonical `SENTINEL_ALERTED_SCHEMA_VERSION`, not the generic session
       * version. Defaults to `"0.1.0"`.
       */
      schema_version?: string
      /**
       * Skip feeding the arbiter for this emit. Set on the recursive
       * `sentinel.alerted` emit so the feed bottoms out at depth one. Defaults to
       * feeding (when an arbiter is wired).
       */
      feedArbiter?: boolean
    },
  ): Promise<void> {
    // `append` returns the full envelope with `seq`/`logical_clock` assigned —
    // that is what the arbiter observes (sentinels read it positionally).
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

    // Feed the sentinel→action bridge (when wired). Mirrors guard.wrap()'s emit:
    // the arbiter buffers the alerts that land and projects the decision/belief
    // views; we surface each landed alert as `sentinel.alerted@1` on this SAME
    // writer (the proxy stays the sole log writer). The arbiter ignores
    // `sentinel.alerted` events and the recursive emit passes `feedArbiter:false`,
    // so the re-entry bottoms out at depth one for any sentinel set. Unlike guard,
    // the proxy has no agent-facing emit channel — every event it writes is
    // host-authored — so the "only host events feed the arbiter" boundary is
    // structural here (the opaque agent cannot emit at all).
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
        // Best-effort and non-blocking: a faulty/hostile sentinel — or a finding
        // that fails schema validation — must NOT abort the governed session.
        // Record a `guard.sentinel.failed` status event directly on the writer
        // (so it cannot re-enter the arbiter) and continue; only this one alert
        // pass is lost. Mirrors guard.wrap() (PR #54 review, F2).
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
          // If even the status append fails, give up silently — observability
          // must never break governance.
          .catch(() => {})
      }
    }
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
    for (const name of this.registeredToolNames) {
      unregisterTool(name)
    }
    this.registeredToolNames.clear()
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
function payloadToCallToolResult(payload: MCPToolResultObservationPayload): CallToolResultLike {
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
      copyBlockExtras(block.resource as unknown as Record<string, unknown>, resource, [
        "uri",
        "mimeType",
        "text",
        "blob",
      ])
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
function copyBlockExtras(block: unknown, out: Record<string, unknown>, excluded: string[]): void {
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

/** How often the proxy re-reads the log while waiting on a held action. */
const APPROVAL_POLL_INTERVAL_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Find an out-of-band `approval.granted@1` / `approval.denied@1` event matching
 * this request and build the bound `ApprovalOutcome`. Returns `undefined` if
 * none qualifies yet. First qualifying match wins — one resolution is expected
 * per request, and `ActionKernel.resolve()` re-validates the binding regardless.
 *
 * Two guards beyond the id match:
 * - **Deadline:** an event recorded *after* `notAfter` (the request's deadline)
 *   is skipped — a late grant is a timeout, not an approval.
 * - **Schema:** the payload is validated against the core
 *   `ApprovalGrantedPayloadSchema` / `ApprovalDeniedPayloadSchema`; a malformed
 *   event is skipped, never accepted with a fabricated `approver_id`. (This is
 *   shape validation, not a trust boundary against a process that can write the
 *   log — signing approval events is the deeper hardening, tracked separately.)
 */
function resolutionOutcomeFor(
  events: EventEnvelope[],
  requestId: string,
  actionId: string,
  notAfter: string | undefined,
): ApprovalOutcome | undefined {
  for (const e of events) {
    if (e.type !== "approval.granted" && e.type !== "approval.denied") continue
    if (notAfter !== undefined && e.timestamp > notAfter) continue
    const schema =
      e.type === "approval.granted" ? ApprovalGrantedPayloadSchema : ApprovalDeniedPayloadSchema
    const parsed = schema.safeParse(e.payload)
    if (!parsed.success) continue
    const p = parsed.data
    if (p.request_id !== requestId || p.action_id !== actionId) continue
    return {
      kind: e.type === "approval.granted" ? "granted" : "denied",
      action_id: p.action_id,
      request_id: p.request_id,
      approver_id: p.approver_id,
      reason: p.reason,
      at: p.at,
    }
  }
  return undefined
}

/**
 * Build the bound `ApprovalOutcome` from a side-channel resolution file, or
 * `undefined` if there is none yet, it is for a different action, or the
 * approver's decision time is after the deadline.
 *
 * The deadline guard mirrors `resolutionOutcomeFor`'s but compares *numerically*
 * (`Date.parse(at) <= deadlineAt`) rather than lexically: the side-channel `at`
 * is resolver-supplied and `TimestampSchema` permits a non-UTC offset, so a
 * lexical string compare against the UTC deadline would be wrong. A resolution
 * dated after the deadline is a timeout, never a late approval — the same rule
 * the log path applies. The action-id match is defense in depth: the file is
 * already keyed by `request_id`, and `ActionKernel.resolve()` re-validates the
 * binding regardless.
 */
function channelOutcomeFor(
  resolution: ApprovalResolution | undefined,
  actionId: string,
  deadlineAt: number,
): ApprovalOutcome | undefined {
  if (resolution === undefined) return undefined
  if (resolution.action_id !== actionId) return undefined
  const at = Date.parse(resolution.at)
  if (Number.isNaN(at) || at > deadlineAt) return undefined
  return resolutionToOutcome(resolution)
}
