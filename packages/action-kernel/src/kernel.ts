import { randomUUID } from "node:crypto"
import { type Action, type ActionContract, type ActionPrecondition, type Observation, registry } from "@orrery/core"
import { lookupTool, type Tool } from "./registry"

/**
 * The policy gate interface. The action kernel does not implement policy
 * itself — that lives in @orrery/policy-kernel. The kernel calls into
 * a PolicyGate function to arbitrate every action.
 *
 * Returning `approved: true` lets execution proceed. Returning `false`
 * with a reason halts at the arbitrating phase.
 */
export type PolicyGate = (action: Action) => Promise<PolicyDecision>

export interface PolicyDecision {
  approved: boolean
  reason: string
  approver_id: string
  requires_human_approval?: boolean
}

/**
 * Re-check a precondition. Returns true if the precondition still holds.
 * The PreconditionChecker is provided by the kernel's host so it can
 * interrogate the live world state.
 */
export type PreconditionChecker = (
  check: ActionPrecondition,
) => Promise<{ holds: boolean; observed: unknown }>

/**
 * The kernel's two-phase execution loop.
 *
 * propose -> arbitrate -> approved/rejected -> [revalidate preconditions]
 * -> executing -> completed/failed
 *
 * Side-effect discipline:
 * - propose phase MUST be pure data construction
 * - tool.execute is the ONLY path to side effects
 * - if a tool performs side effects during validation, that is a bug
 *
 * TOCTOU defense:
 * - preconditions marked must_revalidate_at_execution are re-checked
 *   immediately before tool.execute is invoked
 * - if a precondition no longer holds, the action is rejected even if
 *   it was previously approved
 */
/**
 * Resolve the `session_id` / `project_id` the host wants tools to see
 * inside their `ToolContext`. Without a resolver, the kernel falls
 * back to `"session-stub"` / `"project-stub"` placeholders — fine for
 * unit tests, broken for any tool that scopes side effects by
 * session or project. Hosts (@orrery/guard, the eventual MCP proxy)
 * MUST supply a resolver in production.
 */
export type ToolContextResolver = () => {
  session_id: string
  project_id: string
}

export class ActionKernel {
  constructor(
    private readonly policyGate: PolicyGate,
    private readonly preconditionChecker: PreconditionChecker,
    private readonly observationSink: (obs: Observation) => Promise<void>,
    private readonly contextResolver?: ToolContextResolver,
  ) {}

  /**
   * Propose an action. Returns the action in `proposed` phase, without
   * executing it. Caller then invokes `arbitrate` and, if approved,
   * `execute`.
   */
  propose(input: {
    decision_id?: string
    intent: string
    tool: string
    inputs: unknown
    contract: ActionContract
    proposed_by: string
  }): Action {
    const tool = lookupTool(input.tool)
    if (!tool) {
      throw new Error(`action-kernel: unknown tool '${input.tool}'`)
    }

    // Validate inputs against the tool schema at propose time.
    // The kernel refuses to even queue an action with malformed inputs.
    const parsedInputs = tool.inputs.parse(input.inputs)

    // Tool's required trust level is a floor on the contract's required level.
    if (input.contract.required_level < tool.required_trust_level) {
      throw new Error(
        `action-kernel: contract trust level ${input.contract.required_level} is below tool '${tool.name}' minimum ${tool.required_trust_level}`,
      )
    }

    const action: Action = {
      id: randomUUID(),
      decision_id: input.decision_id,
      intent: input.intent,
      tool: input.tool,
      inputs: parsedInputs,
      contract: input.contract,
      phase: "proposed",
      audit: [
        {
          phase: "proposed",
          by_actor_id: input.proposed_by,
          at: new Date().toISOString(),
        },
      ],
      proposed_at: new Date().toISOString(),
      proposed_by: input.proposed_by,
    }
    return action
  }

  /**
   * Arbitrate an action via the policy gate. Returns the action in
   * `approved` or `rejected` phase.
   */
  async arbitrate(action: Action): Promise<Action> {
    if (action.phase !== "proposed") {
      throw new Error(`action-kernel: cannot arbitrate from phase '${action.phase}'`)
    }
    const inArbitration: Action = {
      ...action,
      phase: "arbitrating",
      audit: [
        ...action.audit,
        { phase: "arbitrating", by_actor_id: "system", at: new Date().toISOString() },
      ],
    }
    const decision = await this.policyGate(inArbitration)
    return {
      ...inArbitration,
      phase: decision.approved ? "approved" : "rejected",
      approval: {
        approver_id: decision.approver_id,
        approved: decision.approved,
        reason: decision.reason,
        at: new Date().toISOString(),
      },
      audit: [
        ...inArbitration.audit,
        {
          phase: decision.approved ? "approved" : "rejected",
          by_actor_id: decision.approver_id,
          at: new Date().toISOString(),
          detail: decision.reason,
        },
      ],
    }
  }

  /**
   * Execute an approved action. Re-validates preconditions at execution
   * time before invoking the tool. If any precondition no longer holds,
   * the action is rejected even if previously approved.
   */
  async execute(action: Action): Promise<Action> {
    if (action.phase !== "approved") {
      throw new Error(`action-kernel: cannot execute from phase '${action.phase}'`)
    }

    // Precondition revalidation — the TOCTOU defense
    for (const pre of action.contract.preconditions) {
      if (!pre.must_revalidate_at_execution) continue
      const check = await this.preconditionChecker(pre)
      if (!check.holds) {
        return {
          ...action,
          phase: "rejected",
          audit: [
            ...action.audit,
            {
              phase: "rejected",
              by_actor_id: "system",
              at: new Date().toISOString(),
              detail: `precondition '${pre.check_id}' no longer holds; expected ${JSON.stringify(pre.expected_at_approval)}, observed ${JSON.stringify(check.observed)}`,
            },
          ],
        }
      }
    }

    const tool = lookupTool(action.tool)
    if (!tool) {
      throw new Error(`action-kernel: unknown tool '${action.tool}' at execution time`)
    }

    const executing: Action = {
      ...action,
      phase: "executing",
      audit: [
        ...action.audit,
        { phase: "executing", by_actor_id: "system", at: new Date().toISOString() },
      ],
    }

    // Resolve session/project context once per execute call. Hosts
    // (Guard, the MCP proxy) supply a resolver; tests/probes may rely
    // on the stub fallback. Capability wiring for secret-handling
    // tools lives in the policy kernel, not here.
    const resolved = this.contextResolver?.() ?? {
      session_id: "session-stub",
      project_id: "project-stub",
    }
    const toolCtxSessionId = resolved.session_id
    const toolCtxProjectId = resolved.project_id

    try {
      const result = await tool.execute(executing.inputs, {
        session_id: toolCtxSessionId,
        project_id: toolCtxProjectId,
        actor_id: executing.proposed_by,
        capabilities: new Map(),
      })

      // Validate the tool's output against the registered schema.
      // This is what prevents free-form strings from entering cognition.
      const outputSchema = registry.lookup(tool.output_schema_key)
      if (!outputSchema) {
        throw new Error(
          `action-kernel: tool '${tool.name}' references unregistered output schema '${tool.output_schema_key}'`,
        )
      }
      const validatedOutput = outputSchema.parse(result)

      // Construct the observation and route it to the cognitive core.
      const obs: Observation = {
        id: randomUUID(),
        schema: tool.output_schema_key,
        payload: validatedOutput,
        source: {
          tool: tool.name,
          invocation_id: executing.id,
          captured_at: new Date().toISOString(),
        },
        context: {
          session_id: toolCtxSessionId,
          project_id: toolCtxProjectId,
          actor_id: executing.proposed_by,
        },
        trust: "validated",
        sensitivity: "internal", // default; tool can override via contract metadata in later versions
      }
      await this.observationSink(obs)

      return {
        ...executing,
        phase: "completed",
        audit: [
          ...executing.audit,
          { phase: "completed", by_actor_id: "system", at: new Date().toISOString() },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ...executing,
        phase: "failed",
        audit: [
          ...executing.audit,
          {
            phase: "failed",
            by_actor_id: "system",
            at: new Date().toISOString(),
            detail: message,
          },
        ],
      }
    }
  }
}

/**
 * Re-export Tool for callers that want to register tools alongside
 * constructing the kernel.
 */
export type { Tool }
