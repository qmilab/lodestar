import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { ApprovalOutcome } from "@qmilab/lodestar-action-kernel"
import { ActionKernel, lookupTool } from "@qmilab/lodestar-action-kernel"
import {
  CognitiveCore,
  EvidenceLinker,
  ExplanationGenerator,
  FsReadExtractor,
  GitStatusExtractor,
  InMemoryWorldModel,
  lookupExtractor,
  registerExtractor,
} from "@qmilab/lodestar-cognitive-core"
import type { ClaimExtractor, IngestResult } from "@qmilab/lodestar-cognitive-core"
import {
  type Action,
  type ActionContract,
  type ApprovalRequest,
  DecisionSchema,
  type Observation,
  type Reversibility,
  SENTINEL_ALERTED_EVENT_TYPE,
  SENTINEL_ALERTED_SCHEMA_VERSION,
  type Sensitivity,
} from "@qmilab/lodestar-core"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { holdEvaluationForParkedAction, openApprovalRequest } from "@qmilab/lodestar-policy-kernel"
import type { CompiledPolicy, PolicyEvaluation } from "@qmilab/lodestar-policy-kernel"
import type {
  AgentLoop,
  CallToolOptions,
  CallToolResult,
  GuardConfig,
  GuardContext,
  GuardInternals,
} from "./types.js"

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
 * {@link import("@qmilab/lodestar-core").DataSensitivityForAction} alphabet
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
function actionSensitivityFor(sensitivity: Sensitivity): "public" | "private" | "secret" {
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
 * Return the stricter (higher-risk) of two {@link Reversibility} values.
 *
 * The tool author publishes a reversibility classification at
 * registration time; the caller can RAISE the risk (e.g. claim that
 * one specific invocation should be treated as irreversible) but may
 * not LOWER it. Without this clamp, a hostile loop could pass
 * `contract: { reversibility: "reversible" }` for an irreversible
 * tool and bypass policies that gate on reversibility.
 *
 * Risk ordering:
 *   reversible  (lowest risk — can be undone)
 *   compensable (medium — needs a compensating action to undo)
 *   irreversible (highest risk — cannot be undone)
 */
function clampReversibility(
  floor: Reversibility,
  override: Reversibility | undefined,
): Reversibility {
  const order: Record<Reversibility, number> = {
    reversible: 0,
    compensable: 1,
    irreversible: 2,
  }
  if (override === undefined) return floor
  return order[override] >= order[floor] ? override : floor
}

/**
 * Wrap a user-supplied agent loop with the Lodestar trust layer.
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
export function wrap<T>(loop: AgentLoop<T>): (config: GuardConfig) => Promise<GuardRunResult<T>> {
  return async (config: GuardConfig) => runGuarded(loop, config)
}

export interface GuardRunResult<T> {
  /** Whatever the agent loop returned. */
  result: T
  /** The session_id used; matches what `lodestar report` expects. */
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

  // Default session_id uses randomUUID(), not Date.now() — `Date.now()`
  // can return the same millisecond value across rapid or concurrent
  // `runGuarded` calls, and since `lodestar report` slices the event log
  // by session_id only, collisions would merge two distinct guarded
  // runs into the same report.
  const session_id = config.session_id ?? `session-${randomUUID()}`
  const log_root = config.log_root ?? resolve(process.cwd(), ".lodestar", "events")
  const writer = new EventLogWriter(log_root)

  // Caller-injected stores (e.g. Postgres, for cross-session durability)
  // take precedence over the per-session in-memory default. `runGuarded`
  // never owns an injected store's connection — the caller closes it.
  const claims = config.stores?.claims ?? new InMemoryClaimStore()
  const beliefs = config.stores?.beliefs ?? new InMemoryBeliefStore()
  const evidence = config.stores?.evidence ?? new InMemoryEvidenceStore()
  const worldModel = new InMemoryWorldModel()

  const emit = async (
    type: string,
    payload: unknown,
    options?: {
      causal_parent_ids?: string[]
      feedArbiter?: boolean
      actor_id?: string
      schema_version?: string
    },
  ): Promise<void> => {
    const envelope = await writer.append({
      id: randomUUID(),
      type,
      // Most guard status/chain events ride the session schema version; an event
      // with its own governance schema (e.g. `sentinel.alerted@1`) overrides it so
      // consumers validating by type/version see the canonical version.
      schema_version: options?.schema_version ?? "0.1.0",
      project_id: config.project_id,
      session_id,
      // Defaults to the governed agent; a `sentinel.alerted@1` re-emit overrides
      // it with the sentinel actor so the audit shows who authored the alert.
      actor_id: options?.actor_id ?? config.actor_id,
      timestamp: new Date().toISOString(),
      causal_parent_ids: options?.causal_parent_ids ?? [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
    // Sentinel→action arbitration. Feed the written event to the arbiter (which
    // runs the sentinels and projects belief.adopted / decision.made), then emit
    // any alert it surfaces as `sentinel.alerted@1` on this same writer — so the
    // guarded session stays the sole writer of its log. Done AFTER `append`
    // resolves: the partition mutex is released before the re-entrant
    // `sentinel.alerted` emit appends, and the alert lands in the buffer/log
    // before the next action arbitrates (the gate's `resolveContext` reads it).
    // The arbiter skips `sentinel.alerted` events, so the re-entry bottoms out at
    // depth one for any sentinel set.
    //
    // ONLY host-authored events reach the arbiter: `feedArbiter` defaults to true
    // for guard's own emits, but the agent-facing `ctx.emit` passes `false`. That
    // is the security boundary — otherwise an agent loop could forge a
    // `guard.session.ended` (clearing buffered alerts) or a `belief.adopted`
    // (overwriting a flagged belief) to bypass the gate it is subject to. The
    // agent declares decisions through the trusted `ctx.recordDecision` channel,
    // which routes back through this host emit (PR #54 review, Codex P1).
    //
    // The whole feed is best-effort: sentinel arbitration is a non-blocking
    // observability + advisory layer ("sentinels alert; they never block"), so a
    // faulty/hostile sentinel — or a finding that fails schema validation — must
    // NOT abort the governed session. On a fault, record a `guard.sentinel.failed`
    // status event (appended DIRECTLY, so it can't re-enter the arbiter and
    // recurse) and continue; the epistemic chain is unaffected, only this one
    // alert pass is lost (PR #54 review, F2).
    if (config.arbiter !== undefined && options?.feedArbiter !== false) {
      try {
        const alerts = await config.arbiter.observe(envelope)
        for (const alert of alerts) {
          await emit(SENTINEL_ALERTED_EVENT_TYPE, alert.payload, {
            causal_parent_ids: alert.causal_parent_ids,
            feedArbiter: false,
            // Attribute the alert to the sentinel actor, not the governed agent,
            // and stamp the canonical sentinel.alerted schema version (not the
            // generic session version) so it matches the harness alert sink.
            actor_id: config.arbiter.actorId,
            schema_version: SENTINEL_ALERTED_SCHEMA_VERSION,
          })
        }
      } catch (err) {
        const failure = {
          for_event_id: envelope.id,
          for_event_type: envelope.type,
          error: err instanceof Error ? err.message : String(err),
        }
        await writer
          .append({
            id: randomUUID(),
            type: "guard.sentinel.failed",
            schema_version: "0.1.0",
            project_id: config.project_id,
            session_id,
            actor_id: config.actor_id,
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

  const firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
    // Honour `causal_parent_ids` when the firewall audit event carries
    // it — reflection-driven transitions cite the `reflection.completed`
    // event id this way (design doc Q4).
    const causal_parent_ids =
      "causal_parent_ids" in event && event.causal_parent_ids ? event.causal_parent_ids : undefined
    await emit(
      `firewall.${event.kind}`,
      event,
      causal_parent_ids ? { causal_parent_ids } : undefined,
    )
  })
  // Evidence linking is the one Cognitive-Core seam guard exposes: a
  // caller can inject a custom linker (document-aware, MCP-aware,
  // LLM-driven) via `config.cognitive.evidenceLinkerFactory`. The factory
  // receives this session's stores so the linker persists into the same
  // evidence store the firewall reads. Defaults to the built-in linker.
  const linker = config.cognitive?.evidenceLinkerFactory
    ? config.cognitive.evidenceLinkerFactory({ evidence, beliefs })
    : new EvidenceLinker(evidence, beliefs)
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
    // Use the lifted observation sensitivity (which already accounts
    // for both the kernel-derived contract sensitivity and the
    // session floor) as the ingest default. Otherwise per-call
    // overrides — e.g. a secret-classified tool call inside an
    // internal session — would extract claims labelled `internal`
    // and bypass downstream retrieval / redaction.
    const ingest = await cognitive.ingest({
      observation,
      context: {
        actor_id: config.actor_id,
        project_id: config.project_id,
        session_id,
        default_scope: config.default_scope,
        default_sensitivity: observation.sensitivity,
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
    // Emit the evidence set(s) the cognitive core just produced — one
    // emit per evidence id, deduped because the same set can show up
    // for multiple beliefs that share a claim. Without this the trust
    // report has no way to audit why a belief was adopted: the firewall
    // checks evidence against in-memory stores that disappear after
    // the session ends.
    const emittedEvidenceIds = new Set<string>()
    for (const belief of ingest.beliefs) {
      const sets = await evidence.forClaim(belief.claim_id)
      for (const set of sets) {
        if (emittedEvidenceIds.has(set.id)) continue
        emittedEvidenceIds.add(set.id)
        await emit("evidence.assessed", set)
      }
    }
    for (const belief of ingest.beliefs) {
      await emit("belief.adopted", belief)
    }
    captureBox.current = { observation, ingest }
  }

  // `policy_gate` may be a bare PolicyGate function or a CompiledPolicy. The
  // kernel only ever needs the gate; a CompiledPolicy additionally lets the
  // hold path below re-run its pure `evaluate()` to recover a held rule's
  // `required_authority` for the opened ApprovalRequest.
  const policyGate =
    typeof config.policy_gate === "function" ? config.policy_gate : config.policy_gate.gate
  const compiledPolicy: CompiledPolicy | undefined =
    typeof config.policy_gate === "function" ? undefined : config.policy_gate

  // Propagate the guarded session/project ids into every
  // `tool.execute(inputs, ctx)` call so custom tools that scope side
  // effects by session_id / project_id (logging, temp dirs, capability
  // tokens) see the real values rather than the kernel's stubs.
  const kernel = new ActionKernel(policyGate, config.precondition_checker, observationSink, () => ({
    session_id,
    project_id: config.project_id,
  }))

  /**
   * Resolve an action the policy held for approval. In-process the hold can
   * simply await the configured {@link GuardConfig.approval_resolver}; there is
   * no deadline (that is the MCP proxy's concern). Emits the canonical
   * `approval.requested@1` for the parked action, then the resolver's
   * `approval.granted@1` / `approval.denied@1` / `approval.expired@1`, and
   * returns the un-parked action (`approved` on a grant, `rejected` otherwise).
   * `ActionKernel.resolve()` validates that the outcome is bound to this action.
   */
  const resolveHold = async (parked: Action, toolName: string): Promise<Action> => {
    // Record that the action reached `pending_approval` (with its audit) before
    // anything below can throw, so the parked state is always in the event
    // stream — a report or approval UI reads the parked Action directly, not
    // only inferred from the request.
    await emit("action.pending_approval", parked)
    if (config.approval_resolver === undefined) {
      throw new Error(
        `guard.callTool: action '${toolName}' was held for approval (pending_approval) but no approval_resolver was configured. A policy that can hold must say who resolves the hold.`,
      )
    }
    // Recover the hold's `required_authority`. A CompiledPolicy can re-run its
    // pure evaluate() to read a matched rule's authority — but ONLY for a
    // contract+rule hold: an arbitration-escalated hold (sentinel / calibration
    // / low-confidence) is invisible to a context-free re-run (see gate.ts), so
    // evaluate() returns the base verdict (e.g. allow). Default to the parked
    // action's audit (always a hold) and upgrade to the compiled evaluation only
    // when it agrees the verdict is a hold — so every kind of hold opens a
    // request rather than throwing on a non-hold re-evaluation.
    let evaluation: PolicyEvaluation = holdEvaluationForParkedAction(parked)
    if (compiledPolicy) {
      const reevaluated = compiledPolicy.evaluate(parked)
      if (reevaluated.verdict === "hold") evaluation = reevaluated
    }
    const request = openApprovalRequest(parked, evaluation)
    await emit("approval.requested", request)

    const outcome = await config.approval_resolver(request)
    // Apply (and validate the binding) first, so the canonical `at` comes from
    // the kernel transition and a mis-bound outcome throws before we log it.
    const resolved = kernel.resolve(parked, outcome)
    const at = resolved.approval?.at ?? new Date().toISOString()
    await emit(`approval.${outcome.kind}`, approvalEventPayload(outcome, request, at))
    return resolved
  }

  const callTool = async <TOut = unknown>(
    toolName: string,
    inputs: unknown,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TOut>> => {
    const tool = lookupTool(toolName)
    if (!tool) {
      throw new Error(`guard.callTool: tool '${toolName}' is not registered`)
    }

    // Build the action contract from session defaults + caller
    // overrides. Tool-declared preconditions are merged in by the
    // kernel (so the inputs are parsed exactly once — schemas with
    // `.transform`/`.preprocess` are not necessarily idempotent under
    // repeated parse).
    const overrides = options?.contract ?? {}
    const callerPreconditions = overrides.preconditions ?? []

    // The action contract's `data_sensitivity` alphabet is narrower
    // than session-level Sensitivity. Map deliberately so a `secret`
    // session does not silently emit `private` actions; policy gates
    // gating on secret data must see the secret classification.
    const defaultActionSensitivity = actionSensitivityFor(config.default_sensitivity)

    const contract: ActionContract = {
      required_level: overrides.required_level ?? tool.required_trust_level,
      blast_radius: overrides.blast_radius ?? "self",
      reversibility: clampReversibility(tool.reversibility, overrides.reversibility),
      scope: overrides.scope ?? config.default_scope,
      data_sensitivity: clampActionSensitivity(
        defaultActionSensitivity,
        overrides.data_sensitivity,
      ),
      preconditions: callerPreconditions,
    }

    const proposed = kernel.propose({
      intent: options?.intent ?? `invoke ${toolName}`,
      tool: toolName,
      inputs,
      contract,
      proposed_by: config.actor_id,
      decision_id: options?.decision_id,
    })
    await emit("action.proposed", proposed)

    const arbitrated = await kernel.arbitrate(proposed)
    // Three-valued gate: a held action is parked at `pending_approval`. Resolve
    // it through the in-process resolver seam (open request → await resolver →
    // un-park) before the approved/rejected emit, so the rest of the flow sees
    // a settled phase exactly as it did pre-Policy-Kernel.
    const settled =
      arbitrated.phase === "pending_approval" ? await resolveHold(arbitrated, toolName) : arbitrated
    await emit(settled.phase === "approved" ? "action.approved" : "action.rejected", settled)

    if (settled.phase !== "approved") {
      const reason = settled.approval?.reason ?? "no reason given"
      throw new Error(`guard.callTool: action '${toolName}' rejected by policy: ${reason}`)
    }

    captureBox.current = undefined
    const executed = await kernel.execute(settled)
    // `kernel.execute` can finish in three distinguishable phases:
    //   completed → tool ran, observation produced
    //   rejected  → precondition revalidation killed the action
    //               (a policy decision, not an execution failure)
    //   failed    → tool.execute threw or the kernel hit a structural error
    // Consumers filtering the event log by type need to tell these
    // apart — flattening rejected → failed would conflate TOCTOU
    // rejections with genuine tool failures.
    const finalEventType =
      executed.phase === "completed"
        ? "action.completed"
        : executed.phase === "rejected"
          ? "action.rejected"
          : "action.failed"
    await emit(finalEventType, executed)

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
    ingestObservation: async (raw) => {
      // Apply the same context rewrite + sensitivity lift the kernel
      // observation sink does, so an observation copied from a
      // webhook or another source can't leak a foreign session/project
      // id into the event log, and can't record at a lower sensitivity
      // than the guarded session.
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
      // Match the kernel sink path: extract claims at the lifted
      // observation sensitivity, not the session default, so a
      // foreign-source observation carrying a strict label is
      // honoured for downstream retrieval/redaction.
      const result = await cognitive.ingest({
        observation,
        context: {
          actor_id: config.actor_id,
          project_id: config.project_id,
          session_id,
          default_scope: config.default_scope,
          default_sensitivity: observation.sensitivity,
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
      // Emit evidence sets alongside beliefs (deduped) — see the
      // observation sink above for the rationale.
      const seenEvidenceIds = new Set<string>()
      for (const belief of result.beliefs) {
        const sets = await evidence.forClaim(belief.claim_id)
        for (const set of sets) {
          if (seenEvidenceIds.has(set.id)) continue
          seenEvidenceIds.add(set.id)
          await emit("evidence.assessed", set)
        }
      }
      for (const belief of result.beliefs) {
        await emit("belief.adopted", belief)
      }
      return result
    },
    // The agent-facing escape hatch logs an event but is NOT trusted to drive
    // sentinel arbitration: `feedArbiter: false` keeps a raw agent emit (e.g. a
    // forged `guard.session.ended` or `belief.adopted`) out of the arbiter, so an
    // agent cannot reset or poison the enforcement state it is subject to.
    emit: (type, payload) => emit(type, payload, { feedArbiter: false }),
    recordDecision: async (decision) => {
      // The trusted channel for an agent to declare a decision's
      // `belief_dependencies`. Validated, then emitted as a host-authored
      // `decision.made` that DOES feed the arbiter — this is how a belief-scoped
      // sentinel alert finds the action that depends on the flagged belief.
      const validated = DecisionSchema.parse(decision)
      await emit("decision.made", validated)
    },
  }

  // Bind the arbiter to this session before any event flows, so `resolveContext`
  // reports THIS session (never "whichever was observed last") and a second
  // concurrent guarded session sharing the same arbiter is rejected loudly here
  // rather than silently cross-talking (Codex review, round 2).
  config.arbiter?.bindSession(session_id)

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

/**
 * Map an applied {@link ApprovalOutcome} onto the matching `approval.*` event
 * payload. The event *type* carries the verdict, so there is no `approved`
 * boolean; `approval.expired` carries no `approver_id`; optional `reason` is
 * omitted entirely when unset (never `undefined`) so the writer's `canonicalHash`
 * and `JSON.stringify` agree on re-read — the discipline the core
 * `approval.*` schemas hold.
 */
function approvalEventPayload(
  outcome: ApprovalOutcome,
  request: ApprovalRequest,
  at: string,
): Record<string, unknown> {
  if (outcome.kind === "expired") {
    return { request_id: request.request_id, action_id: request.action_id, at }
  }
  const payload: Record<string, unknown> = {
    request_id: request.request_id,
    action_id: request.action_id,
    approver_id: outcome.approver_id,
    at,
  }
  if (outcome.reason !== undefined) payload.reason = outcome.reason
  return payload
}

function takeCapture<C>(box: { current: C | undefined }, toolName: string): C {
  const value = box.current
  box.current = undefined
  if (value === undefined) {
    throw new Error(`guard.callTool: tool '${toolName}' completed without producing an observation`)
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
