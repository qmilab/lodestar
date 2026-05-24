import { z } from "zod"

/**
 * Minimal schema for the Zep memory export.
 *
 * Zep stores per-session message histories plus extracted "facts"
 * (a higher-order summary structure). The adapter focuses on facts in
 * v0.2 — they're the closest analogue to a Claim and map cleanly into
 * the firewall. Raw message imports are deferred.
 *
 * Reference: https://github.com/getzep/zep
 */
export const ZepFactSchema = z
  .object({
    uuid: z.string(),
    fact: z.string().min(1),
    session_id: z.string().optional(),
    rating: z.number().min(0).max(1).optional(),
    created_at: z.string().optional(),
    expired_at: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
export type ZepFact = z.infer<typeof ZepFactSchema>

export const ZepExportSchema = z.object({
  source: z.literal("zep"),
  exported_at: z.string().optional(),
  facts: z.array(ZepFactSchema),
})
export type ZepExport = z.infer<typeof ZepExportSchema>

/**
 * Envelope-only schema. Mirrors `ZepExportSchema` but treats each fact
 * as `unknown` so per-record validation failures can be reported via
 * `rejection_reasons` instead of aborting the whole import.
 */
export const ZepEnvelopeSchema = z.object({
  source: z.literal("zep"),
  exported_at: z.string().optional(),
  facts: z.array(z.unknown()),
})
