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
import { ZepEnvelopeSchema, ZepFactSchema, type ZepFact } from "./schema"

export { ZepExportSchema, ZepFactSchema } from "./schema"
export type { ZepExport, ZepFact } from "./schema"

const ADAPTER_NAME = "zep"

/**
 * Adapter for the Zep memory store.
 *
 * v0.2 implements `importMemories` for Zep "facts": validates a Zep
 * export and produces one Claim + Evidence + Belief per fact at
 * `unverified/restricted`. Raw message-history imports are deferred —
 * they need their own claim-extraction strategy and don't add value
 * for the stub.
 *
 * Other adapter methods throw — same shape as the mem0 and Letta
 * adapters; see those packages for the broader narrative.
 */
export class ZepAdapter implements ExternalMemoryAdapter {
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
    // Validate the envelope's shape but treat each fact as unknown so
    // per-record schema failures can be reported via rejection_reasons
    // instead of aborting the whole import.
    const envelope = ZepEnvelopeSchema.parse(raw)

    const result: AdapterImportResult = {
      adapter: ADAPTER_NAME,
      imported_count: 0,
      rejected_count: 0,
      rejection_reasons: [],
      claim_ids: [],
      belief_ids: [],
    }

    for (let i = 0; i < envelope.facts.length; i++) {
      const candidate = envelope.facts[i]
      const parsed = ZepFactSchema.safeParse(candidate)
      if (!parsed.success) {
        result.rejected_count += 1
        result.rejection_reasons.push({
          record_index: i,
          reason: `invalid Zep fact: ${parsed.error.issues
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
    fact: ZepFact,
    options: AdapterImportOptions,
  ): Promise<{ claim: Claim; beliefId?: string }> {
    const projectId =
      typeof options.scope.identifier === "string"
        ? options.scope.identifier
        : "imported"

    const observation: Observation = {
      id: randomUUID(),
      schema: "zep.fact@1",
      payload: { uuid: fact.uuid, fact: fact.fact },
      source: {
        tool: "zep.import",
        invocation_id: randomUUID(),
        captured_at: new Date().toISOString(),
      },
      context: {
        session_id: fact.session_id ?? `zep-import-${Date.now()}`,
        project_id: projectId,
        actor_id: options.source_actor_id,
      },
      trust: "validated",
      sensitivity: options.sensitivity,
    }

    const claim: Claim = {
      id: randomUUID(),
      statement: fact.fact,
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
          freshness: fact.expired_at ? "stale" : "unknown",
          notes:
            `Zep fact uuid=${fact.uuid}` +
            (fact.session_id ? `, session_id=${fact.session_id}` : "") +
            (typeof fact.rating === "number" ? `, rating=${fact.rating}` : ""),
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
      summary: `Zep fact import: ${fact.uuid}`,
      full_text:
        `Imported from Zep. Trust baseline ${options.trust_baseline.toFixed(2)}, ` +
        `Zep rating ${typeof fact.rating === "number" ? fact.rating.toFixed(2) : "n/a"}.`,
      claims_used: [claim.id],
      evidence_used: [evidenceSet.id],
      uncertainties: [
        "Zep fact derivation chain not verified end-to-end.",
        "Adversarial chat history could shape Zep facts — external_document by default.",
      ],
      counterarguments: [],
      generated_by: options.source_actor_id,
      at: new Date().toISOString(),
    }

    const belief = await this.firewall.adoptBelief({
      candidate: {
        claim_id: claim.id,
        confidence: clamp01(options.trust_baseline),
        calibration_class: `zep.import::${fact.session_id ?? "global"}`,
        scope: options.scope,
        sensitivity: options.sensitivity,
        authority: "imported",
        truth_status: "unverified",
        retrieval_status: "restricted",
        security_status: "clean",
        freshness_status: fact.expired_at ? "stale" : "fresh",
        observed_at: fact.created_at ?? new Date().toISOString(),
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
