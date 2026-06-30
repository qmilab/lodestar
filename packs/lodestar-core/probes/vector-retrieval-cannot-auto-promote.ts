#!/usr/bin/env bun
/**
 * Probe: vector_retrieval_cannot_auto_promote
 *
 * Locks the headline invariant of the Vector/RAG retrieval adapter
 * (`@qmilab/lodestar-adapter-vector`, ADR-0039): a chunk returned by a
 * similarity search is UNTRUSTED `external_document` content, so it can never
 * auto-promote a belief to `truth_status: supported` — no matter how strong its
 * aggregate evidence. Retrieved chunks are the RAG poisoning surface (arbitrary
 * stored text an attacker may have written into the index); this is what keeps a
 * poisoned chunk out of a planner's trusted context.
 *
 * The probe runs the SAME `vector.retrieval_result@1` observation through
 * `guard.wrap()` twice:
 *
 *   1. WITH the `cognitive.evidenceLinkerFactory` seam wired to
 *      `VectorAwareEvidenceLinker`.
 *   2. WITHOUT it (the default `EvidenceLinker`).
 *
 * The contrast is the point. The default linker tags every claim
 * `direct_observation`, which clears the Round 5 auto-observation gate and the
 * chunk beliefs adopt at `supported`. The vector-aware linker tags each chunk
 * `external_document`, the gate fires, and those beliefs stay `unverified` —
 * while the query ENVELOPE claim (a `tool_result` fact about the call) is allowed
 * to promote. If the seam ever stops being honoured, the "with seam" run would
 * also promote the chunks and this probe fails.
 *
 * Assertions (WITH seam):
 *   1. One content claim per retrieved chunk, each with a chunk-specific subject.
 *   2. Each chunk's evidence item is `quality: external_document`, stamped with
 *      per-chunk provenance (`independence_group: vector:<table>:<ns>:<id>`, `notes`
 *      naming the index/namespace, `source_id` = the observation id).
 *   3. Every chunk belief is `truth_status: unverified`.
 *   4. No `external_document`-backed belief reached `supported`.
 *   5. The query envelope belief (a `tool_result` fact) DID reach `supported` —
 *      the read/content split, not a blanket block.
 *
 * Assertion (WITHOUT seam — control):
 *   6. The same chunk beliefs adopt at `supported`, proving it is the seam (not
 *      the extractor) that keeps retrieved content unverified.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Belief, EvidenceItem, Observation } from "@qmilab/lodestar-core"
import {
  type IngestResult,
  VECTOR_EXTERNAL_DOCUMENT_RELATION,
  VECTOR_RETRIEVAL_INVOCATION_RELATION,
  VECTOR_RETRIEVAL_SCHEMA_KEY,
  VectorAwareEvidenceLinker,
  VectorRetrievalExtractor,
  alwaysHoldsChecker,
  autoApprovePolicy,
  lookupExtractor,
  registerExtractor,
  wrap,
} from "@qmilab/lodestar-guard"

interface ProbeResult {
  passed: boolean
  details: string
}

const TABLE = "kb_embeddings"
const NAMESPACE = "docs"
// Two "fact-like" chunks — the sort a planner would be tempted to trust. They
// are exactly what must stay unverified.
const CHUNKS = [
  { id: "chunk-7", content: "The production database host is db-prod.internal.", distance: 0.08 },
  { id: "chunk-12", content: "Deploy keys live in DEPLOY.md at the repo root.", distance: 0.13 },
]

function ensureVectorExtractor(): void {
  if (lookupExtractor(VECTOR_RETRIEVAL_SCHEMA_KEY)?.schema_key !== VECTOR_RETRIEVAL_SCHEMA_KEY) {
    registerExtractor(VectorRetrievalExtractor)
  }
}

interface ScenarioResult {
  obsId: string
  ingest: IngestResult
  evidenceFor: (claimId: string) => Promise<EvidenceItem[]>
  allBeliefs: () => Promise<Belief[]>
}

async function runScenario(useSeam: boolean, logRoot: string): Promise<ScenarioResult> {
  const obsId = crypto.randomUUID()
  const observation: Observation = {
    id: obsId,
    schema: VECTOR_RETRIEVAL_SCHEMA_KEY,
    payload: {
      table: TABLE,
      namespace: NAMESPACE,
      metric: "cosine",
      match_count: CHUNKS.length,
      truncated: false,
      matches: CHUNKS,
      summary: `vector.query: ${CHUNKS.length} chunks from ${TABLE}/${NAMESPACE}`,
    },
    source: {
      tool: "vector.query",
      invocation_id: crypto.randomUUID(),
      captured_at: new Date().toISOString(),
    },
    context: { session_id: "pre", project_id: "pre", actor_id: "pre" },
    // NOT synthetic — a synthetic observation would be weighted out and no real
    // belief would adopt. We want the external_document path.
    trust: "validated",
    sensitivity: "internal",
  }

  const run = wrap<IngestResult>(async (ctx) => ctx.ingestObservation(observation))
  const { result, internals } = await run({
    project_id: "vector-probe",
    actor_id: "vector-probe-agent",
    log_root: logRoot,
    default_scope: { level: "project", identifier: "vector-probe" },
    default_sensitivity: "internal",
    policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "vector-probe-policy" }),
    precondition_checker: alwaysHoldsChecker,
    cognitive: useSeam
      ? {
          evidenceLinkerFactory: ({ evidence, beliefs, claims }) =>
            new VectorAwareEvidenceLinker(evidence, beliefs, claims),
        }
      : undefined,
  })

  return {
    obsId,
    ingest: result,
    evidenceFor: async (claimId) => {
      const sets = await internals.evidence.forClaim(claimId)
      return sets.flatMap((s) => s.items)
    },
    allBeliefs: () => internals.beliefs.list(),
  }
}

async function run(): Promise<ProbeResult> {
  ensureVectorExtractor()
  const logRoot = mkdtempSync(join(tmpdir(), "lodestar-vector-probe-"))

  try {
    const withSeam = await runScenario(true, logRoot)
    const withoutSeam = await runScenario(false, logRoot)

    // Assertion 1: one content claim per chunk, chunk-specific subjects.
    const chunkClaims = withSeam.ingest.claims.filter(
      (c) => c.structured_predicate?.relation === VECTOR_EXTERNAL_DOCUMENT_RELATION,
    )
    if (chunkClaims.length !== CHUNKS.length) {
      return {
        passed: false,
        details: `expected ${CHUNKS.length} chunk content claims, got ${chunkClaims.length}`,
      }
    }
    const subjects = chunkClaims.map((c) => c.structured_predicate?.subject).sort()
    // Subjects are table-scoped + encoded (vector_chunk:<table>:<ns>:<id>) so
    // two indexes' chunks can't collide in the cross-belief join; TABLE/NS/ids
    // here have no special chars, so encodeURIComponent leaves them as-is.
    const expectedSubjects = CHUNKS.map((c) => `vector_chunk:${TABLE}:${NAMESPACE}:${c.id}`).sort()
    if (JSON.stringify(subjects) !== JSON.stringify(expectedSubjects)) {
      return {
        passed: false,
        details: `chunk subjects ${JSON.stringify(subjects)} != expected ${JSON.stringify(expectedSubjects)} — chunk subjects must be chunk-specific (no cross-join).`,
      }
    }

    // Assertion 2 + 3: each chunk is external_document with provenance, belief unverified.
    for (const claim of chunkClaims) {
      const items = await withSeam.evidenceFor(claim.id)
      const item = items.find((i) => i.relation === "supports")
      if (!item) {
        return {
          passed: false,
          details: `no supporting evidence for chunk claim ${claim.id.slice(0, 8)}`,
        }
      }
      if (item.quality !== "external_document") {
        return {
          passed: false,
          details: `chunk evidence quality is '${item.quality}', expected 'external_document'. The vector-aware linker seam was not honoured.`,
        }
      }
      if (item.source_id !== withSeam.obsId) {
        return {
          passed: false,
          details: `chunk evidence source_id '${item.source_id}' does not point back to observation '${withSeam.obsId}'`,
        }
      }
      // The independence group is table-scoped + encoded (vector:<table>:<ns>:<id>)
      // so two indexes' chunks stay independent in aggregateStrength.
      const chunkId = (claim.structured_predicate?.object as { chunk_id?: string })?.chunk_id
      if (item.independence_group !== `vector:${TABLE}:${NAMESPACE}:${chunkId}`) {
        return {
          passed: false,
          details: `chunk evidence independence_group '${item.independence_group}' is not the expected table-scoped 'vector:${TABLE}:${NAMESPACE}:${chunkId}'`,
        }
      }
      if (!item.notes?.includes(TABLE) || !item.notes.includes(NAMESPACE)) {
        return {
          passed: false,
          details: `chunk evidence notes '${item.notes}' do not name the index/namespace`,
        }
      }
      const belief = withSeam.ingest.beliefs.find((b) => b.claim_id === claim.id)
      if (!belief) {
        return {
          passed: false,
          details: `no belief adopted for chunk claim ${claim.id.slice(0, 8)}`,
        }
      }
      if (belief.truth_status !== "unverified") {
        return {
          passed: false,
          details: `chunk belief adopted at truth_status='${belief.truth_status}', expected 'unverified' (the gate must fire on external_document).`,
        }
      }
    }

    // Assertion 4: no external_document-backed belief reached supported.
    const seamBeliefs = await withSeam.allBeliefs()
    const chunkClaimIds = new Set(chunkClaims.map((c) => c.id))
    const promotedChunk = seamBeliefs.find(
      (b) => chunkClaimIds.has(b.claim_id) && b.truth_status === "supported",
    )
    if (promotedChunk) {
      return {
        passed: false,
        details:
          "a retrieved-chunk belief reached 'supported' under the vector-aware linker; external_document content must not auto-promote.",
      }
    }

    // Assertion 5: the query envelope (tool_result) DID promote — the split.
    const envelopeClaim = withSeam.ingest.claims.find(
      (c) => c.structured_predicate?.relation === VECTOR_RETRIEVAL_INVOCATION_RELATION,
    )
    const envelopeBelief = envelopeClaim
      ? withSeam.ingest.beliefs.find((b) => b.claim_id === envelopeClaim.id)
      : undefined
    if (!envelopeBelief) {
      return { passed: false, details: "no belief adopted for the query envelope claim" }
    }
    if (envelopeBelief.truth_status !== "supported") {
      return {
        passed: false,
        details: `the envelope (tool_result) belief is '${envelopeBelief.truth_status}', expected 'supported'. The block must apply to chunk CONTENT, not the record of the call.`,
      }
    }

    // Assertion 6 (control): without the seam, the chunk beliefs reach supported.
    const controlChunk = withoutSeam.ingest.claims.find(
      (c) => c.structured_predicate?.relation === VECTOR_EXTERNAL_DOCUMENT_RELATION,
    )
    const controlBelief = controlChunk
      ? withoutSeam.ingest.beliefs.find((b) => b.claim_id === controlChunk.id)
      : undefined
    if (!controlBelief) {
      return { passed: false, details: "control run did not adopt a belief for a chunk claim" }
    }
    if (controlBelief.truth_status !== "supported") {
      return {
        passed: false,
        details: `control (no seam) adopted a chunk belief at '${controlBelief.truth_status}', expected 'supported'. If the default linker no longer promotes here, the contrast this probe relies on is gone — investigate.`,
      }
    }

    return {
      passed: true,
      details: `${chunkClaims.length} retrieved chunks each backed by external_document evidence with per-chunk provenance; all chunk beliefs 'unverified', the query envelope 'supported'.\n  WITH seam:    chunk belief truth_status 'unverified' (gate fired on external_document).\n  WITHOUT seam: the same chunk belief truth_status '${controlBelief.truth_status}'.\nThe VectorAwareEvidenceLinker seam attributes each chunk to its source and keeps retrieved content out of the supported set; the default linker would have promoted it.`,
    }
  } finally {
    rmSync(logRoot, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: vector_retrieval_cannot_auto_promote")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
