#!/usr/bin/env bun
/**
 * Probe: evidence_linker_cross_belief_join
 *
 * Locks the cross-belief join the evidence linker performs for a new claim
 * (#157, ADR-0032). For a claim with a `structured_predicate`, the linker
 * walks prior beliefs in scope back to their claims and emits cross-belief
 * evidence:
 *   - same (subject, relation) + same object      → a `supports` item
 *   - same (subject, relation) + different object  → a `contradicts` item
 * The cross-belief item INHERITS the prior belief's strongest supporting
 * quality + its independence_group (quality inheritance) — a corroborator
 * can never lend more confidence than its own basis.
 *
 * Why this matters: before #157 every belief was judged in isolation —
 * zero independent-corroboration weight, nothing ever contradicted from an
 * observation chain. With the join, a lone `external_document` claim that an
 * independent higher-quality source corroborates can finally clear the
 * auto-observation (Parallax) gate, while two `external_document` beliefs
 * still cannot promote each other — the load-bearing safety property.
 *
 * Acceptance criteria pinned here (ADR-0032 / #157):
 *   AC#1  corroboration by a higher-quality belief in a DISTINCT independence
 *         group flips a lone-source external_document claim unverified→supported
 *         (and its EvidenceSet carries ≥2 supporting items in distinct groups);
 *         a baseline scenario proves the same claim ALONE stays unverified.
 *   AC#2  a (subject, relation) match with a DIFFERENT object produces a
 *         `contradicts` item and a net-negative strength → not adopted.
 *   AC#3  two external_document-quality beliefs do NOT corroborate each other
 *         into `supported` (Parallax gate still holds), even though the join ran.
 *   AC#4  the prior belief is NOT mutated by the linker (no transition).
 *   - claims without a `structured_predicate` are excluded from the join
 *     (both the new claim and a prior claim).
 *   - the (subject, relation) key helper is shared with retrieval.ts
 *     (single exported `predicateKey`).
 *   - behaviour is identical across in-memory and Postgres stores (proven by
 *     running the whole suite against both; the Postgres leg is DB-gated like
 *     `tool-poisoning-cross-session` and skips loudly when
 *     LODESTAR_TEST_DATABASE_URL is unset).
 */

import {
  type ClaimExtractor,
  CognitiveCore,
  DocAwareEvidenceLinker,
  EvidenceLinker,
  ExplanationGenerator,
  InMemoryWorldModel,
  lookupExtractor,
  registerExtractor,
} from "@qmilab/lodestar-cognitive-core"
import type { Belief, Claim, EvidenceItem, Observation, ResourceScope } from "@qmilab/lodestar-core"
import { registry } from "@qmilab/lodestar-core"
import {
  type BeliefStore,
  type ClaimStore,
  type EvidenceStore,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
  aggregateStrength,
  predicateKey,
} from "@qmilab/lodestar-memory-firewall"
import { createPostgresStores } from "@qmilab/lodestar-memory-firewall/postgres"
import { z } from "zod"

// ── Probe schemas + extractors (registered once) ─────────────────────────────

const DOC_SCHEMA = "documentation.cross@1" // → external_document via DocAware
const OBS_SCHEMA = "probe.cross.obs@1" // → direct_observation via base linker
const NOPRED_SCHEMA = "probe.nopred@1" // → a claim with no structured_predicate

function makeExtractor(schema_key: string, hasPredicate: boolean): ClaimExtractor {
  return {
    schema_key,
    async extract({ observation, context }) {
      const payload = observation.payload as {
        subject?: string
        relation?: string
        object?: unknown
      }
      const claim: Claim = {
        id: crypto.randomUUID(),
        statement: `probe claim from ${schema_key}`,
        ...(hasPredicate
          ? {
              structured_predicate: {
                subject: payload.subject!,
                relation: payload.relation!,
                object: payload.object,
              },
            }
          : {}),
        source_observation_ids: [observation.id],
        extraction_method: "llm",
        extracted_by: context.actor_id,
        status: "extracted",
        scope: context.default_scope,
        sensitivity: context.default_sensitivity,
        authors: [context.actor_id],
        created_at: new Date().toISOString(),
      }
      return [claim]
    },
  }
}

function registerOnce(schema_key: string, shape: z.ZodTypeAny, hasPredicate: boolean): void {
  if (!registry.has(schema_key)) registry.register(schema_key, shape)
  if (lookupExtractor(schema_key)?.schema_key !== schema_key) {
    registerExtractor(makeExtractor(schema_key, hasPredicate))
  }
}

registerOnce(
  DOC_SCHEMA,
  z.object({ path: z.string(), subject: z.string(), relation: z.string(), object: z.unknown() }),
  true,
)
registerOnce(
  OBS_SCHEMA,
  z.object({ subject: z.string(), relation: z.string(), object: z.unknown() }),
  true,
)
registerOnce(NOPRED_SCHEMA, z.object({ note: z.string() }), false)

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

interface Suite {
  core: CognitiveCore
  baseLinker: EvidenceLinker
  stores: Stores
}

function buildSuite(stores: Stores): Suite {
  const worldModel = new InMemoryWorldModel()
  const firewall = new MemoryFirewall(
    stores.claims,
    stores.beliefs,
    stores.evidence,
    async () => {},
  )
  const linker = new DocAwareEvidenceLinker(stores.evidence, stores.beliefs, stores.claims)
  const explanations = new ExplanationGenerator("probe-actor")
  const core = new CognitiveCore(firewall, linker, explanations, worldModel)
  const baseLinker = new EvidenceLinker(stores.evidence, stores.beliefs, stores.claims)
  return { core, baseLinker, stores }
}

function scope(id: string): ResourceScope {
  return { level: "project", identifier: id }
}

async function ingest(
  core: CognitiveCore,
  sc: ResourceScope,
  schema: string,
  payload: Record<string, unknown>,
  tool: string,
) {
  const observation: Observation = {
    id: crypto.randomUUID(),
    schema,
    payload,
    source: { tool, invocation_id: crypto.randomUUID(), captured_at: new Date().toISOString() },
    context: {
      session_id: `sess-${sc.identifier}`,
      project_id: sc.identifier,
      actor_id: "probe-actor",
    },
    trust: "validated",
    sensitivity: "internal",
  }
  return core.ingest({
    observation,
    context: {
      actor_id: "probe-actor",
      project_id: sc.identifier,
      session_id: `sess-${sc.identifier}`,
      default_scope: sc,
      default_sensitivity: "internal",
    },
  })
}

/** Supporting evidence items the cross-belief join produced (vs own-source). */
function crossItemsOf(items: EvidenceItem[]): EvidenceItem[] {
  return items.filter((i) => i.notes?.includes("cross-belief"))
}

function distinctGroups(items: EvidenceItem[]): number {
  return new Set(items.filter((i) => i.relation === "supports").map((i) => i.independence_group))
    .size
}

// ── The scenario suite (run against each backend) ────────────────────────────

const PREDICATE = { subject: "/charge", relation: "requires" } as const

async function runSuite(stores: Stores, label: string, runId: string): Promise<Check[]> {
  const { core, baseLinker } = buildSuite(stores)
  const checks: Check[] = []
  const sc = (name: string) => scope(`${name}-${label}-${runId}`)

  // ── Scenario A: corroboration promotes (AC#1) + prior not mutated (AC#4) ──
  {
    const s = sc("corroborate")
    const r1 = await ingest(core, s, OBS_SCHEMA, { ...PREDICATE, object: "auth" }, "probe.obs")
    const b1 = r1.beliefs[0]
    const before = b1 ? snapshot(b1) : undefined
    const r2 = await ingest(
      core,
      s,
      DOC_SCHEMA,
      { path: "/DEV.md", ...PREDICATE, object: "auth" },
      "fs.read",
    )
    const b2 = r2.beliefs[0]
    const b1After = b1 ? await stores.beliefs.get(b1.id) : undefined
    const ev2 = b2 ? (await stores.evidence.forClaim(b2.claim_id))[0] : undefined

    checks.push({
      name: `[${label}] A: corroborator adopted as supported`,
      pass: b1?.truth_status === "supported",
      detail: `corroborator truth_status=${b1?.truth_status ?? "(none)"}`,
    })
    checks.push({
      name: `[${label}] A (AC#1): external_document claim corroborated by a higher-quality distinct source flips → supported`,
      pass: b2?.truth_status === "supported",
      detail: `doc-claim truth_status=${b2?.truth_status ?? "(not adopted)"}`,
    })
    checks.push({
      name: `[${label}] A (AC#1): corroborated EvidenceSet carries ≥2 supporting items in distinct independence groups`,
      pass: !!ev2 && distinctGroups(ev2.items) >= 2 && crossItemsOf(ev2.items).length >= 1,
      detail: ev2
        ? `supporting groups=${distinctGroups(ev2.items)}, cross-belief items=${crossItemsOf(ev2.items).length}`
        : "no evidence set",
    })
    checks.push({
      name: `[${label}] A (AC#4): prior belief not mutated by the linker`,
      pass: !!before && !!b1After && snapshot(b1After) === before,
      detail:
        before && b1After
          ? snapshot(b1After) === before
            ? "prior belief unchanged"
            : `MUTATED: ${before} → ${snapshot(b1After)}`
          : "missing prior belief",
    })
  }

  // ── Scenario B: the same lone external_document claim ALONE stays unverified ──
  {
    const s = sc("alone")
    const r = await ingest(
      core,
      s,
      DOC_SCHEMA,
      { path: "/DEV.md", ...PREDICATE, object: "auth" },
      "fs.read",
    )
    const b = r.beliefs[0]
    checks.push({
      name: `[${label}] B (AC#1 baseline): lone external_document claim stays unverified (proves the flip is corroboration)`,
      pass: b?.truth_status === "unverified",
      detail: `lone doc-claim truth_status=${b?.truth_status ?? "(not adopted)"}`,
    })
  }

  // ── Scenario C: two external_document beliefs do not promote (AC#3) ──
  {
    const s = sc("parallax")
    const r1 = await ingest(
      core,
      s,
      DOC_SCHEMA,
      { path: "/README.md", ...PREDICATE, object: "auth" },
      "fs.read",
    )
    const b1 = r1.beliefs[0]
    const r2 = await ingest(
      core,
      s,
      DOC_SCHEMA,
      { path: "/DEV.md", ...PREDICATE, object: "auth" },
      "fs.read",
    )
    const b2 = r2.beliefs[0]
    const ev2 = b2 ? (await stores.evidence.forClaim(b2.claim_id))[0] : undefined
    checks.push({
      name: `[${label}] C (AC#3): two external_document beliefs do NOT corroborate into supported (Parallax holds)`,
      pass: b1?.truth_status === "unverified" && b2?.truth_status === "unverified",
      detail: `b1=${b1?.truth_status ?? "(none)"}, b2=${b2?.truth_status ?? "(none)"}`,
    })
    checks.push({
      name: `[${label}] C: the join DID run (cross-belief supports item present, inherited external_document)`,
      pass:
        !!ev2 &&
        crossItemsOf(ev2.items).some(
          (i) => i.relation === "supports" && i.quality === "external_document",
        ),
      detail: ev2
        ? `cross items: ${
            crossItemsOf(ev2.items)
              .map((i) => `${i.relation}/${i.quality}`)
              .join(", ") || "(none)"
          }`
        : "no evidence set",
    })
  }

  // ── Scenario D: contradiction (AC#2) + prior not mutated (AC#4) ──
  {
    const s = sc("contradict")
    const r1 = await ingest(core, s, OBS_SCHEMA, { ...PREDICATE, object: "auth" }, "probe.obs")
    const b1 = r1.beliefs[0]
    const before = b1 ? snapshot(b1) : undefined
    // same (subject, relation), DIFFERENT object → contradiction
    const r2 = await ingest(
      core,
      s,
      DOC_SCHEMA,
      { path: "/DEV.md", ...PREDICATE, object: "none" },
      "fs.read",
    )
    const docClaim = r2.claims[0]
    const ev2 = docClaim ? (await stores.evidence.forClaim(docClaim.id))[0] : undefined
    const b1After = b1 ? await stores.beliefs.get(b1.id) : undefined

    const hasContradicts = !!ev2 && ev2.items.some((i) => i.relation === "contradicts")
    const netStrength = ev2 ? aggregateStrength(ev2) : 1
    checks.push({
      name: `[${label}] D (AC#2): a different-object match produces a contradicts item`,
      pass: hasContradicts,
      detail: ev2
        ? `items: ${ev2.items.map((i) => `${i.relation}/${i.quality}`).join(", ")}`
        : "no evidence set",
    })
    checks.push({
      name: `[${label}] D (AC#2): net strength is ≤ 0 → the contradicted claim is not adopted`,
      pass: netStrength <= 0 && r2.beliefs.length === 0,
      detail: `aggregateStrength=${netStrength.toFixed(2)}, beliefs adopted=${r2.beliefs.length}`,
    })
    checks.push({
      name: `[${label}] D (AC#4): prior belief not mutated by the contradiction`,
      pass: !!before && !!b1After && snapshot(b1After) === before,
      detail:
        before && b1After && snapshot(b1After) === before
          ? "prior belief unchanged"
          : "prior belief changed",
    })
  }

  // ── Scenario E: claims without a structured_predicate are excluded ──
  {
    const s = sc("nopred")
    // A predicated peer that WOULD match, plus a no-predicate prior belief.
    await ingest(
      core,
      s,
      OBS_SCHEMA,
      { subject: "/pay", relation: "needs", object: "key" },
      "probe.obs",
    )
    const rN = await ingest(
      core,
      s,
      NOPRED_SCHEMA,
      { note: "a claim with no predicate" },
      "probe.obs",
    )
    const nClaim = rN.claims[0]
    const evN = nClaim ? (await stores.evidence.forClaim(nClaim.id))[0] : undefined

    // (a) the NEW claim has no predicate → the join is a no-op (no cross items),
    //     even though a predicated peer exists in scope.
    checks.push({
      name: `[${label}] E(a): a new claim with no structured_predicate produces no cross-belief items`,
      pass: !!evN && crossItemsOf(evN.items).length === 0,
      detail: evN ? `cross-belief items=${crossItemsOf(evN.items).length}` : "no evidence set",
    })

    // (b) a PRIOR belief whose claim has no predicate is excluded as a peer:
    //     a new predicated claim matching the predicated peer sees exactly 1
    //     cross item (the peer), not the no-predicate belief.
    const rD = await ingest(
      core,
      s,
      DOC_SCHEMA,
      { path: "/pay.md", subject: "/pay", relation: "needs", object: "key" },
      "fs.read",
    )
    const dBelief = rD.beliefs[0]
    const evD = dBelief ? (await stores.evidence.forClaim(dBelief.claim_id))[0] : undefined
    checks.push({
      name: `[${label}] E(b): a prior no-predicate belief is excluded as a join peer`,
      pass: !!evD && crossItemsOf(evD.items).length === 1,
      detail: evD
        ? `cross-belief items=${crossItemsOf(evD.items).length} (expected 1: the predicated peer only)`
        : "no evidence set",
    })
  }

  // ── Scenario F: a claim with no peers at all gets no cross items (base linker) ──
  {
    const s = sc("lonely")
    const obs: Observation = {
      id: crypto.randomUUID(),
      schema: OBS_SCHEMA,
      payload: { subject: "/x", relation: "is", object: "y" },
      source: {
        tool: "probe.obs",
        invocation_id: crypto.randomUUID(),
        captured_at: new Date().toISOString(),
      },
      context: {
        session_id: `sess-${s.identifier}`,
        project_id: s.identifier,
        actor_id: "probe-actor",
      },
      trust: "validated",
      sensitivity: "internal",
    }
    const lonelyClaim: Claim = {
      id: crypto.randomUUID(),
      statement: "lonely claim",
      structured_predicate: { subject: "/x", relation: "is", object: "y" },
      source_observation_ids: [obs.id],
      extraction_method: "llm",
      extracted_by: "probe-actor",
      status: "extracted",
      scope: s,
      sensitivity: "internal",
      authors: ["probe-actor"],
      created_at: new Date().toISOString(),
    }
    const set = await baseLinker.linkForClaim({
      claim: lonelyClaim,
      source_observations: [obs],
      assessor_actor_id: "probe-actor",
    })
    checks.push({
      name: `[${label}] F: a predicated claim with no peers in scope gets only its own-source item`,
      pass: set.items.length === 1 && crossItemsOf(set.items).length === 0,
      detail: `items=${set.items.length}, cross-belief=${crossItemsOf(set.items).length}`,
    })
  }

  return checks
}

function snapshot(b: Belief): string {
  return JSON.stringify({
    truth_status: b.truth_status,
    retrieval_status: b.retrieval_status,
    security_status: b.security_status,
    freshness_status: b.freshness_status,
    confidence: b.confidence,
  })
}

// ── Backend-independent: the shared (subject, relation) key helper ────────────

function sharedKeyChecks(): Check[] {
  const checks: Check[] = []
  checks.push({
    name: "shared key: predicateKey is the exported (subject, relation) helper",
    pass: predicateKey("a", "b") === JSON.stringify(["a", "b"]),
    detail: `predicateKey("a","b")=${predicateKey("a", "b")}`,
  })
  checks.push({
    name: "shared key: collision-free across the delimiter byte",
    pass: predicateKey("a b", "c") !== predicateKey("a", "b c"),
    detail: `${predicateKey("a b", "c")} ≠ ${predicateKey("a", "b c")}`,
  })
  return checks
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<{ passed: boolean; checks: Check[]; notes: string[] }> {
  const runId = crypto.randomUUID().slice(0, 8)
  const checks: Check[] = []
  const notes: string[] = []

  checks.push(...sharedKeyChecks())

  // In-memory: always.
  const mem: Stores = {
    claims: new InMemoryClaimStore(),
    beliefs: new InMemoryBeliefStore(),
    evidence: new InMemoryEvidenceStore(),
  }
  checks.push(...(await runSuite(mem, "in-memory", runId)))

  // Postgres: gated on LODESTAR_TEST_DATABASE_URL (store-parity AC, by execution).
  const dbUrl = process.env.LODESTAR_TEST_DATABASE_URL
  if (dbUrl) {
    const pg = createPostgresStores(dbUrl)
    await pg.ensureSchema()
    try {
      checks.push(
        ...(await runSuite(
          { claims: pg.claims, beliefs: pg.beliefs, evidence: pg.evidence },
          "postgres",
          runId,
        )),
      )
      notes.push("Postgres store-parity leg ran against LODESTAR_TEST_DATABASE_URL.")
    } finally {
      await pg.close()
    }
  } else {
    notes.push(
      "Postgres store-parity leg SKIPPED: LODESTAR_TEST_DATABASE_URL is unset. " +
        "The in-memory leg passed; set the var (CI does) to discharge the store-parity AC by execution.",
    )
  }

  return { passed: checks.every((c) => c.pass), checks, notes }
}

const result = await main()
console.log("─".repeat(72))
console.log("probe: evidence_linker_cross_belief_join")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const c of result.checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`)
  console.log(`      ${c.detail}`)
}
for (const n of result.notes) console.log(`  • ${n}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
