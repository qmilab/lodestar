import { randomUUID } from "node:crypto"
import type {
  Claim,
  EvidenceSet,
  Explanation,
  Observation,
} from "@orrery/core"
import {
  AdapterImportOptionsSchema,
  notImplementedFor,
  type AdapterImportOptions,
  type AdapterImportResult,
  type EvidenceStore,
  type ExternalMemoryAdapter,
  type MemoryFirewall,
} from "@orrery/memory-firewall"
import { LettaExportSchema, type LettaBlock } from "./schema"

export { LettaExportSchema, LettaBlockSchema } from "./schema"
export type { LettaExport, LettaBlock } from "./schema"

const ADAPTER_NAME = "letta"

/**
 * Adapter for the Letta (formerly MemGPT) memory store.
 *
 * v0.2 implements `importMemories` for memory blocks: takes a Letta
 * export, validates it, produces one Claim + Evidence + Belief per
 * block (statement = block label + value). Imports land at
 * `unverified/restricted`. The other adapter methods throw — see
 * `@orrery/memory-firewall-mem0` for the shape this adapter family
 * settles into.
 */
export class LettaAdapter implements ExternalMemoryAdapter {
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
    const parsed = LettaExportSchema.parse(raw)

    const result: AdapterImportResult = {
      adapter: ADAPTER_NAME,
      imported_count: 0,
      rejected_count: 0,
      rejection_reasons: [],
      claim_ids: [],
      belief_ids: [],
    }

    for (let i = 0; i < parsed.blocks.length; i++) {
      const block = parsed.blocks[i]
      if (!block) continue
      try {
        const { claim, beliefId } = await this.importOne(block, opts)
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
    block: LettaBlock,
    options: AdapterImportOptions,
  ): Promise<{ claim: Claim; beliefId?: string }> {
    const projectId =
      typeof options.scope.identifier === "string"
        ? options.scope.identifier
        : "imported"

    const observation: Observation = {
      id: randomUUID(),
      schema: "letta.block@1",
      payload: { block_id: block.id, label: block.label, value: block.value },
      source: {
        tool: "letta.import",
        invocation_id: randomUUID(),
        captured_at: new Date().toISOString(),
      },
      context: {
        session_id: `letta-import-${Date.now()}`,
        project_id: projectId,
        actor_id: options.source_actor_id,
      },
      trust: "validated",
      sensitivity: options.sensitivity,
    }

    const claim: Claim = {
      id: randomUUID(),
      statement: `Letta block '${block.label}': ${block.value}`,
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
            `Letta block id=${block.id} label=${block.label}` +
            (block.agent_id ? `, agent_id=${block.agent_id}` : ""),
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
      summary: `Letta block import: ${block.label}`,
      full_text:
        `Imported from Letta block ${block.id}. ` +
        `External-document evidence cannot auto-promote.`,
      claims_used: [claim.id],
      evidence_used: [evidenceSet.id],
      uncertainties: [
        "Block author identity not cryptographically verified.",
        "Free-text block contents are external_document — adversarial input is possible.",
      ],
      counterarguments: [],
      generated_by: options.source_actor_id,
      at: new Date().toISOString(),
    }

    const belief = await this.firewall.adoptBelief({
      candidate: {
        claim_id: claim.id,
        confidence: clamp01(options.trust_baseline),
        calibration_class: `letta.import::${block.label}`,
        scope: options.scope,
        sensitivity: options.sensitivity,
        authority: "imported",
        truth_status: "unverified",
        retrieval_status: "restricted",
        security_status: "clean",
        freshness_status: "stale",
        observed_at: new Date().toISOString(),
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
