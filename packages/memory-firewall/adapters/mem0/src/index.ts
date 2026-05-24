import { randomUUID } from "node:crypto"
import type {
  Claim,
  EvidenceSet,
  Explanation,
  Observation,
} from "@qmilab/lodestar-core"
import {
  AdapterImportOptionsSchema,
  notImplementedFor,
  type AdapterImportOptions,
  type AdapterImportResult,
  type EvidenceStore,
  type ExternalMemoryAdapter,
  type MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { Mem0EnvelopeSchema, Mem0RecordSchema, type Mem0Record } from "./schema"

export { Mem0ExportSchema, Mem0RecordSchema } from "./schema"
export type { Mem0Export, Mem0Record } from "./schema"

const ADAPTER_NAME = "mem0"

/**
 * Adapter for the mem0 memory store.
 *
 * v0.2 implements `importMemories`: takes a mem0 export, validates it
 * against the adapter's schema, and produces firewall-governed Claims,
 * EvidenceSets, and Beliefs.
 *
 * Imports land at `truth_status: unverified`, `retrieval_status:
 * restricted`. The auto_observation gate refuses to silently promote
 * `external_document` evidence (Round 5 invariant); mem0 records are
 * external_document by default. Promotion to `supported` requires a
 * reflection pass or human approval (Batch 4+).
 *
 * The other methods on {@link ExternalMemoryAdapter} (`exportMemories`,
 * `syncMemories`) are scaffolded but throw — full semantics need
 * adapter-specific design work that exceeds the Batch 2 budget.
 *
 * The adapter is constructed with a {@link MemoryFirewall} and the
 * corresponding {@link EvidenceStore} so it can record evidence
 * alongside the firewall's claim/belief stores. v0.2 expects callers
 * to wire the same evidence store to both; later batches may expose a
 * unified `adoptBeliefWithEvidence` on the firewall and remove the
 * second constructor argument.
 */
export class Mem0Adapter implements ExternalMemoryAdapter {
  readonly name = ADAPTER_NAME

  constructor(
    private readonly firewall: MemoryFirewall,
    private readonly evidence: EvidenceStore,
  ) {}

  async importMemories(
    raw: unknown,
    options: AdapterImportOptions,
  ): Promise<AdapterImportResult> {
    const opts = AdapterImportOptionsSchema.parse(options)
    // Validate the envelope's shape but treat each record as unknown
    // so per-record schema failures can be reported via
    // rejection_reasons instead of aborting the whole import.
    const envelope = Mem0EnvelopeSchema.parse(raw)

    const result: AdapterImportResult = {
      adapter: ADAPTER_NAME,
      imported_count: 0,
      rejected_count: 0,
      rejection_reasons: [],
      claim_ids: [],
      belief_ids: [],
    }

    for (let i = 0; i < envelope.memories.length; i++) {
      const candidate = envelope.memories[i]
      const parsed = Mem0RecordSchema.safeParse(candidate)
      if (!parsed.success) {
        result.rejected_count += 1
        result.rejection_reasons.push({
          record_index: i,
          reason: `invalid mem0 record: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        })
        continue
      }
      try {
        const { claim, beliefId } = await this.importOne(parsed.data, opts)
        result.imported_count += 1
        result.claim_ids.push(claim.id)
        if (beliefId) result.belief_ids.push(beliefId)
      } catch (err) {
        result.rejected_count += 1
        result.rejection_reasons.push({
          record_index: i,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return result
  }

  async exportMemories(): Promise<unknown> {
    notImplementedFor(ADAPTER_NAME, "exportMemories")
  }

  async syncMemories(): Promise<unknown> {
    notImplementedFor(ADAPTER_NAME, "syncMemories")
  }

  private async importOne(
    record: Mem0Record,
    options: AdapterImportOptions,
  ): Promise<{ claim: Claim; beliefId?: string }> {
    const observationId = randomUUID()
    const projectId =
      typeof options.scope.identifier === "string"
        ? options.scope.identifier
        : "imported"

    const observation: Observation = {
      id: observationId,
      schema: "mem0.memory@1",
      payload: { record_id: record.id, body: record.memory },
      source: {
        tool: "mem0.import",
        invocation_id: randomUUID(),
        captured_at: new Date().toISOString(),
      },
      context: {
        session_id: `mem0-import-${Date.now()}`,
        project_id: projectId,
        actor_id: options.source_actor_id,
      },
      trust: "validated",
      sensitivity: options.sensitivity,
    }

    const claim: Claim = {
      id: randomUUID(),
      statement: record.memory,
      source_observation_ids: [observation.id],
      extraction_method: "import",
      extracted_by: options.source_actor_id,
      status: "extracted",
      scope: options.scope,
      sensitivity: options.sensitivity,
      authors: [options.source_actor_id],
      created_at: new Date().toISOString(),
    }
    await this.firewall.acceptClaim(claim)

    const evidenceSet: EvidenceSet = {
      id: randomUUID(),
      claim_id: claim.id,
      items: [
        {
          source_id: observation.id,
          relation: "supports",
          quality: "external_document",
          freshness: "unknown",
          notes:
            `mem0 record ${record.id}` +
            (record.user_id ? `, user_id=${record.user_id}` : "") +
            (record.created_at ? `, created_at=${record.created_at}` : ""),
        },
      ],
      assessed_by: options.source_actor_id,
      assessed_at: new Date().toISOString(),
    }
    await this.evidence.put(evidenceSet)

    const explanation: Explanation = {
      id: randomUUID(),
      subject_type: "memory_promotion",
      subject_id: "pending",
      audience: "audit",
      summary: `mem0 import of record ${record.id}`,
      full_text:
        `Imported from mem0. Trust baseline ${options.trust_baseline.toFixed(2)}. ` +
        `External-document evidence cannot auto-promote — landing at unverified/restricted.`,
      claims_used: [claim.id],
      evidence_used: [evidenceSet.id],
      uncertainties: [
        "Original upstream provenance not cryptographically verified.",
        "Memory body is treated as external_document — adversarial input is possible.",
      ],
      counterarguments: [],
      generated_by: options.source_actor_id,
      at: new Date().toISOString(),
    }

    const belief = await this.firewall.adoptBelief({
      candidate: {
        claim_id: claim.id,
        confidence: clamp01(options.trust_baseline),
        calibration_class: `mem0.import::${record.user_id ?? "global"}`,
        scope: options.scope,
        sensitivity: options.sensitivity,
        authority: "imported",
        truth_status: "unverified",
        retrieval_status: "restricted",
        security_status: "clean",
        freshness_status: record.created_at ? "fresh" : "stale",
        observed_at: record.created_at ?? new Date().toISOString(),
      },
      evidence_id: evidenceSet.id,
      by_authority: "reflection",
      rationale: explanation,
    })

    return { claim, beliefId: belief.id }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
