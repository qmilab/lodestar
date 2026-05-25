import { z } from "zod"
import { SensitivitySchema, TimestampSchema } from "./common.js"

/**
 * Trust level of an observation's source.
 *
 * - "raw": just arrived from a tool, not yet validated by schema registry
 * - "validated": validated against its registered schema, ready for cognition
 * - "synthetic": produced by a probe; must not pollute real memory
 */
export const ObservationTrustSchema = z.enum(["raw", "validated", "synthetic"])
export type ObservationTrust = z.infer<typeof ObservationTrustSchema>

/**
 * The first link in the epistemic chain.
 *
 * An Observation is a schema-typed structured input produced by a tool.
 * Free-form strings from a tool are NOT observations until they have
 * been validated against a registered schema.
 *
 * The `schema` field references the registry entry (e.g. "git.status@1").
 * The kernel validates `payload` against that schema before this becomes
 * a `validated` observation.
 */
export const ObservationSchema = z.object({
  id: z.string(),
  schema: z.string().describe("registry key, e.g. 'git.status@1'"),
  payload: z.unknown(),
  source: z.object({
    tool: z.string(),
    invocation_id: z.string(),
    captured_at: TimestampSchema,
  }),
  context: z.object({
    session_id: z.string(),
    project_id: z.string(),
    actor_id: z.string(),
  }),
  trust: ObservationTrustSchema,
  sensitivity: SensitivitySchema,
})
export type Observation = z.infer<typeof ObservationSchema>
