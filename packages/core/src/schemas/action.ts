import { z } from "zod"
import { ResourceScopeSchema, TimestampSchema } from "./common"

// -----------------------------------------------------------------------------
// Trust ladder
//
// L0: observe only — read state; never write or execute
// L1: suggest only — produce proposals; nothing reaches the world
// L2: isolated artifact — generate in tempfs; no effect on project state
// L3: local reversible — modify project state with notification
// L4: external/shared — requires approval (network, credentials, deploy, push)
// L5: prohibited — cannot run in this context, ever
// -----------------------------------------------------------------------------

export const TrustLevelSchema = z.number().int().min(0).max(5)
export type TrustLevel = z.infer<typeof TrustLevelSchema>

export const BlastRadiusSchema = z.enum(["self", "session", "project", "external"])
export type BlastRadius = z.infer<typeof BlastRadiusSchema>

export const ReversibilitySchema = z.enum(["reversible", "compensable", "irreversible"])
export type Reversibility = z.infer<typeof ReversibilitySchema>

export const DataSensitivityForActionSchema = z.enum(["public", "private", "secret"])
export type DataSensitivityForAction = z.infer<typeof DataSensitivityForActionSchema>

/**
 * A precondition that must hold for an action to execute safely.
 *
 * Two-phase execution: preconditions are recorded at proposal time
 * (`expected_at_approval`) and re-checked at execution time
 * (`must_revalidate_at_execution`). If the world has changed between
 * approval and execution, the kernel re-arbitrates or rejects.
 *
 * This closes the TOCTOU gap that pure approval-then-execute leaves open.
 */
export const ActionPreconditionSchema = z.object({
  check_id: z.string().describe("e.g. 'git.head_unchanged'"),
  parameters: z.unknown(),
  expected_at_approval: z.unknown(),
  must_revalidate_at_execution: z.boolean(),
})
export type ActionPrecondition = z.infer<typeof ActionPreconditionSchema>

/**
 * The contract that gates an action through the policy kernel.
 *
 * In v0, anything with network effect, credential use, publication,
 * deploy, push, PR creation, or signing defaults to L4.
 */
export const ActionContractSchema = z.object({
  required_level: TrustLevelSchema,
  blast_radius: BlastRadiusSchema,
  reversibility: ReversibilitySchema,
  scope: ResourceScopeSchema,
  data_sensitivity: DataSensitivityForActionSchema,
  preconditions: z.array(ActionPreconditionSchema),
})
export type ActionContract = z.infer<typeof ActionContractSchema>

/**
 * Phases an action passes through.
 */
export const ActionPhaseSchema = z.enum([
  "proposed",
  "arbitrating",
  "approved",
  "rejected",
  "executing",
  "completed",
  "failed",
  "halted",
])
export type ActionPhase = z.infer<typeof ActionPhaseSchema>

/**
 * Approval event from a human or policy reviewer.
 */
export const ApprovalEventSchema = z.object({
  approver_id: z.string().describe("actor_id"),
  approved: z.boolean(),
  reason: z.string().optional(),
  at: TimestampSchema,
})
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>

/**
 * Audit trail entry for an action.
 */
export const AuditEventSchema = z.object({
  phase: ActionPhaseSchema,
  by_actor_id: z.string(),
  at: TimestampSchema,
  detail: z.string().optional(),
})
export type AuditEvent = z.infer<typeof AuditEventSchema>

/**
 * A proposed or executed side-effectful operation.
 *
 * Actions are the seventh link in the epistemic chain.
 * The phase field tracks the action through propose → arbitrate
 * → approved/rejected → executing → completed/failed/halted.
 *
 * Every Action carries an ActionContract. The Policy Kernel evaluates
 * the contract against current trust assignments and approval requirements
 * before phase advances past `arbitrating`.
 */
export const ActionSchema = z.object({
  id: z.string(),
  decision_id: z.string().optional().describe("optional link to the deciding context"),
  intent: z.string(),
  tool: z.string().describe("tool registry key, e.g. 'git.push'"),
  inputs: z.unknown().describe("validated against the tool's input schema"),
  contract: ActionContractSchema,
  phase: ActionPhaseSchema,
  approval: ApprovalEventSchema.optional(),
  audit: z.array(AuditEventSchema),
  outcome_id: z.string().optional(),
  proposed_at: TimestampSchema,
  proposed_by: z.string().describe("actor_id"),
})
export type Action = z.infer<typeof ActionSchema>

// -----------------------------------------------------------------------------
// Outcome
// -----------------------------------------------------------------------------

export const OutcomeResultSchema = z.enum(["success", "failure", "partial", "unknown"])
export type OutcomeResult = z.infer<typeof OutcomeResultSchema>

/**
 * What happened when an action executed.
 *
 * Outcomes generate new observations that re-enter the cognitive core.
 * Calibrators consume outcomes to update per-class confidence calibration.
 */
export const OutcomeSchema = z.object({
  id: z.string(),
  action_id: z.string(),
  result: OutcomeResultSchema,
  effect_observation_ids: z.array(z.string()).describe("observations capturing the effect"),
  side_effects_observed: z.array(z.string()),
  duration_ms: z.number().int().nonnegative(),
  observed_at: TimestampSchema,
})
export type Outcome = z.infer<typeof OutcomeSchema>
