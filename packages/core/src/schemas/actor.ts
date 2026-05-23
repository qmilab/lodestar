import { z } from "zod"
import { ResourceScopeSchema, SensitivitySchema, TimestampSchema } from "./common"

/**
 * Kinds of actor that can produce events in the system.
 * Every Observation, Claim, Decision, Action, and Revision records its actor.
 */
export const ActorKindSchema = z.enum([
  "human",
  "agent",
  "tool",
  "probe",
  "sentinel",
  "system",
  "imported",
])
export type ActorKind = z.infer<typeof ActorKindSchema>

/**
 * Identity record for any entity that can act in the system.
 *
 * Sensitivity clearance bounds what content the actor may handle.
 * Trust baseline is the default credibility weight for assertions
 * by this actor; the Calibrator can adjust per-class trust over time.
 */
export const ActorSchema = z.object({
  id: z.string().describe("uuid-shaped identifier"),
  kind: ActorKindSchema,
  display_name: z.string(),
  authority_scope: z.array(ResourceScopeSchema).describe("scopes this actor may operate within"),
  signing_key_id: z.string().optional().describe("present for actors that sign artifacts"),
  trust_baseline: z.number().min(0).max(1).describe("default credibility [0,1]"),
  sensitivity_clearance: SensitivitySchema.describe("max sensitivity this actor may handle"),
  created_at: TimestampSchema,
})
export type Actor = z.infer<typeof ActorSchema>

/**
 * Ed25519 signature over a canonical payload.
 *
 * v0 scope: signatures are required for skills, policy versions,
 * external imports, and secret-signing events. Routine internal
 * events rely on the append-only log and content hashes, not
 * cryptographic signatures.
 */
export const SignatureSchema = z.object({
  signer_id: z.string().describe("actor_id of the signer"),
  payload_hash: z.string().describe("sha-256 of canonical payload"),
  algorithm: z.literal("ed25519"),
  signature: z.string().describe("base64-encoded signature bytes"),
  at: TimestampSchema,
})
export type Signature = z.infer<typeof SignatureSchema>
