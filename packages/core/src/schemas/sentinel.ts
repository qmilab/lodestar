import { z } from "zod"
import { TimestampSchema } from "./common.js"

/**
 * Sentinel alerts — the wire format a Sentinel emits when it pattern-matches
 * a suspicious shape in the event stream.
 *
 * Design lock: `docs/architecture/sentinels.md` (and Q7 of
 * `docs/architecture/reflection-pass.md`, which settled the execution model).
 * The short version:
 *
 * - Sentinels are an async tail of the event stream. They never block the
 *   Action Kernel; they emit `sentinel.alerted@1` events and a future
 *   (additive) `arbitrate` hook honours them on the *next* action that
 *   depends on a flagged subject.
 * - This is a governance event, not an Observation. Like
 *   `reflection.completed@1`, the payload is the event payload directly and
 *   is NOT registered in the observation schema registry.
 *
 * Core owns the wire format only. The base class, the runner, and the
 * concrete sentinels live in `@qmilab/lodestar-harness`.
 */

/**
 * What a sentinel alert is *about*. Kept deliberately small — the four
 * epistemic-chain nouns a v0 sentinel can point at.
 *
 * `belief` is the load-bearing kind for the eventual kernel hook: the
 * `arbitrate` lookup scopes recent alerts to a candidate action's
 * `belief_dependencies`, so a sentinel that names a belief gates the next
 * action that leans on it. `tool_sequence` is a synthetic subject — its
 * `id` identifies the *completion* of a matched sequence (the id of the
 * final action in the run), since no single chain-noun owns the pattern.
 */
export const SentinelSubjectSchema = z.object({
  kind: z.enum(["belief", "action", "decision", "tool_sequence"]),
  id: z.string().min(1),
})
export type SentinelSubject = z.infer<typeof SentinelSubjectSchema>

/**
 * Triage weight. `critical` is reserved for patterns that, left unflagged,
 * map onto a concrete attack (e.g. the read → external-egress → write
 * exfiltration shape). `warning` is the default for "under-supported but
 * not obviously hostile". `info` is for advisory signal a calibrator may
 * later promote or demote.
 */
export const SentinelSeveritySchema = z.enum(["info", "warning", "critical"])
export type SentinelSeverity = z.infer<typeof SentinelSeveritySchema>

/**
 * The payload of a `sentinel.alerted@1` event.
 *
 * `observed_event_ids` lists exactly the events the sentinel read to reach
 * this conclusion; they are also the alert envelope's `causal_parent_ids`,
 * so `lodestar report` can walk back from an alert to the events that
 * triggered it.
 *
 * `detail` is rule-specific structured context (offending belief ids, the
 * matched tool run, the confidence that tripped the floor, …). It is a
 * record rather than a discriminated union so a new sentinel can ship
 * without a core schema bump; the human-readable `message` is always
 * present so an alert is legible without decoding `detail`.
 *
 * Every field is required (no optionals besides `rationale_id`) so the
 * event-log writer's canonical hash and `JSON.stringify` never disagree on
 * a dropped `undefined` key — the same discipline the firewall audit
 * events follow.
 */
export const SentinelAlertPayloadSchema = z.object({
  alert_id: z.string().min(1),
  sentinel_name: z.string().min(1).describe("Stable name of the emitting sentinel."),
  rule: z
    .string()
    .min(1)
    .describe("Stable id of the specific rule/pattern that fired within the sentinel."),
  severity: SentinelSeveritySchema,
  subject: SentinelSubjectSchema,
  message: z.string().min(1).describe("Human-readable account of what tripped the sentinel."),
  observed_event_ids: z
    .array(z.string())
    .min(1)
    .describe("The events the sentinel read to reach this alert; also the alert's causal parents."),
  detail: z
    .record(z.string(), z.unknown())
    .describe("Rule-specific structured context. May be empty; never undefined."),
  detected_at: TimestampSchema,
  /**
   * Reserved. A sentinel may attach a generated Explanation id here, the
   * way reflection proposals carry one. v0 sentinels rely on `message` +
   * `detail` and leave this unset (omitted entirely, not `undefined`, so
   * the canonical hash stays stable).
   */
  rationale_id: z.string().optional(),
})
export type SentinelAlertPayload = z.infer<typeof SentinelAlertPayloadSchema>

/**
 * Event-type literal and version. Use the constants rather than the bare
 * string so a future rename is grep-safe — same convention as
 * `REFLECTION_COMPLETED_EVENT_TYPE`.
 */
export const SENTINEL_ALERTED_EVENT_TYPE = "sentinel.alerted" as const
export const SENTINEL_ALERTED_SCHEMA_VERSION = "1" as const
