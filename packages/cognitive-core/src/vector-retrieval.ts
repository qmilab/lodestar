import { randomUUID } from "node:crypto"
import type { Claim, EvidenceItem, EvidenceSet, Observation } from "@qmilab/lodestar-core"
import type { BeliefStore, ClaimStore, EvidenceStore } from "@qmilab/lodestar-memory-firewall"
import { EvidenceLinker, type LinkForClaimInput } from "./evidence-linker.js"
import {
  type ClaimExtractor,
  type ExtractionInput,
  lookupExtractor,
  registerExtractor,
} from "./extractors/base.js"

/**
 * Cognition for the governed Vector/RAG retrieval adapter
 * (`@qmilab/lodestar-adapter-vector`, ADR-0039). The adapter owns the
 * `vector.query` tool and registers the `vector.retrieval_result@1` OUTPUT
 * schema; this file owns the matching extractor + evidence linker, exactly the
 * split `doc.read` (adapter-filesystem) / `DocAwareEvidenceLinker`
 * (cognitive-core) uses — so the adapter stays dependency-light and the
 * extraction/quality logic lives beside the rest of the cognitive core.
 *
 * The whole governance point: **retrieved chunks are the poisoning surface.** A
 * RAG agent embeds a query, pulls the nearest chunks from a vector index, and
 * feeds them to its planner — but those chunks are arbitrary stored text an
 * attacker may have written. So the extractor mints each chunk as its own claim
 * and the linker stamps it `external_document`, which trips the Round 5
 * auto-observation (Parallax) gate in {@link CognitiveCore}: a retrieved chunk
 * can never auto-promote a belief to `truth_status: supported`, no matter how
 * strong its aggregate evidence or how many other chunks corroborate it (two
 * `external_document` chunks stay `external_document`).
 */

/** The observation schema every `vector.query` result carries. Mirrors the
 * adapter's `VectorRetrievalOutputSchema` (kept in sync by the shared key
 * string, the same decoupling `documentation.source@1` uses). */
export const VECTOR_RETRIEVAL_SCHEMA_KEY = "vector.retrieval_result@1"

/** Marks a claim as the retrieval-invocation envelope — `tool_result` quality
 * (a fact *about the query*, trustworthy as a record of what ran). */
export const VECTOR_RETRIEVAL_INVOCATION_RELATION = "vector.retrieval_invocation"
/** Marks a claim as carrying an untrusted retrieved chunk — `external_document`
 * quality, so the auto-observation gate keeps it from auto-promoting. */
export const VECTOR_EXTERNAL_DOCUMENT_RELATION = "vector.external_document_content"

/**
 * A globally-unique key for one retrieved chunk: `<table>:<namespace>:<id>`, each
 * component percent-encoded so a separator character inside a component cannot
 * forge a collision (`encodeURIComponent` escapes `:` and `/`). It MUST include
 * the table, because `EvidenceLinker.crossBeliefItems` joins on
 * `(subject, relation)` alone — without the table, a chunk `docs/42` from index A
 * and one from index B would share a subject and lend each other corroboration /
 * contradiction, suppressing or contaminating unrelated beliefs. Shared by the
 * extractor's claim subject and the linker's independence group so the two cannot
 * drift.
 */
function chunkKey(table: string, namespace: string, chunkId: string): string {
  return `${encodeURIComponent(table)}:${encodeURIComponent(namespace)}:${encodeURIComponent(chunkId)}`
}

/** One retrieved chunk's STABLE provenance, carried on the content claim's
 * predicate so the linker can stamp per-chunk source attribution onto the
 * evidence item. Deliberately excludes query-volatile fields (distance, rank):
 * the cross-belief join compares the whole predicate object, so a volatile field
 * would make a re-retrieval of the same chunk register as a contradiction of the
 * first. distance/rank stay in the observation payload for the reviewer. */
interface ChunkProvenance {
  chunk_id: string
  namespace: string
  table: string
}

/** A retrieved chunk, as the adapter surfaces it (untrusted content). The
 * cognition reads only the stable id + content; the query-volatile distance/rank
 * stay in the observation payload and out of the compared predicate. */
interface RetrievedChunk {
  id?: unknown
  content?: unknown
}

/** The fields of a `vector.retrieval_result@1` payload the extractor reads. The
 * adapter's Zod output schema is the authoritative validator (the kernel parses
 * tool output against it before it becomes an observation); this is the
 * structural read on the already-validated payload. */
interface VectorRetrievalPayload {
  table: string
  namespace: string
  metric: string
  matches: RetrievedChunk[]
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback
}

function readPayload(payload: unknown): VectorRetrievalPayload {
  const p = (payload ?? {}) as Record<string, unknown>
  return {
    table: asString(p.table, "(unknown)"),
    namespace: asString(p.namespace, "(default)"),
    metric: asString(p.metric, "cosine"),
    matches: Array.isArray(p.matches) ? (p.matches as RetrievedChunk[]) : [],
  }
}

/** Read the per-chunk provenance the extractor stamped onto a content claim's
 * predicate object. Returns `undefined` for any other claim shape. */
function chunkProvenance(claim: Claim): ChunkProvenance | undefined {
  const obj = claim.structured_predicate?.object as Record<string, unknown> | undefined
  if (!obj) return undefined
  const { chunk_id, namespace, table } = obj
  if (typeof chunk_id !== "string" || typeof namespace !== "string" || typeof table !== "string") {
    return undefined
  }
  return { chunk_id, namespace, table }
}

/**
 * Extractor for `vector.retrieval_result@1`. Emits:
 *   1. an **envelope** claim ("vector.query against <table>/<ns> returned N
 *      chunks", `tool_result` quality via the linker), and
 *   2. one **external-document** claim per retrieved chunk (`external_document`
 *      quality) — the potentially-hostile content the auto-observation gate must
 *      not auto-promote.
 *
 * Each chunk claim uses a **table-scoped, encoded subject**
 * (`vector_chunk:<table>:<ns>:<id>`)
 * so a retrieved chunk never cross-joins (via `crossBeliefItems`,
 * `evidence-linker.ts`) onto an unrelated prior belief's `(subject, relation)`
 * and inherits a promote-grade quality — the same subject-isolation the MCP and
 * runtime extractors use.
 */
export const VectorRetrievalExtractor: ClaimExtractor = {
  schema_key: VECTOR_RETRIEVAL_SCHEMA_KEY,
  async extract(input: ExtractionInput): Promise<Claim[]> {
    const obs = input.observation
    const payload = readPayload(obs.payload)
    const ctx = input.context
    const now = new Date().toISOString()
    const claims: Claim[] = []

    const base = {
      source_observation_ids: [obs.id],
      extraction_method: "tool" as const,
      extracted_by: ctx.actor_id,
      status: "extracted" as const,
      scope: ctx.default_scope,
      sensitivity: ctx.default_sensitivity,
      authors: [ctx.actor_id],
      created_at: now,
    }

    claims.push({
      id: randomUUID(),
      statement: `vector.query against ${payload.table}/${payload.namespace} returned ${payload.matches.length} chunk${payload.matches.length === 1 ? "" : "s"} (metric ${payload.metric})`,
      structured_predicate: {
        subject: `vector_index:${payload.table}:${payload.namespace}`,
        relation: VECTOR_RETRIEVAL_INVOCATION_RELATION,
        object: {
          namespace: payload.namespace,
          metric: payload.metric,
          match_count: payload.matches.length,
          invocation_id: obs.source.invocation_id,
        },
      },
      ...base,
    })

    payload.matches.forEach((match, index) => {
      const text = typeof match.content === "string" ? match.content : ""
      if (text.length === 0) return
      const chunkId = typeof match.id === "string" ? match.id : `#${index}`
      const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text
      claims.push({
        id: randomUUID(),
        statement: `Retrieved chunk '${chunkId}' from ${payload.table}/${payload.namespace}: ${truncated}`,
        structured_predicate: {
          // Chunk-specific, table-scoped, encoded subject so the chunk never
          // cross-joins onto an unrelated belief and inherits a stronger quality
          // (Parallax stays) — and two indexes' chunks can't collide.
          subject: `vector_chunk:${chunkKey(payload.table, payload.namespace, chunkId)}`,
          relation: VECTOR_EXTERNAL_DOCUMENT_RELATION,
          // STABLE fields only — no query-volatile distance/rank, so the
          // cross-belief join treats a re-retrieval of the same chunk as
          // corroboration (still external_document → Parallax holds), not a
          // contradiction. distance/rank live in the observation payload.
          object: {
            text,
            chunk_id: chunkId,
            namespace: payload.namespace,
            table: payload.table,
          },
        },
        ...base,
      })
    })

    return claims
  },
}

/**
 * Evidence linker that downgrades a vector-retrieval claim's source-evidence
 * quality by its relation — `external_document` for a retrieved chunk,
 * `tool_result` for the query envelope — exactly the stance the MCP proxy
 * (`MCPAwareEvidenceLinker`) and runtime gate (`RuntimeAwareEvidenceLinker`)
 * take. The downgrade to `external_document` is what trips the auto-observation
 * gate inside {@link CognitiveCore}, so a retrieved chunk cannot auto-promote a
 * belief — the headline RAG-poisoning defence.
 *
 * Each chunk evidence item is stamped with its **source chunk**
 * (`independence_group: vector:<table>:<namespace>:<chunk_id>`, `notes` naming the
 * index/namespace + distance, `source_id` = the observation id), so
 * `lodestar report` shows which retrieved chunk backed each claim and two
 * chunks from distinct sources stay independent (still both `external_document`,
 * so corroboration never promotes — Parallax).
 *
 * Non-vector claims fall through to the base {@link EvidenceLinker} unchanged,
 * so a mixed-source session keeps working. This linker is the consumer of the
 * `evidenceLinkerFactory` seam on `guard.wrap()` for a retrieval-augmented
 * agent.
 */
export class VectorAwareEvidenceLinker extends EvidenceLinker {
  constructor(
    private readonly evidenceStore: EvidenceStore,
    beliefs: BeliefStore,
    claims: ClaimStore,
  ) {
    super(evidenceStore, beliefs, claims)
  }

  override async linkForClaim(input: LinkForClaimInput): Promise<EvidenceSet> {
    const relation = input.claim.structured_predicate?.relation
    const targetQuality: EvidenceItem["quality"] | undefined =
      relation === VECTOR_EXTERNAL_DOCUMENT_RELATION
        ? "external_document"
        : relation === VECTOR_RETRIEVAL_INVOCATION_RELATION
          ? "tool_result"
          : undefined
    if (targetQuality === undefined) {
      return super.linkForClaim(input)
    }

    const prov = chunkProvenance(input.claim)
    // Re-implement the base body with the adjusted quality rather than calling
    // super and overwriting (which would double-`put` against the strict store) —
    // the same reason MCP/Runtime/Doc-aware linkers re-implement it.
    const items: EvidenceItem[] = input.source_observations.map((obs: Observation) => ({
      source_id: obs.id,
      relation: "supports" as const,
      quality: obs.trust === "synthetic" ? "synthetic_probe" : targetQuality,
      independence_group: prov
        ? `vector:${chunkKey(prov.table, prov.namespace, prov.chunk_id)}`
        : `obs:${obs.source.tool}`,
      freshness: "fresh" as const,
      notes: prov
        ? `retrieved chunk '${prov.chunk_id}' from ${prov.table}/${prov.namespace}`
        : `vector.retrieval_invocation from ${obs.schema}`,
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

/**
 * Register the vector-retrieval extractor with the cognitive registry. Opt-in
 * (never a built-in), like the documentation + generic extractors: a host that
 * governs a retrieval-augmented agent registers it explicitly and pairs it with
 * a {@link VectorAwareEvidenceLinker} via the `guard.wrap()` cognitive seam.
 * Idempotent.
 */
export function registerVectorRetrievalExtractor(): void {
  const existing = lookupExtractor(VECTOR_RETRIEVAL_SCHEMA_KEY)
  if (existing && existing.schema_key === VECTOR_RETRIEVAL_SCHEMA_KEY) return
  registerExtractor(VectorRetrievalExtractor)
}
