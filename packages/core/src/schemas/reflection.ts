import { z } from "zod"
import { TimestampSchema } from "./common.js"
import { TruthStatusSchema } from "./belief.js"

/**
 * What triggered a reflection pass.
 *
 * `cli` — invoked by `lodestar reflect` from a human operator.
 * `programmatic` — invoked from host code (e.g. runGuarded, the MCP
 *   proxy) at a deliberate point.
 * `tail_cascade` — a `belief.transitioned` event recorded a transition
 *   to `truth_status: contradicted`; the tail watcher dispatched a
 *   pass to look for dependent fall-out.
 * `tail_batch` — N `belief.adopted` events have accrued since the
 *   last pass for the partition (configurable batch size).
 * `sentinel` — a `sentinel.alerted` event named a `belief_id` as
 *   subject; the sentinel asked reflection to follow up.
 */
export const ReflectionTriggerSchema = z.enum([
  "cli",
  "programmatic",
  "tail_cascade",
  "tail_batch",
  "sentinel",
])
export type ReflectionTrigger = z.infer<typeof ReflectionTriggerSchema>

/**
 * The lifecycle axes a reflection proposal can target. Mirrors
 * `LifecycleAxis` in `@qmilab/lodestar-memory-firewall` deliberately —
 * the core package cannot import from downstream packages, so the
 * literal union is duplicated here. Keep these in sync.
 */
export const ReflectionLifecycleAxisSchema = z.enum([
  "truth_status",
  "retrieval_status",
  "security_status",
  "freshness_status",
])
export type ReflectionLifecycleAxis = z.infer<typeof ReflectionLifecycleAxisSchema>

/**
 * Subject of a `no_op` proposal — reflection looked at this thing
 * and decided no change. Recorded so the audit trail distinguishes
 * "reflection considered X and did nothing" from "reflection did
 * not consider X."
 */
export const ReflectionSubjectSchema = z.object({
  kind: z.enum(["belief", "claim", "decision"]),
  id: z.string(),
})
export type ReflectionSubject = z.infer<typeof ReflectionSubjectSchema>

/**
 * One typed proposal from a reflection pass.
 *
 * Proposals are *suggestions*. They do not mutate state. When a
 * proposal is acted on, the runner calls the existing MemoryFirewall
 * API with `by_authority: "reflection"`, and the firewall emits its
 * own normal `belief.adopted` / `belief.transitioned` event whose
 * `causal_parent_ids` includes the reflection pass's event id.
 *
 * The `rationale_id` on every variant points to an Explanation the
 * runner generated alongside the proposal — same shape as the
 * Explanations the firewall consumes for transitions.
 */
export const ReflectionProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claim_promotion"),
    claim_id: z.string(),
    target_truth_status: TruthStatusSchema,
    evidence_id: z.string(),
    rationale_id: z.string(),
  }),
  z.object({
    kind: z.literal("belief_transition"),
    belief_id: z.string(),
    axis: ReflectionLifecycleAxisSchema,
    from_value: z.string(),
    to_value: z.string(),
    evidence_id: z.string().optional(),
    rationale_id: z.string(),
  }),
  z.object({
    kind: z.literal("belief_supersession"),
    old_belief_id: z.string(),
    new_belief_id: z.string(),
    rationale_id: z.string(),
  }),
  /**
   * The decision-dependency cascade. When a belief that a past
   * Decision depended on transitions to `truth_status: contradicted`,
   * reflection proposes flagging that Decision as having a contradicted
   * dependency. Applying the proposal emits a Revision event with
   * `target_type: "decision"` so the decision's epistemic status
   * change is recorded in the audit chain. (Closes the Batch-2-deferred
   * "contradicted belief flags dependent decisions" invariant.)
   */
  z.object({
    kind: z.literal("decision_dependency_flagged"),
    decision_id: z.string(),
    contradicted_belief_id: z.string(),
    rationale_id: z.string(),
  }),
  z.object({
    kind: z.literal("no_op"),
    subject: ReflectionSubjectSchema,
    rationale_id: z.string(),
  }),
])
export type ReflectionProposal = z.infer<typeof ReflectionProposalSchema>

/**
 * The payload of a `reflection.completed@1` event.
 *
 * Idempotence is by cursor: a pass over events with `seq` strictly
 * greater than `cursor.from_seq` and less than or equal to
 * `cursor.to_seq` produces the same proposals on re-run. Re-running
 * is safe — proposals are typed, no state has been mutated, and the
 * harness can compare proposal sets across runs.
 *
 * `observed_event_ids` lists every event the pass actually read.
 * `proposals` is non-empty in v0 — a pass that found nothing to act
 * on emits a `no_op` proposal for at least one subject it inspected,
 * so the harness can distinguish "ran and silent" from "did not run."
 */
export const ReflectionCompletedPayloadSchema = z.object({
  pass_id: z.string(),
  triggered_by: ReflectionTriggerSchema,
  cursor: z.object({
    from_seq: z.number().int().min(-1).describe("-1 if this is the first pass for the partition"),
    to_seq: z.number().int().min(-1).describe(
      "Equal to from_seq when the window is empty — the pass ran but observed no new events. " +
        "Encoded explicitly (rather than skipping emission) so the audit chain can distinguish " +
        "'reflection ran and was silent' from 'reflection did not run.'",
    ),
  }),
  observed_event_ids: z.array(z.string()),
  proposals: z.array(ReflectionProposalSchema).min(1, "every reflection pass emits at least one proposal (no_op counts)"),
  started_at: TimestampSchema,
  finished_at: TimestampSchema,
})
export type ReflectionCompletedPayload = z.infer<typeof ReflectionCompletedPayloadSchema>

/**
 * Event-type literal. Use this constant rather than the bare string
 * so a future rename is grep-safe.
 */
export const REFLECTION_COMPLETED_EVENT_TYPE = "reflection.completed" as const
export const REFLECTION_COMPLETED_SCHEMA_VERSION = "1" as const
