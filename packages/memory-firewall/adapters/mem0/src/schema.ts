import { z } from "zod"

/**
 * Minimal schema for the mem0 export format.
 *
 * mem0 stores per-user memories with a free-text body and optional
 * structured metadata. This schema captures the v0 (early-2026) fields
 * that are stable enough to map into Lodestar claims. Fields not listed
 * here pass through into `metadata` so the adapter can surface them
 * in evidence notes without throwing on unknown keys.
 *
 * Reference: https://github.com/mem0ai/mem0 (export format may evolve;
 * the adapter validates at import time).
 */
export const Mem0RecordSchema = z
  .object({
    id: z.string(),
    memory: z.string().min(1),
    user_id: z.string().optional(),
    agent_id: z.string().optional(),
    run_id: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
export type Mem0Record = z.infer<typeof Mem0RecordSchema>

export const Mem0ExportSchema = z.object({
  source: z.literal("mem0"),
  exported_at: z.string().optional(),
  memories: z.array(Mem0RecordSchema),
})
export type Mem0Export = z.infer<typeof Mem0ExportSchema>

/**
 * Envelope-only schema. Validates the export's shell but accepts each
 * memory as `unknown`, leaving per-record validation to the importer.
 * Used so a single malformed record does not abort the whole import —
 * one bad record is recorded as a rejection, the rest are imported.
 */
export const Mem0EnvelopeSchema = z.object({
  source: z.literal("mem0"),
  exported_at: z.string().optional(),
  memories: z.array(z.unknown()),
})
