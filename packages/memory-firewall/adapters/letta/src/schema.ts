import { z } from "zod"

/**
 * Minimal schema for the Letta (formerly MemGPT) memory-block export.
 *
 * Letta organises memory into named *blocks*: e.g. "human", "persona",
 * "scratchpad". Each block contains a textual body plus optional
 * metadata. The adapter validates the v0 (early-2026) shape; later
 * upstream changes will require a versioned schema bump here.
 *
 * Reference: https://github.com/letta-ai/letta
 */
export const LettaBlockSchema = z
  .object({
    id: z.string(),
    label: z.string().describe("block name, e.g. 'human', 'persona'"),
    value: z.string().min(1).describe("block contents"),
    agent_id: z.string().optional(),
    description: z.string().optional(),
    limit: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
export type LettaBlock = z.infer<typeof LettaBlockSchema>

export const LettaExportSchema = z.object({
  source: z.literal("letta"),
  exported_at: z.string().optional(),
  blocks: z.array(LettaBlockSchema),
})
export type LettaExport = z.infer<typeof LettaExportSchema>

/**
 * Envelope-only schema. Mirrors `LettaExportSchema` but treats each
 * block as `unknown` so per-record validation failures can be reported
 * via `rejection_reasons` instead of aborting the whole import.
 */
export const LettaEnvelopeSchema = z.object({
  source: z.literal("letta"),
  exported_at: z.string().optional(),
  blocks: z.array(z.unknown()),
})
