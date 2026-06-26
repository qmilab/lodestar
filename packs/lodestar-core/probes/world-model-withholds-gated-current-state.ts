#!/usr/bin/env bun
/**
 * Probe: world_model_withholds_gated_current_state
 *
 * Locks the #165 / ADR-0037 invariant: a world-model write (CognitiveCore.ingest
 * step 6) honours the SAME auto-observation gate the belief gate does. A claim
 * updates current state only if its evidence both nets positive AND clears the
 * gate. When the strongest support is `external_document` / `model_inference`,
 * the firewall keeps the belief `unverified` (Parallax) — and now the world
 * model, the ungated "current state" store a planner reads blindly, WITHHOLDS
 * the write too. The withholding is recorded on `IngestResult.worldModelWithheld`
 * so the audit trail shows the gate held on this side door, not just on beliefs.
 *
 * Why this matters: before #165, a positive-but-gated claim — a lone poisoned
 * `external_document` value — still wrote the world model. Nothing reads the world
 * model back into a decision *yet* (no planner.ts), so the exposure was latent;
 * but "a planner reads current state to decide" is the world model's whole
 * purpose. The moment a real agent uses it as intended, an unverified poisoned
 * value would reach a decision, bypassing the gate that exists to stop it.
 *
 * We WITHHOLD rather than write-and-flag deliberately (ADR-0037): the world model
 * has no read-time gate to enforce a flag, and a flagged write would shadow a
 * previously gate-cleared value. A gated claim never calls `worldModel.set`, so it
 * can never append a version — shadowing is structurally impossible. The full
 * record still lives as the `unverified` belief.
 *
 * Acceptance criteria pinned here (#165 / ADR-0037):
 *   AC#1  a lone `external_document` positive claim is WITHHELD: the world model
 *         has no entry for the key (get → undefined, history length 0), the claim
 *         is recorded in `worldModelWithheld` with quality `external_document`,
 *         and the belief is `unverified`.
 *   AC#2  positive control — a gate-cleared `direct_observation` claim DOES write
 *         the world model (and `worldModelWithheld` is empty); proves the gate,
 *         not a broken write path, is what withholds in AC#1.
 *   AC#3  a gated write never SHADOWS a prior gate-cleared value: with a prior
 *         direct_observation value in place, a later gated claim for the same key
 *         leaves the world model reading the gate-cleared value and appends NO new
 *         version, while recording the withholding.
 *   AC#4  the gate keys on FINAL evidence, not source: an `external_document`
 *         claim CORROBORATED by a higher-quality independent belief clears the
 *         gate (the cross-belief join lifts its strongest quality) and DOES write
 *         current state. The inverse of AC#1.
 *
 * The world model is in-memory only (no Postgres backend exists) and the gating
 * decision lives in core.ts independent of the belief-store backend, so this probe
 * runs in-memory only — there is no store-parity dimension to discharge.
 */

import {
  type ClaimExtractor,
  CognitiveCore,
  DocAwareEvidenceLinker,
  ExplanationGenerator,
  InMemoryWorldModel,
  type WorldModel,
  lookupExtractor,
  registerExtractor,
} from "@qmilab/lodestar-cognitive-core"
import type { Claim, Observation, ResourceScope } from "@qmilab/lodestar-core"
import { registry } from "@qmilab/lodestar-core"
import {
  type BeliefStore,
  type ClaimStore,
  type EvidenceStore,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { z } from "zod"

// ── Probe schemas + extractors (registered once) ─────────────────────────────

const DOC_SCHEMA = "documentation.wmgate@1" // → external_document via DocAware (gated)
const OBS_SCHEMA = "probe.wmgate.obs@1" // → direct_observation via base linker (cleared)

function makeExtractor(schema_key: string): ClaimExtractor {
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
        structured_predicate: {
          subject: payload.subject!,
          relation: payload.relation!,
          object: payload.object,
        },
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

function registerOnce(schema_key: string, shape: z.ZodTypeAny): void {
  if (!registry.has(schema_key)) registry.register(schema_key, shape)
  if (lookupExtractor(schema_key)?.schema_key !== schema_key) {
    registerExtractor(makeExtractor(schema_key))
  }
}

const PRED_SHAPE = z.object({
  subject: z.string(),
  relation: z.string(),
  object: z.unknown(),
})
registerOnce(DOC_SCHEMA, PRED_SHAPE.extend({ path: z.string() }))
registerOnce(OBS_SCHEMA, PRED_SHAPE)

// ── Harness ──────────────────────────────────────────────────────────────────

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
  worldModel: WorldModel
  stores: Stores
}

function buildSuite(): Suite {
  const stores: Stores = {
    claims: new InMemoryClaimStore(),
    beliefs: new InMemoryBeliefStore(),
    evidence: new InMemoryEvidenceStore(),
  }
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
  return { core, worldModel, stores }
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

const PREDICATE = { subject: "/charge", relation: "requires" } as const
const KEY = `${PREDICATE.subject}.${PREDICATE.relation}`

async function main(): Promise<{ passed: boolean; checks: Check[]; notes: string[] }> {
  const runId = crypto.randomUUID().slice(0, 8)
  const checks: Check[] = []
  const sc = (name: string) => scope(`${name}-${runId}`)

  // ── AC#1: a lone external_document positive claim is WITHHELD ──────────────
  {
    const { core, worldModel } = buildSuite()
    const s = sc("lone-gated")
    const r = await ingest(core, s, DOC_SCHEMA, { path: "/DEV.md", ...PREDICATE, object: "auth" }, "fs.read")
    const belief = r.beliefs[0]
    const wm = await worldModel.get(KEY, s)
    const hist = await worldModel.history(KEY, s)
    const withheld = r.worldModelWithheld.find((w) => w.key === KEY)

    checks.push({
      name: "AC#1: lone external_document belief stays unverified (gate holds on the belief)",
      pass: belief?.truth_status === "unverified",
      detail: `belief truth_status=${belief?.truth_status ?? "(not adopted)"}`,
    })
    checks.push({
      name: "AC#1: the gated claim is WITHHELD from the world model (no entry written)",
      pass: wm === undefined && hist.length === 0,
      detail: `world model ${KEY} = ${JSON.stringify(wm?.value)} (expected undefined), history length=${hist.length} (expected 0)`,
    })
    checks.push({
      name: "AC#1: the withholding is recorded in worldModelWithheld with the blocking quality",
      pass: !!withheld && withheld.quality === "external_document",
      detail: withheld
        ? `worldModelWithheld carries {key:${withheld.key}, quality:${withheld.quality}}`
        : "key absent from worldModelWithheld",
    })
    checks.push({
      name: "AC#1: a withheld claim does NOT appear in worldModelUpdates",
      pass: !r.worldModelUpdates.includes(KEY),
      detail: `worldModelUpdates=${JSON.stringify(r.worldModelUpdates)}`,
    })
  }

  // ── AC#2: positive control — a gate-cleared direct_observation DOES write ──
  {
    const { core, worldModel } = buildSuite()
    const s = sc("cleared-write")
    const r = await ingest(core, s, OBS_SCHEMA, { ...PREDICATE, object: "auth" }, "probe.obs")
    const belief = r.beliefs[0]
    const wm = await worldModel.get(KEY, s)

    checks.push({
      name: "AC#2 (control): a direct_observation claim clears the gate and is supported",
      pass: belief?.truth_status === "supported",
      detail: `belief truth_status=${belief?.truth_status ?? "(not adopted)"}`,
    })
    checks.push({
      name: "AC#2 (control): the gate-cleared claim DOES write current state",
      pass: wm?.value === "auth" && r.worldModelUpdates.includes(KEY),
      detail: `world model ${KEY} = ${JSON.stringify(wm?.value)} (expected "auth"), worldModelUpdates=${JSON.stringify(r.worldModelUpdates)}`,
    })
    checks.push({
      name: "AC#2 (control): nothing withheld for a gate-cleared write",
      pass: r.worldModelWithheld.length === 0,
      detail: `worldModelWithheld=${JSON.stringify(r.worldModelWithheld)}`,
    })
  }

  // ── AC#3: a gated write never SHADOWS a prior gate-cleared value ───────────
  // Seed a gate-cleared value, then make its belief an INELIGIBLE join peer
  // (retrieval_status → blocked) so a later external_document claim for the same
  // key stays positive-but-gated (the join can't corroborate or contradict it).
  // The gated write must leave the prior value and history untouched.
  {
    const { core, worldModel, stores } = buildSuite()
    const s = sc("no-shadow")
    const r1 = await ingest(core, s, OBS_SCHEMA, { ...PREDICATE, object: "auth" }, "probe.obs")
    const b1 = r1.beliefs[0]
    const wmBefore = await worldModel.get(KEY, s)
    // Hard-demote the seed belief so the cross-belief join ignores it.
    if (b1) {
      await stores.beliefs.transition({
        belief_id: b1.id,
        axis: "retrieval_status",
        from_value: "restricted",
        to_value: "blocked",
        by_actor_id: "probe-actor",
        rationale_id: crypto.randomUUID(),
      })
    }
    // A lone gated claim with a DIFFERENT object — would-be poison.
    const r2 = await ingest(core, s, DOC_SCHEMA, { path: "/DEV.md", ...PREDICATE, object: "evil" }, "fs.read")
    const wmAfter = await worldModel.get(KEY, s)
    const hist = await worldModel.history(KEY, s)
    const withheld = r2.worldModelWithheld.find((w) => w.key === KEY)

    checks.push({
      name: "AC#3 (setup): the seed direct_observation wrote the gate-cleared value",
      pass: wmBefore?.value === "auth",
      detail: `world model ${KEY} = ${JSON.stringify(wmBefore?.value)} (expected "auth")`,
    })
    checks.push({
      name: "AC#3: the gated claim does NOT shadow the prior value (read stays gate-cleared)",
      pass: wmAfter?.value === "auth",
      detail: `world model ${KEY} = ${JSON.stringify(wmAfter?.value)} (expected "auth", not "evil")`,
    })
    checks.push({
      name: "AC#3: the gated claim appends NO new world-model version",
      pass: hist.length === 1,
      detail: `history length=${hist.length} (expected 1 — only the seed write)`,
    })
    checks.push({
      name: "AC#3: the withheld gated write is still recorded",
      pass: !!withheld && withheld.quality === "external_document",
      detail: withheld
        ? `worldModelWithheld carries {key:${withheld.key}, quality:${withheld.quality}}`
        : "key absent from worldModelWithheld",
    })
  }

  // ── AC#4: the gate keys on FINAL evidence — a corroborated doc claim writes ──
  {
    const { core, worldModel } = buildSuite()
    const s = sc("corroborated")
    // Independent higher-quality belief on the same predicate + object.
    await ingest(core, s, OBS_SCHEMA, { ...PREDICATE, object: "auth" }, "probe.obs")
    // The doc claim agrees → the cross-belief join lifts its strongest quality
    // to direct_observation → the gate clears → it writes current state.
    const r2 = await ingest(core, s, DOC_SCHEMA, { path: "/DEV.md", ...PREDICATE, object: "auth" }, "fs.read")
    const docBelief = r2.beliefs[0]
    const wm = await worldModel.get(KEY, s)

    checks.push({
      name: "AC#4: a corroborated external_document claim clears the gate → supported",
      pass: docBelief?.truth_status === "supported",
      detail: `doc belief truth_status=${docBelief?.truth_status ?? "(not adopted)"}`,
    })
    checks.push({
      name: "AC#4: the gate-cleared (corroborated) claim DOES write current state",
      pass: wm?.value === "auth" && r2.worldModelUpdates.includes(KEY) && r2.worldModelWithheld.length === 0,
      detail: `world model ${KEY} = ${JSON.stringify(wm?.value)}, updates=${JSON.stringify(r2.worldModelUpdates)}, withheld=${JSON.stringify(r2.worldModelWithheld)}`,
    })
  }

  return { passed: checks.every((c) => c.pass), checks, notes: [] }
}

const result = await main()
console.log("─".repeat(72))
console.log("probe: world_model_withholds_gated_current_state")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const c of result.checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`)
  console.log(`      ${c.detail}`)
}
for (const n of result.notes) console.log(`  • ${n}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
