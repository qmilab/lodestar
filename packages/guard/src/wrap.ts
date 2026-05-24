import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { EventLogWriter, canonicalHash } from "@orrery/event-log"
import { ActionKernel, lookupTool } from "@orrery/action-kernel"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@orrery/memory-firewall"
import {
  CognitiveCore,
  EvidenceLinker,
  ExplanationGenerator,
  FsReadExtractor,
  GitStatusExtractor,
  InMemoryWorldModel,
  lookupExtractor,
  registerExtractor,
} from "@orrery/cognitive-core"
import type { ClaimExtractor, IngestResult } from "@orrery/cognitive-core"
import type {
  Action,
  ActionContract,
  Observation,
  Sensitivity,
} from "@orrery/core"
import type {
  AgentLoop,
  CallToolOptions,
  CallToolResult,
  GuardConfig,
  GuardContext,
  GuardInternals,
} from "./types"

/**
 * Register the built-in extractors if they are not already in the
 * cognitive-core registry. Idempotent across calls in the same
 * process AND across other modules that may have registered them
 * already (the telenotes example and several probes call
 * `registerBuiltInExtractors()` directly).
 *
 * The cognitive-core registry throws on duplicate `schema_key`, so we
 * cannot blindly call `registerBuiltInExtractors()` once Guard is
 * in the same process as another consumer.
 */
function ensureExtractors(): void {
  const builtins: ClaimExtractor[] = [GitStatusExtractor, FsReadExtractor]
  for (const extractor of builtins) {
    // `lookupExtractor` falls back to a `__generic__` entry if the
    // specific key is missing, so probe identity directly via the
    // returned extractor's `schema_key`.
    const present = lookupExtractor(extractor.schema_key)
    if (present && present.schema_key === extractor.schema_key) continue
    registerExtractor(extractor)
  }
}

/**
 * Map a session-level {@link Sensitivity} to the narrower
 * {@link import("@orrery/core").DataSensitivityForAction} alphabet
 * the Action Contract accepts.
 *
 *   public        → public
 *   internal      → private
 *   confidential  → private
 *   secret        → secret
 *
 * `secret` MUST round-trip — otherwise a guarded session that the
 * caller declared secret silently emits actions labelled "private",
 * and policy gates that gate on `data_sensitivity === "secret"` never
 * fire.
 */
function actionSensitivityFor(
  sensitivity: Sensitivity,
): "public" | "private" | "secret" {
  switch (sensitivity) {
    case "public":
      return "public"
    case "secret":
      return "secret"
    case "internal":
    case "confidential":
      return "private"
  }
}

/**
 * Return the stricter of two {@link Sensitivity} values.
 *
 * Used to lift an observation's sensitivity to at least the guarded
 * session's `default_sensitivity`. Never downgrades — if a tool
 * already produced an observation tagged `secret`, that label stays.
 */
function liftSensitivity(observed: Sensitivity, floor: Sensitivity): Sensitivity {
  const order: Record<Sensitivity, number> = {
    public: 0,
    internal: 1,
    confidential: 2,
    secret: 3,
  }
  return order[observed] >= order[floor] ? observed : floor
}

/**
 * Return the stricter of two action-contract data sensitivities.
 *
 * Used to clamp a caller-supplied `contract.data_sensitivity` override
 * against the floor derived from the session's `default_sensitivity`.
 * Caller overrides may RAISE the classification (e.g. one specific
 * call handles secret data even in an internal session) but may not
 * LOWER it — otherwise a hostile loop in a secret session could pass
 * `contract: { data_sensitivity: "public" }` and bypass policy gates
 * that branch on secret data.
 */
function clampActionSensitivity(
  floor: "public" | "private" | "secret",
  override: "public" | "private" | "secret" | undefined,
): "public" | "private" | "secret" {
  const order: Record<"public" | "private" | "secret", number> = {
    public: 0,
    private: 1,
    secret: 2,
  }
  if (override === undefined) return floor
  return order[override] >= order[floor] ? override : floor
}

/**
 * Wrap a user-supplied agent loop with the Orrery trust layer.
 *
 * The returned function accepts a {@link GuardConfig} and runs the
 * original loop with a {@link GuardContext} that routes:
 *
 * - every tool call through the Action Kernel (schema validation,
 *   policy gate, two-phase execution, precondition revalidation)
 * - every resulting observation through the Cognitive Core
 *   (claim extraction, evidence linking, belief adoption via the
 *   Memory Firewall)
 *
 * Each invocation creates a fresh session: a new in-memory firewall,
 * a new event-log writer pointed at the configured log root, and a
 * new session_id (unless the caller pinned one in the config).
 *
 * The wrapped function returns the loop's result; the caller can
 * inspect the session via the second return value if needed for
 * tests/probes.
 */
export function wrap<T>(
  loop: AgentLoop<T>,
): (config: GuardConfig) => Promise<GuardRunResult<T>> {
  return async (config: GuardConfig) => runGuarded(loop, config)
}

export interface GuardRunResult<T> {
  /** Whatever the agent loop returned. */
  result: T
  /** The session_id used; matches what `orrery report` expects. */
  session_id: string
  /** Where the event log was written, e.g. `<log_root>/<project_id>/<day>.ndjson`. */
  log_root: string
  /** Internal handles for tests/probes. Not stable API. */
  internals: GuardInternals
}

/**
 * Run an agent loop in one call. Equivalent to `await wrap(loop)(config)`.
 */
export async function runGuarded<T>(
  loop: AgentLoop<T>,
  config: GuardConfig,
): Promise<GuardRunResult<T>> {
  ensureExtractors()

  const session_id = config.session_id ?? `session-${Date.now()}`
  const log_root = config.log_root ?? resolve(process.cwd(), ".orrery", "events")
  const writer = new EventLogWriter(log_root)

  const claims = new InMemoryClaimStore()
  const beliefs = new InMemoryBeliefStore()
  const evidence = new InMemoryEvidenceStore()
  const worldModel = new InMemoryWorldModel()

  const emit = async (type: string, payload: unknown): Promise<void> => {
    await writer.append({
      id: randomUUID(),
      type,
      schema_version: "0.1.0",
      project_id: config.project_id,
      session_id,
      actor_id: config.actor_id,
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
  }

  const firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
    await emit(`firewall.${event.kind}`, event)
  })
  const linker = new EvidenceLinker(evidence, beliefs)
  const explanations = new ExplanationGenerator(config.actor_id)
  const cognitive = new CognitiveCore(firewall, linker, explanations, worldModel)

  /**
   * The kernel's observation sink. Called once per validated tool
   * output. Routes the observation through the cognitive core and
   * stashes the latest call's observation + ingest result in
   * `captureBox.current` so `callTool` can return them.
   *
   * Guard's documented contract is sequential `callTool`s in a single
   * session — the MCP proxy in Batch 3 introduces concurrency safety
   * (file locks, single-writer enforcement). Until then, two
   * overlapping calls in the same session is a programmer bug.
   */
  type Capture = { observation: Observation; ingest: IngestResult }
  const captureBox: { current: Capture | undefined } = { current: undefined }
  const observationSink = async (raw: Observation): Promise<void> => {
    // The Action Kernel constructs observations with hardcoded
    // session-stub / project-stub context AND a hardcoded
    // `sensitivity: "internal"` in v0 (the real propagation patch
    // lands with the MCP proxy in Batch 3). Rewrite both here so the
    // emitted event and the value returned via callTool reflect the
    // guarded session.
    //
    // Sensitivity must lift to the session's `default_sensitivity`
    // when it's stricter than the kernel's default — otherwise a
    // `secret` or `confidential` session would log/return its tool
    // observations as plain `internal` and bypass sensitivity-based
    // downstream handling (redaction, OTel export filtering, final
    // reports).
    const observation: Observation = {
      ...raw,
      context: {
        session_id,
        project_id: config.project_id,
        actor_id: config.actor_id,
      },
      sensitivity: liftSensitivity(raw.sensitivity, config.default_sensitivity),
    }
    await emit("observation.recorded", observation)
    const ingest = await cognitive.ingest({
      observation,
      context: {
        actor_id: config.actor_id,
        project_id: config.project_id,
        session_id,
        default_scope: config.default_scope,
        default_sensitivity: config.default_sensitivity,
      },
    })
    await emit("cognitive.ingested", {
      observation_id: ingest.observation_id,
      claim_count: ingest.claims.length,
      belief_count: ingest.beliefs.length,
      world_model_keys: ingest.worldModelUpdates,
    })
    for (const claim of ingest.claims) {
      await emit("claim.extracted", claim)
    }
    for (const belief of ingest.beliefs) {
      await emit("belief.adopted", belief)
    }
    captureBox.current = { observation, ingest }
  }

  const kernel = new ActionKernel(
    config.policy_gate,
    config.precondition_checker,
    observationSink,
  )

  const callTool = async <TOut = unknown>(
    toolName: string,
    inputs: unknown,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TOut>> => {
    const tool = lookupTool(toolName)
    if (!tool) {
      throw new Error(`guard.callTool: tool '${toolName}' is not registered`)
    }

    // Validate inputs once so we can hand them to the tool's
    // precondition factory below. ActionKernel.propose() re-validates
    // internally; Zod's parse is idempotent on valid data, so this is
    // not wasteful.
    const validatedInputs = tool.inputs.parse(inputs)

    // The tool's `preconditions` factory produces the contract entries
    // the kernel re-checks at execution time (the TOCTOU defense).
    // Tool-declared preconditions are NEVER discarded — even if the
    // caller passes their own override list, we prepend the tool's
    // declarations so a guarded call can only add to, not remove from,
    // what the tool author published. (Without this, an agent could
    // bypass revalidation by passing `contract: { preconditions: [] }`.)
    const overrides = options?.contract ?? {}
    const declaredPreconditions = tool.preconditions
      ? tool.preconditions(validatedInputs)
      : []
    const callerPreconditions = overrides.preconditions ?? []

    // The action contract's `data_sensitivity` alphabet is narrower
    // than session-level Sensitivity. Map deliberately so a `secret`
    // session does not silently emit `private` actions; policy gates
    // gating on secret data must see the secret classification.
    const defaultActionSensitivity = actionSensitivityFor(
      config.default_sensitivity,
    )

    const contract: ActionContract = {
      required_level: overrides.required_level ?? tool.required_trust_level,
      blast_radius: overrides.blast_radius ?? "self",
      reversibility: overrides.reversibility ?? tool.reversibility,
      scope: overrides.scope ?? config.default_scope,
      data_sensitivity: clampActionSensitivity(
        defaultActionSensitivity,
        overrides.data_sensitivity,
      ),
      preconditions: [...declaredPreconditions, ...callerPreconditions],
    }

    const proposed = kernel.propose({
      intent: options?.intent ?? `invoke ${toolName}`,
      tool: toolName,
      inputs: validatedInputs,
      contract,
      proposed_by: config.actor_id,
      decision_id: options?.decision_id,
    })
    await emit("action.proposed", proposed)

    const arbitrated = await kernel.arbitrate(proposed)
    await emit(
      arbitrated.phase === "approved" ? "action.approved" : "action.rejected",
      arbitrated,
    )

    if (arbitrated.phase !== "approved") {
      const reason = arbitrated.approval?.reason ?? "no reason given"
      throw new Error(
        `guard.callTool: action '${toolName}' rejected by policy: ${reason}`,
      )
    }

    captureBox.current = undefined
    const executed = await kernel.execute(arbitrated)
    await emit(
      executed.phase === "completed" ? "action.completed" : "action.failed",
      executed,
    )

    if (executed.phase !== "completed") {
      const detail = lastFailureDetail(executed) ?? "execution did not complete"
      throw new Error(`guard.callTool: action '${toolName}' did not complete: ${detail}`)
    }

    const captured = takeCapture(captureBox, toolName)

    return {
      output: captured.observation.payload as TOut,
      action: executed,
      observation: captured.observation,
      ingest: captured.ingest,
    }
  }

  const ctx: GuardContext = {
    project_id: config.project_id,
    session_id,
    actor_id: config.actor_id,
    default_scope: config.default_scope,
    default_sensitivity: config.default_sensitivity,
    callTool,
    ingestObservation: async (observation) => {
      await emit("observation.recorded", observation)
      const result = await cognitive.ingest({
        observation,
        context: {
          actor_id: config.actor_id,
          project_id: config.project_id,
          session_id,
          default_scope: config.default_scope,
          default_sensitivity: config.default_sensitivity,
        },
      })
      await emit("cognitive.ingested", {
        observation_id: result.observation_id,
        claim_count: result.claims.length,
        belief_count: result.beliefs.length,
        world_model_keys: result.worldModelUpdates,
      })
      for (const claim of result.claims) {
        await emit("claim.extracted", claim)
      }
      for (const belief of result.beliefs) {
        await emit("belief.adopted", belief)
      }
      return result
    },
    emit,
  }

  await emit("guard.session.started", {
    project_id: config.project_id,
    session_id,
    actor_id: config.actor_id,
    started_at: new Date().toISOString(),
  })

  let result: T
  try {
    result = await loop(ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emit("guard.session.failed", {
      reason: message,
      at: new Date().toISOString(),
    })
    throw err
  }

  await emit("guard.session.ended", {
    ended_at: new Date().toISOString(),
  })

  return {
    result,
    session_id,
    log_root,
    internals: {
      firewall,
      claims,
      beliefs,
      evidence,
      cognitive,
      worldModel,
      kernel,
    },
  }
}

function takeCapture<C>(
  box: { current: C | undefined },
  toolName: string,
): C {
  const value = box.current
  box.current = undefined
  if (value === undefined) {
    throw new Error(
      `guard.callTool: tool '${toolName}' completed without producing an observation`,
    )
  }
  return value
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
