import { z } from "zod"

/**
 * Sensitivity of content. Affects retrieval, explanation generation,
 * OTel export, and final reports.
 *
 * Sensitivity is a content attribute. It is NOT a lifecycle axis —
 * truth/retrieval/security/freshness describe the *state* of a belief,
 * sensitivity describes its *content*.
 */
export const SensitivitySchema = z.enum(["public", "internal", "confidential", "secret"])
export type Sensitivity = z.infer<typeof SensitivitySchema>

/**
 * Scope a claim, belief, memory, or action applies to. Hierarchical
 * from broadest (global) to narrowest (session).
 */
export const ResourceScopeSchema = z
  .object({
    level: z.enum(["global", "organization", "user", "project", "repo", "session"]),
    identifier: z.string().describe("identifier within the scope level, e.g. project_id"),
  })
  .describe("Scope that bounds where a claim, belief, or memory applies")
export type ResourceScope = z.infer<typeof ResourceScopeSchema>

/**
 * Structured predicate for queryable claims and beliefs.
 * Free-form for v0; refined in later versions as the planner matures.
 */
export const PredicateSchema = z
  .object({
    subject: z.string(),
    relation: z.string(),
    object: z.unknown(),
  })
  .describe("Structured form of a claim suitable for queries")
export type Predicate = z.infer<typeof PredicateSchema>

/**
 * ISO 8601 timestamp string.
 */
export const TimestampSchema = z.string().datetime({ offset: true })
export type Timestamp = z.infer<typeof TimestampSchema>

/**
 * ISO 8601 duration string (e.g. "P30D", "PT1H").
 */
export const DurationSchema = z
  .string()
  .regex(/^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/)
export type Duration = z.infer<typeof DurationSchema>

/**
 * Generic Source reference used in evidence and explanations.
 * Points to an observation, belief, or external identifier.
 */
export const SourceSchema = z.object({
  type: z.enum(["observation", "belief", "claim", "memory", "skill", "external"]),
  id: z.string(),
  uri: z.string().optional().describe("optional external URI, for type=external"),
})
export type Source = z.infer<typeof SourceSchema>
