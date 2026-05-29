import { ResourceScopeSchema, SensitivitySchema } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * Common contract for memory-store import/export adapters.
 *
 * Three adapters ship in v0.2 (mem0, Letta, Zep) under
 * `packages/memory-firewall/adapters/`. Each has its own input format,
 * but all of them surface the same interface to the firewall: bring
 * external memory records *in*, validate them, and produce
 * firewall-governed claims and beliefs.
 *
 * No silent defaults. Callers must supply:
 *
 *   - `scope`: the resource scope claims/beliefs land in
 *   - `sensitivity`: a ceiling on what an imported record is allowed
 *     to carry (the adapter refuses to promote records above this)
 *   - `source_actor_id`: which actor takes responsibility for the
 *     import (skill identity, human approver, ...)
 *   - `trust_baseline`: the import's baseline trust score; the
 *     firewall uses this to gate `retrieval_status`
 *
 * Imported memories are external_document evidence by default. The
 * firewall's auto_observation gate refuses to promote external_document
 * silently to `truth_status: supported` (Round 5 invariant) — adapters
 * therefore set the initial `truth_status: unverified` and
 * `retrieval_status: restricted`. A reflection pass or human approval
 * is required before they can become normally retrievable.
 */
export const AdapterImportOptionsSchema = z.object({
  scope: ResourceScopeSchema,
  sensitivity: SensitivitySchema,
  source_actor_id: z.string(),
  trust_baseline: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Baseline trust in [0,1]. Imports above 0.8 still cannot self-promote; the value is recorded for downstream reflection.",
    ),
})
export type AdapterImportOptions = z.infer<typeof AdapterImportOptionsSchema>

export const AdapterImportResultSchema = z.object({
  adapter: z.string().describe("e.g. 'mem0', 'letta', 'zep'"),
  imported_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  rejection_reasons: z.array(
    z.object({
      record_index: z.number().int().nonnegative(),
      reason: z.string(),
    }),
  ),
  claim_ids: z.array(z.string()),
  belief_ids: z.array(z.string()),
})
export type AdapterImportResult = z.infer<typeof AdapterImportResultSchema>

/**
 * The interface every memory-store adapter implements.
 *
 * `importMemories` is the only method with a baseline implementation
 * in v0.2 — `exportMemories` and `syncMemories` are scaffolded so
 * downstream code can typecheck against the full contract, but they
 * throw `Error("not implemented")` until later batches wire them up.
 */
export interface ExternalMemoryAdapter {
  /** Adapter name; lowercase short code (mem0, letta, zep, ...). */
  readonly name: string

  /**
   * Convert an export from the upstream memory store into
   * firewall-governed claims and beliefs.
   *
   * The `raw` value is adapter-specific. Each adapter validates `raw`
   * with its own Zod schema before constructing claims.
   */
  importMemories(raw: unknown, options: AdapterImportOptions): Promise<AdapterImportResult>

  /**
   * Export the firewall's current beliefs into the upstream store's
   * format. Stub-level in v0.2.
   */
  exportMemories(): Promise<unknown>

  /**
   * Reconcile changes between the firewall and the upstream store.
   * Stub-level in v0.2 — synchronisation semantics need to be
   * specified per adapter before this can land safely.
   */
  syncMemories(): Promise<unknown>
}

/**
 * Helper for adapter implementations: produce a uniform "not yet
 * implemented" error with the adapter name in the message.
 */
export function notImplementedFor(adapter: string, method: string): never {
  throw new Error(
    `@qmilab/lodestar-memory-firewall-${adapter}: '${method}' is not implemented in v0.2 (stub-level adapter)`,
  )
}
