import { randomUUID } from "node:crypto"
import {
  type ClaimExtractor,
  EvidenceLinker,
  type ExtractionInput,
  lookupExtractor,
  registerExtractor,
} from "@qmilab/lodestar-cognitive-core"
import {
  type Claim,
  type EvidenceItem,
  type EvidenceSet,
  type Observation,
  registry,
} from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"
import { z } from "zod"

/**
 * The single observation schema for every governed runtime tool call. Like the
 * MCP proxy's `mcp.tool_result@1`, the gate is plumbing, not a tool author: it
 * has no schema knowledge of what a given LangGraph tool means, so it records
 * one faithful envelope — the tool name, the args, the structured output, and
 * any untrusted document content the tool surfaced — and lets the evidence layer
 * treat the two content classes differently.
 */
export const RUNTIME_TOOL_RESULT_SCHEMA_KEY = "lodestar.runtime_tool_result@1"

export const RuntimeToolResultObservationSchema = z.object({
  /** The governed tool name, e.g. "search_web" or "write_file". */
  tool_name: z.string(),
  /** Original arguments the agent supplied. Untyped — the tool owns its schema. */
  args: z.record(z.unknown()),
  /**
   * The structured tool output the hook returned. Recorded as `tool_result`
   * evidence: it is the record of what the call reported, trustworthy as a fact
   * *about the call*. Permissive shape — the contents are tool-specific.
   */
  output: z.unknown(),
  /**
   * Document-style content the tool surfaced (file contents, fetched pages,
   * anything the planner would parse for facts). Recorded as `external_document`
   * evidence so the firewall's auto-observation gate keeps it from auto-promoting
   * to `truth_status: supported` — hostile content lives here.
   */
  documents: z.array(z.object({ text: z.string(), source: z.string().optional() })).default([]),
})
export type RuntimeToolResultObservationPayload = z.infer<typeof RuntimeToolResultObservationSchema>

/** Marks a claim as the tool-invocation envelope — `tool_result` quality. */
export const RUNTIME_TOOL_INVOCATION_RELATION = "runtime.tool_invocation"
/** Marks a claim as carrying untrusted document content — `external_document`. */
export const RUNTIME_EXTERNAL_DOCUMENT_RELATION = "runtime.external_document_content"

/** Register the runtime tool-result observation schema. Idempotent. */
export function registerRuntimeToolResultSchema(): void {
  if (registry.has(RUNTIME_TOOL_RESULT_SCHEMA_KEY)) return
  registry.register(RUNTIME_TOOL_RESULT_SCHEMA_KEY, RuntimeToolResultObservationSchema)
}

/**
 * Extractor for `lodestar.runtime_tool_result@1`. Emits:
 *   1. an **envelope** claim ("tool X returned …", `tool_result` quality), and
 *   2. one **external-document** claim per document block (`external_document`
 *      quality) — the potentially-hostile content the auto-observation gate
 *      must not auto-promote.
 */
export const RuntimeToolResultExtractor: ClaimExtractor = {
  schema_key: RUNTIME_TOOL_RESULT_SCHEMA_KEY,
  async extract(input: ExtractionInput): Promise<Claim[]> {
    const obs = input.observation
    const payload = RuntimeToolResultObservationSchema.parse(obs.payload)
    const ctx = input.context
    const now = new Date().toISOString()
    const claims: Claim[] = []

    const envelopeStatement = `runtime tool '${payload.tool_name}' returned ${payload.documents.length} document block${payload.documents.length === 1 ? "" : "s"}${payload.output === undefined ? " (no structured output)" : ""}`
    claims.push({
      id: randomUUID(),
      statement: envelopeStatement,
      structured_predicate: {
        subject: `tool:${payload.tool_name}`,
        relation: RUNTIME_TOOL_INVOCATION_RELATION,
        object: {
          args: payload.args,
          has_output: payload.output !== undefined,
          document_count: payload.documents.length,
          invocation_id: obs.source.invocation_id,
        },
      },
      source_observation_ids: [obs.id],
      extraction_method: "tool",
      extracted_by: ctx.actor_id,
      status: "extracted",
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    })

    payload.documents.forEach((doc, index) => {
      if (doc.text.length === 0) return
      const subject =
        doc.source !== undefined
          ? `runtime_document:${doc.source}`
          : `runtime_content:${payload.tool_name}:${obs.source.invocation_id}:#${index}`
      const truncated = doc.text.length > 200 ? `${doc.text.slice(0, 200)}…` : doc.text
      claims.push({
        id: randomUUID(),
        statement: `External document content via '${payload.tool_name}' block #${index}: ${truncated}`,
        structured_predicate: {
          subject,
          relation: RUNTIME_EXTERNAL_DOCUMENT_RELATION,
          object: { text: doc.text, content_index: index },
        },
        source_observation_ids: [obs.id],
        extraction_method: "tool",
        extracted_by: ctx.actor_id,
        status: "extracted",
        scope: ctx.default_scope,
        sensitivity: ctx.default_sensitivity,
        authors: [ctx.actor_id],
        created_at: now,
      })
    })

    return claims
  },
}

/**
 * Evidence linker that downgrades a runtime claim's source-evidence quality by
 * its relation — `external_document` for document-content claims, `tool_result`
 * for the envelope — exactly the stance the MCP proxy takes (`MCPAwareEvidenceLinker`).
 * The downgrade to `external_document` is what trips the auto-observation gate
 * inside `CognitiveCore`, so hostile tool output cannot auto-promote a belief.
 */
export class RuntimeAwareEvidenceLinker extends EvidenceLinker {
  constructor(
    private readonly evidenceStore: EvidenceStore,
    beliefs: BeliefStore,
    claims: ClaimStore,
  ) {
    super(evidenceStore, beliefs, claims)
  }

  override async linkForClaim(input: {
    claim: Claim
    source_observations: Observation[]
    assessor_actor_id: string
  }): Promise<EvidenceSet> {
    const relation = input.claim.structured_predicate?.relation
    const targetQuality: EvidenceItem["quality"] | undefined =
      relation === RUNTIME_EXTERNAL_DOCUMENT_RELATION
        ? "external_document"
        : relation === RUNTIME_TOOL_INVOCATION_RELATION
          ? "tool_result"
          : undefined
    if (targetQuality === undefined) {
      return super.linkForClaim(input)
    }
    // Re-implement the base body with the adjusted quality rather than calling
    // super and overwriting (which would double-`put` against the strict store).
    const items: EvidenceItem[] = input.source_observations.map((obs) => ({
      source_id: obs.id,
      relation: "supports",
      quality: obs.trust === "synthetic" ? "synthetic_probe" : targetQuality,
      independence_group: `obs:${obs.source.tool}`,
      freshness: "fresh",
      notes: `runtime.${relation === RUNTIME_EXTERNAL_DOCUMENT_RELATION ? "external_document" : "tool_invocation"} from ${obs.schema}`,
    }))
    // Same cross-belief join the base linker runs (#157).
    items.push(...(await this.crossBeliefItems(input.claim)))
    const evidenceSet: EvidenceSet = {
      id: randomUUID(),
      claim_id: input.claim.id,
      items,
      assessed_by: input.assessor_actor_id,
      assessed_at: new Date().toISOString(),
    }
    await this.evidenceStore.put(evidenceSet)
    return evidenceSet
  }
}

/** Register the runtime schema + extractor with the cognitive registries. Idempotent. */
export function registerRuntimeExtractors(): void {
  registerRuntimeToolResultSchema()
  const existing = lookupExtractor(RUNTIME_TOOL_RESULT_SCHEMA_KEY)
  if (existing && existing.schema_key === RUNTIME_TOOL_RESULT_SCHEMA_KEY) return
  registerExtractor(RuntimeToolResultExtractor)
}
