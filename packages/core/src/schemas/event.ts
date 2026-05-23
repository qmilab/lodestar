import { z } from "zod"
import { SignatureSchema } from "./actor"
import { TimestampSchema } from "./common"

/**
 * Version metadata attached to every event.
 *
 * Replay-grade events need to know which model, prompt, tool version,
 * skill version, policy version, and memory snapshot were in effect
 * when the event was produced. Without this, replays cannot reproduce
 * the original conditions.
 */
export const EventVersionsSchema = z.object({
  model: z.string().optional().describe("e.g. 'claude-opus-4-7'"),
  prompt_hash: z.string().optional(),
  tool_version: z.string().optional(),
  skill_hash: z.string().optional(),
  policy_version: z.string().optional(),
  memory_snapshot_id: z.string().optional(),
  schema_registry_version: z.string().optional(),
})
export type EventVersions = z.infer<typeof EventVersionsSchema>

/**
 * The envelope every event in Orrery is wrapped in.
 *
 * Append-only. NDJSON-friendly. Replay-grade.
 *
 * - `seq` is a monotonic per-partition sequence number; used for
 *   deterministic replay ordering.
 * - `logical_clock` is a Lamport-style counter; used to reason about
 *   causality across actors within a session.
 * - `causal_parent_ids` form a DAG that lets the harness reconstruct
 *   why an event happened.
 * - `payload_hash` is sha-256 of the canonical payload; gives
 *   tamper-evidence without requiring per-event signatures.
 * - `signature` is OPTIONAL in v0. Routine internal events rely on
 *   the hash + append-only log. Signatures are required only for
 *   skills, policy versions, external imports, and secret-signing
 *   events. Adding a signature field for every event is overkill in v0.
 */
export const EventEnvelopeSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string().describe("e.g. 'action.approved', 'memory.promoted'"),
  schema_version: z.string().describe("semver of this event type"),
  project_id: z.string(),
  session_id: z.string(),
  actor_id: z.string(),
  timestamp: TimestampSchema,
  logical_clock: z.number().int().nonnegative(),
  causal_parent_ids: z.array(z.string()),
  payload_hash: z.string().describe("sha-256 hex"),
  payload: z.unknown(),
  versions: EventVersionsSchema,
  signature: SignatureSchema.optional(),
})
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>
