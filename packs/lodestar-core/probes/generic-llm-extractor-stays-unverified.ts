#!/usr/bin/env bun
/**
 * Probe: generic_llm_extractor_stays_unverified
 *
 * Locks the opt-in, LLM-driven generic claim extractor (#163, epic #154 child
 * C-2, ADR-0035). The extractor claims the reserved `__generic__` fallback slot
 * so that observation text with no schema-bound extractor can still yield
 * claims — but those claims must NEVER silently self-promote to a `supported`
 * belief. That is the safety property that makes a generic extractor acceptable
 * at all, and it is what this probe pins.
 *
 * How the safety holds: every generic claim is `extraction_method: "llm"`, and
 * the partner `GenericAwareEvidenceLinker` stamps its source evidence at
 * `model_inference` quality. The Round 5 auto-observation (Parallax) gate then
 * keeps the belief at `truth_status: unverified` — even at an evidence strength
 * that would promote a `direct_observation` claim, and even when a second
 * independent LLM inference corroborates it.
 *
 * Acceptance criteria pinned here (#163):
 *   AC#1  a generic-extracted claim is adopted at `truth_status: unverified`
 *         with `model_inference` evidence and `extraction_method: "llm"` —
 *         the gate holds despite an aggregate strength ≥ 0.7.
 *   AC#2  Parallax across LLM inferences: a SECOND independent generic
 *         observation of the same predicate does NOT corroborate the first into
 *         `supported`; both stay `unverified` (the cross-belief join still runs
 *         and records a `model_inference` supports item).
 *   AC#3  not active unless explicitly registered: with only the built-in
 *         extractors registered, the `__generic__` slot is empty and an
 *         unknown-schema observation extracts nothing (no belief adopted).
 *   AC#4  never a built-in: `registerBuiltInExtractors()` does not claim the
 *         `__generic__` slot (a schema-bound built-in still resolves — control).
 *   AC#5  the downgrade is load-bearing: the SAME `llm` claim linked by the
 *         BASE linker keeps `direct_observation` quality and promotes to
 *         `supported` — proving the `model_inference` downgrade (not low
 *         strength or anything incidental) is what holds the gate, and that the
 *         opt-in is the extractor *and* its linker together.
 *
 * In-memory only: the property is about the linker + gate, not the store.
 */

import {
  CognitiveCore,
  EvidenceLinker,
  ExplanationGenerator,
  GENERIC_EXTRACTOR_SCHEMA_KEY,
  GenericAwareEvidenceLinker,
  type GenericExtractionModel,
  InMemoryWorldModel,
  type WorldModel,
  createGenericLLMExtractor,
  lookupExtractor,
  registerBuiltInExtractors,
  registerExtractor,
} from "@qmilab/lodestar-cognitive-core"
import type { EvidenceItem, Observation, ResourceScope, Sensitivity } from "@qmilab/lodestar-core"
import {
  type BeliefStore,
  type ClaimStore,
  type EvidenceStore,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
  aggregateStrength,
} from "@qmilab/lodestar-memory-firewall"

// ── A deterministic stub model (no real LLM) ─────────────────────────────────
// Reads a predicate + statement straight off the observation payload so the
// probe controls exactly what the "model" infers. A real consumer's model would
// prompt an LLM; the seam is identical.
const stubModel: GenericExtractionModel = {
  async extractClaims({ observation }) {
    const p = observation.payload as {
      subject?: string
      relation?: string
      object?: unknown
      statement?: string
    }
    return [
      {
        statement: p.statement ?? `inferred claim from ${observation.schema}`,
        ...(typeof p.subject === "string" && typeof p.relation === "string"
          ? { predicate: { subject: p.subject, relation: p.relation, object: p.object } }
          : {}),
      },
    ]
  },
}

const GENERIC_SCHEMA = "acme.tool_result@1" // NO schema-bound extractor → __generic__

// ── Harness helpers ──────────────────────────────────────────────────────────

interface Check {
  name: string
  pass: boolean
  detail: string
}

interface Stores {
  claims: ClaimStore
  beliefs: BeliefStore
  evidence: EvidenceStore
}

function freshStores(): Stores {
  return {
    claims: new InMemoryClaimStore(),
    beliefs: new InMemoryBeliefStore(),
    evidence: new InMemoryEvidenceStore(),
  }
}

function buildCore(stores: Stores, linker: EvidenceLinker): CognitiveCore {
  const firewall = new MemoryFirewall(
    stores.claims,
    stores.beliefs,
    stores.evidence,
    async () => {},
  )
  const explanations = new ExplanationGenerator("probe-actor")
  return new CognitiveCore(firewall, linker, explanations, new InMemoryWorldModel())
}

function scope(id: string): ResourceScope {
  return { level: "project", identifier: id }
}

async function ingest(
  core: CognitiveCore,
  sc: ResourceScope,
  payload: Record<string, unknown>,
  tool: string,
  sensitivity: Sensitivity = "internal",
) {
  const observation: Observation = {
    id: crypto.randomUUID(),
    schema: GENERIC_SCHEMA,
    payload,
    source: { tool, invocation_id: crypto.randomUUID(), captured_at: new Date().toISOString() },
    context: {
      session_id: `sess-${sc.identifier}`,
      project_id: sc.identifier,
      actor_id: "probe-actor",
    },
    trust: "validated",
    sensitivity,
  }
  return core.ingest({
    observation,
    context: {
      actor_id: "probe-actor",
      project_id: sc.identifier,
      session_id: `sess-${sc.identifier}`,
      default_scope: sc,
      default_sensitivity: sensitivity,
    },
  })
}

/** The supporting evidence items the cross-belief join produced (vs own-source). */
function crossItemsOf(items: EvidenceItem[]): EvidenceItem[] {
  return items.filter((i) => i.notes?.includes("cross-belief"))
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<{ passed: boolean; checks: Check[]; notes: string[] }> {
  const runId = crypto.randomUUID().slice(0, 8)
  const checks: Check[] = []
  const notes: string[] = []

  // The factory targets the reserved fallback slot.
  checks.push({
    name: "factory: createGenericLLMExtractor claims the reserved __generic__ slot",
    pass: createGenericLLMExtractor(stubModel).schema_key === GENERIC_EXTRACTOR_SCHEMA_KEY,
    detail: `schema_key=${createGenericLLMExtractor(stubModel).schema_key}`,
  })

  // ── AC#3 (phase 0: empty registry) — nothing resolves an unknown schema ──
  checks.push({
    name: "AC#3: with an empty registry an unknown schema resolves no extractor",
    pass: lookupExtractor(GENERIC_SCHEMA) === undefined,
    detail: `lookupExtractor(${GENERIC_SCHEMA}) before any registration = ${lookupExtractor(GENERIC_SCHEMA)?.schema_key ?? "undefined"}`,
  })

  // ── AC#4 (phase 1: built-ins only) — __generic__ is NOT a built-in ──
  registerBuiltInExtractors()
  checks.push({
    name: "AC#4: registerBuiltInExtractors does NOT claim the __generic__ slot",
    pass: lookupExtractor(GENERIC_EXTRACTOR_SCHEMA_KEY) === undefined,
    detail: `__generic__ slot after built-ins = ${lookupExtractor(GENERIC_EXTRACTOR_SCHEMA_KEY)?.schema_key ?? "undefined (empty)"}`,
  })
  checks.push({
    name: "AC#4 (control): a schema-bound built-in DOES resolve",
    pass: lookupExtractor("git.status@1")?.schema_key === "git.status@1",
    detail: `lookupExtractor(git.status@1)=${lookupExtractor("git.status@1")?.schema_key ?? "undefined"}`,
  })

  // ── AC#3 (phase 1): an unknown-schema observation extracts nothing now ──
  {
    const stores = freshStores()
    const core = buildCore(
      stores,
      new GenericAwareEvidenceLinker(stores.evidence, stores.beliefs, stores.claims),
    )
    const r = await ingest(
      core,
      scope(`unregistered-${runId}`),
      { subject: "deploy", relation: "status", object: "failed", statement: "deploy failed" },
      "acme.ci",
    )
    checks.push({
      name: "AC#3: before the generic extractor is registered, an unknown-schema observation adopts no belief",
      pass: r.claims.length === 0 && r.beliefs.length === 0 && !!r.reason,
      detail: `claims=${r.claims.length}, beliefs=${r.beliefs.length}, reason=${r.reason ?? "(none)"}`,
    })
  }

  // ── Opt in: register the generic extractor (claims __generic__) ──
  registerExtractor(createGenericLLMExtractor(stubModel))
  checks.push({
    name: "opt-in: after explicit registration the __generic__ slot resolves an unknown schema",
    pass: lookupExtractor(GENERIC_SCHEMA)?.schema_key === GENERIC_EXTRACTOR_SCHEMA_KEY,
    detail: `lookupExtractor(${GENERIC_SCHEMA})=${lookupExtractor(GENERIC_SCHEMA)?.schema_key ?? "undefined"}`,
  })

  // ── AC#1: a generic claim is adopted UNVERIFIED at high strength ──
  {
    const stores = freshStores()
    const core = buildCore(
      stores,
      new GenericAwareEvidenceLinker(stores.evidence, stores.beliefs, stores.claims),
    )
    const r = await ingest(
      core,
      scope(`gate-${runId}`),
      {
        subject: "deploy",
        relation: "status",
        object: "failed",
        statement: "The deploy failed on db-2",
      },
      "acme.ci",
    )
    const claim = r.claims[0]
    const belief = r.beliefs[0]
    const ev = belief ? (await stores.evidence.forClaim(belief.claim_id))[0] : undefined
    const ownItem = ev?.items.find((i) => crossItemsOf([i]).length === 0)
    const strength = ev ? aggregateStrength(ev) : 0

    checks.push({
      name: "AC#1: generic-extracted claim carries extraction_method 'llm'",
      pass: claim?.extraction_method === "llm",
      detail: `extraction_method=${claim?.extraction_method ?? "(none)"}`,
    })
    checks.push({
      name: "AC#1: its source evidence is stamped model_inference quality",
      pass: ownItem?.quality === "model_inference",
      detail: `own-source evidence quality=${ownItem?.quality ?? "(none)"}`,
    })
    checks.push({
      name: "AC#1: the belief is adopted at truth_status 'unverified' (auto-observation gate holds)",
      pass: belief?.truth_status === "unverified",
      detail: `truth_status=${belief?.truth_status ?? "(not adopted)"}`,
    })
    checks.push({
      name: "AC#1: the gate held despite an aggregate strength ≥ 0.7 (would promote a direct_observation claim)",
      pass: strength >= 0.7 && belief?.truth_status === "unverified",
      detail: `aggregateStrength=${strength.toFixed(2)}, truth_status=${belief?.truth_status ?? "(none)"}`,
    })
  }

  // ── AC#2: Parallax across LLM inferences — a second independent generic ──
  //    observation does NOT corroborate the first into supported.
  {
    const stores = freshStores()
    const core = buildCore(
      stores,
      new GenericAwareEvidenceLinker(stores.evidence, stores.beliefs, stores.claims),
    )
    const s = scope(`parallax-${runId}`)
    const pred = { subject: "build", relation: "result", object: "green" }
    const r1 = await ingest(core, s, { ...pred, statement: "build is green (CI)" }, "acme.ci")
    const b1 = r1.beliefs[0]
    // Same predicate + same object, DISTINCT source tool (distinct independence group).
    const r2 = await ingest(
      core,
      s,
      { ...pred, statement: "build is green (deploy)" },
      "acme.deploy",
    )
    const b2 = r2.beliefs[0]
    const ev2 = b2 ? (await stores.evidence.forClaim(b2.claim_id))[0] : undefined
    const cross = ev2 ? crossItemsOf(ev2.items) : []

    checks.push({
      name: "AC#2: two independent LLM inferences of the same predicate both stay unverified (Parallax holds)",
      pass: b1?.truth_status === "unverified" && b2?.truth_status === "unverified",
      detail: `b1=${b1?.truth_status ?? "(none)"}, b2=${b2?.truth_status ?? "(none)"}`,
    })
    checks.push({
      name: "AC#2: the cross-belief join DID run and recorded a model_inference supports item",
      pass: cross.some((i) => i.relation === "supports" && i.quality === "model_inference"),
      detail: `cross items: ${cross.map((i) => `${i.relation}/${i.quality}`).join(", ") || "(none)"}`,
    })
  }

  // ── AC#5: control — the SAME llm claim via the BASE linker promotes ──
  //    (proves the model_inference downgrade is load-bearing; the opt-in is the
  //    extractor AND its linker, not the extractor alone).
  {
    const stores = freshStores()
    const baseCore = buildCore(
      stores,
      new EvidenceLinker(stores.evidence, stores.beliefs, stores.claims),
    )
    const r = await ingest(
      baseCore,
      scope(`control-base-${runId}`),
      { subject: "deploy", relation: "status", object: "ok", statement: "deploy ok" },
      "acme.ci",
    )
    const belief = r.beliefs[0]
    const ev = belief ? (await stores.evidence.forClaim(belief.claim_id))[0] : undefined
    const ownItem = ev?.items.find((i) => crossItemsOf([i]).length === 0)
    checks.push({
      name: "AC#5 (control): the same llm claim via the BASE linker keeps direct_observation quality and promotes to supported",
      pass: ownItem?.quality === "direct_observation" && belief?.truth_status === "supported",
      detail: `base-linker quality=${ownItem?.quality ?? "(none)"}, truth_status=${belief?.truth_status ?? "(not adopted)"} — so the GenericAware downgrade is what holds the gate`,
    })
  }

  notes.push(
    "The generic extractor is opt-in: registered explicitly and never via registerBuiltInExtractors. " +
      "Pair it with GenericAwareEvidenceLinker — the model_inference downgrade lives in the linker (AC#5).",
  )

  return { passed: checks.every((c) => c.pass), checks, notes }
}

const result = await main()
console.log("─".repeat(72))
console.log("probe: generic_llm_extractor_stays_unverified")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const c of result.checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`)
  console.log(`      ${c.detail}`)
}
for (const n of result.notes) console.log(`  • ${n}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
