#!/usr/bin/env bun
/**
 * Probe: corroboration_strength_rewards_independent_sources
 *
 * The corroboration-aware evidence scalar (#158, ADR-0036). `aggregateStrength`
 * — the firewall's **gate input** — is normalized `(S − C)/(S + C)`, so an
 * all-supporting set is *always exactly `1.0`* no matter how many independent
 * sources back it; only contradiction moves it. That is deliberate: it keeps the
 * `>= 0.7` promotion threshold calibration-stable. So corroboration is made
 * legible separately, by `corroborationStrength` — a read-side **ranking**
 * signal ("best-evidenced first", e.g. the durable-memory harvest queue) that
 * **never feeds any gate**.
 *
 * The load-bearing property is exactly that split: the new scalar *rises* with
 * independent corroboration while the gate input it sits beside is **unmoved**,
 * so adding it cannot shift any belief's lifecycle and Parallax holds untouched.
 *
 * Two sections. SCALAR pins the function's contract directly; HARVEST drives the
 * **real** `harvestCandidates` projection over a real on-disk NDJSON log (seeded
 * by `EventLogWriter`, read back by `EventLogReader`) to prove the scalar is
 * surfaced on `MemoryCandidate` as a ranking signal and changes no candidacy.
 *
 *   A — monotone: N independent supporting groups score strictly higher than N−1.
 *   B — saturating + bounded: increments diminish; every score is < 1; empty = 0.
 *   C — quality-weighted: a `direct_observation` corroborator raises the score
 *       more than an `external_document` one over the same base.
 *   D — same-group dedup: two items in ONE `independence_group` do not inflate it
 *       (same independence semantics as `aggregateStrength`).
 *   E — contradiction dampens: a strong contradicting group pulls it toward 0.
 *   F — gate untouched (Parallax): `aggregateStrength` still returns exactly 1.0
 *       for an all-supporting set the new scalar now distinguishes (1 vs 2
 *       sources) — the number the promotion gate reads is byte-for-byte unmoved.
 *   G — harvest wiring: a corroborated supported lesson and a lone-source one
 *       BOTH surface as candidates (candidacy unchanged), but the corroborated
 *       one carries a strictly higher `corroboration` — the "rank best-evidenced
 *       first" use case the issue names.
 *   H — `corroboration` is present only when evidence is: a candidate whose
 *       evidence set is absent from the log surfaces with `corroboration`
 *       undefined.
 */

import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Belief, Claim, EvidenceItem, EvidenceSet } from "@qmilab/lodestar-core"
import {
  FIREWALL_BELIEF_ADOPTED_EVENT_TYPE,
  FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
} from "@qmilab/lodestar-core"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
} from "@qmilab/lodestar-event-log"
import { aggregateStrength, corroborationStrength } from "@qmilab/lodestar-memory-firewall"
import { harvestCandidates } from "@qmilab/lodestar-trace"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT = "corroboration-probe-project"
const SESSION = "corroboration-probe-session"
const ACTOR = "corroboration-probe-actor"
const EPS = 1e-9

function fail(details: string): ProbeResult {
  return { passed: false, details }
}

/** A single supporting evidence item in its own independence group. */
function item(
  group: string,
  quality: EvidenceItem["quality"] = "direct_observation",
  relation: EvidenceItem["relation"] = "supports",
): EvidenceItem {
  return {
    source_id: `obs-${group}`,
    relation,
    quality,
    independence_group: group,
    freshness: "fresh",
  }
}

/** An evidence set from a fixed list of items. */
function evidence(id: string, items: EvidenceItem[]): EvidenceSet {
  return {
    id,
    claim_id: `c-${id}`,
    items,
    assessed_by: ACTOR,
    assessed_at: "2026-06-25T00:00:00.000Z",
  }
}

/** N independent (distinct-group) supporting `direct_observation` sources. */
function independentSupport(n: number): EvidenceSet {
  return evidence(
    `ev-${n}`,
    Array.from({ length: n }, (_, i) => item(`g${i}`)),
  )
}

// ── Section: SCALAR ──────────────────────────────────────────────────────────
function scalarSection(): ProbeResult | { strengths: number[] } {
  // ── A/B: monotone + saturating + bounded ───────────────────────────────────
  const s = [0, 1, 2, 3, 4].map((n) => corroborationStrength(independentSupport(n)))
  // n = 0: empty support set → 0.
  if (Math.abs(s[0]!) > EPS) return fail(`empty evidence corroboration ${s[0]} != 0`)
  for (let n = 2; n <= 4; n++) {
    if (!(s[n]! > s[n - 1]! + EPS)) {
      return fail(
        `corroboration not monotone: ${n} groups (${s[n]}) !> ${n - 1} groups (${s[n - 1]})`,
      )
    }
    if (!(s[n]! < 1)) return fail(`corroboration ${s[n]} for ${n} groups is not < 1 (unbounded)`)
  }
  // Saturating: each added independent source adds strictly less than the last.
  const d1 = s[2]! - s[1]!
  const d2 = s[3]! - s[2]!
  if (!(d2 < d1 - EPS)) {
    return fail(`corroboration not saturating: Δ(2→3)=${d2} not < Δ(1→2)=${d1}`)
  }

  // ── C: quality-weighted — a stronger corroborator raises the score more ─────
  const base = item("g0") // one direct_observation
  const plusDirect = corroborationStrength(evidence("ev-qd", [base, item("g1")]))
  const plusDoc = corroborationStrength(evidence("ev-qx", [base, item("g1", "external_document")]))
  if (!(plusDirect > plusDoc + EPS)) {
    return fail(
      `quality not weighted: a direct_observation corroborator (${plusDirect}) did not raise more than an external_document one (${plusDoc})`,
    )
  }

  // ── D: same-group dedup — two items in ONE group == one source ──────────────
  const oneSource = corroborationStrength(evidence("ev-d1", [item("g0")]))
  const sameGroupTwice = corroborationStrength(
    evidence("ev-d2", [item("g0"), { ...item("g0"), source_id: "obs-g0-b" }]),
  )
  if (Math.abs(sameGroupTwice - oneSource) > EPS) {
    return fail(
      `same-group re-read inflated corroboration: 1 item=${oneSource}, 2-in-one-group=${sameGroupTwice}`,
    )
  }

  // ── E: contradiction dampens ────────────────────────────────────────────────
  const twoSupport = corroborationStrength(independentSupport(2))
  const twoSupportOneAgainst = corroborationStrength(
    evidence("ev-e", [item("g0"), item("g1"), item("g2", "direct_observation", "contradicts")]),
  )
  if (!(twoSupportOneAgainst < twoSupport - EPS)) {
    return fail(
      `contradiction did not dampen: with a contradicting group ${twoSupportOneAgainst} not < ${twoSupport}`,
    )
  }

  // ── F: gate input untouched (Parallax) ──────────────────────────────────────
  // Two independent external_document sources: aggregateStrength (the number the
  // promotion gate reads) is STILL exactly 1.0 — adding corroborationStrength
  // moved nothing the gate sees. The new scalar, by contrast, distinguishes 1
  // vs 2 such sources. (The gate also checks strongest-quality, untouched here,
  // which is what keeps two external_document beliefs at `unverified` — the full
  // ingest path is pinned by evidence-linker-cross-belief-join.)
  const oneDoc = evidence("ev-f1", [item("g0", "external_document")])
  const twoDocs = evidence("ev-f2", [
    item("g0", "external_document"),
    item("g1", "external_document"),
  ])
  if (
    Math.abs(aggregateStrength(oneDoc) - 1) > EPS ||
    Math.abs(aggregateStrength(twoDocs) - 1) > EPS
  ) {
    return fail(
      `aggregateStrength changed: all-supporting sets must stay exactly 1.0 (got ${aggregateStrength(oneDoc)}, ${aggregateStrength(twoDocs)}) — the gate input must be unmoved`,
    )
  }
  if (!(corroborationStrength(twoDocs) > corroborationStrength(oneDoc) + EPS)) {
    return fail(
      `corroborationStrength did not distinguish 1 vs 2 external_document sources (${corroborationStrength(oneDoc)} vs ${corroborationStrength(twoDocs)})`,
    )
  }

  return { strengths: s as number[] }
}

// ── Section: HARVEST (real NDJSON log) ───────────────────────────────────────
function belief(id: string, claimId: string, observedAt: string): Belief {
  return {
    id,
    claim_id: claimId,
    confidence: 0.95,
    calibration_class: "repo.policy",
    scope: { level: "project", identifier: PROJECT },
    sensitivity: "internal",
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: observedAt,
  }
}

function claim(id: string, statement: string): Claim {
  return {
    id,
    statement,
    structured_predicate: { subject: "repo", relation: "policy", object: statement },
    source_observation_ids: ["obs-1"],
    extraction_method: "tool",
    extracted_by: ACTOR,
    status: "accepted",
    scope: { level: "project", identifier: PROJECT },
    sensitivity: "internal",
    authors: [ACTOR],
    created_at: "2026-06-25T00:00:00.000Z",
  }
}

async function seedLog(rootDir: string): Promise<void> {
  const writer = new EventLogWriter(rootDir)
  const common = {
    schema_version: "1",
    project_id: PROJECT,
    session_id: SESSION,
    actor_id: ACTOR,
    timestamp: "2026-06-25T00:00:00.000Z",
    causal_parent_ids: [] as string[],
    versions: {},
  }
  let n = 0
  const append = (type: string, payload: unknown): Promise<unknown> => {
    n += 1
    return writer.append({ ...common, id: `ev-${n}`, type, payload })
  }
  // A firewall-authored adoption: the full record + the host audit that binds the
  // exact claim_id + evidence_id that cleared the gate (so the harvest projection
  // attaches that evidence — the input to the corroboration score).
  const adopt = async (b: Belief, evidenceId: string): Promise<void> => {
    await append("belief.adopted", b)
    await append(FIREWALL_BELIEF_ADOPTED_EVENT_TYPE, {
      kind: "belief.adopted",
      belief_id: b.id,
      claim_id: b.claim_id,
      evidence_id: evidenceId,
      rationale_id: `exp-${b.id}`,
      by_authority: "promotion",
      at: "2026-06-25T00:00:00.000Z",
      by_actor_id: ACTOR,
    })
  }

  // b-lone: one supporting direct_observation source. (The harvest projection
  // attaches evidence by the audit's evidence_id, so the builder's claim_id is
  // immaterial here.)
  await append("claim.extracted", claim("c-lone", "Service X listens on :8080."))
  await append("evidence.assessed", evidence("ev-lone", [item("lone-a")]))
  await adopt(belief("b-lone", "c-lone", "2026-06-25T00:01:00.000Z"), "ev-lone")

  // b-corrob: the SAME claim, corroborated by a second independent source.
  await append("claim.extracted", claim("c-corrob", "Service Y listens on :9090."))
  await append("evidence.assessed", evidence("ev-corrob", [item("corrob-a"), item("corrob-b")]))
  await adopt(belief("b-corrob", "c-corrob", "2026-06-25T00:02:00.000Z"), "ev-corrob")

  // b-noev: a genuine supported candidate whose evidence.assessed is NOT in the
  // log (its audit names ev-missing). It must still surface, with corroboration
  // undefined (present only when evidence is).
  await append("claim.extracted", claim("c-noev", "Deploys run on weekdays only."))
  await adopt(belief("b-noev", "c-noev", "2026-06-25T00:03:00.000Z"), "ev-missing")
}

/** Hash the whole log directory tree so any byte change is detectable. */
function hashTree(dir: string): string {
  const hash = createHash("sha256")
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else hash.update(`${full}:${readFileSync(full)}`)
    }
  }
  walk(dir)
  return hash.digest("hex")
}

async function run(): Promise<ProbeResult> {
  const scalar = scalarSection()
  if ("passed" in scalar) return scalar

  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-corroboration-"))
  try {
    await seedLog(rootDir)
    const hashBefore = hashTree(rootDir)
    const events = await new EventLogReader(rootDir).readAll(PROJECT)

    const candidates = harvestCandidates(events)
    const byId = new Map(candidates.map((c) => [c.belief.id, c]))

    // ── G: candidacy unchanged — every supported/clean belief surfaces ────────
    for (const id of ["b-lone", "b-corrob", "b-noev"]) {
      if (!byId.has(id)) {
        return fail(`${id} did not surface as a candidate — the corroboration scalar must not gate`)
      }
    }

    const lone = byId.get("b-lone")!
    const corrob = byId.get("b-corrob")!
    const noev = byId.get("b-noev")!

    if (lone.corroboration === undefined || corrob.corroboration === undefined) {
      return fail("a candidate with attached evidence is missing its corroboration score")
    }
    // ── G: the corroborated lesson ranks strictly higher ──────────────────────
    if (!(corrob.corroboration > lone.corroboration + EPS)) {
      return fail(
        `corroborated lesson (${corrob.corroboration}) did not outrank the lone-source lesson (${lone.corroboration}) in the harvest queue`,
      )
    }
    // The surfaced score must equal the scalar over the attached evidence (no drift).
    if (
      Math.abs(corrob.corroboration - corroborationStrength(corrob.evidence!)) > EPS ||
      Math.abs(lone.corroboration - corroborationStrength(lone.evidence!)) > EPS
    ) {
      return fail(
        "MemoryCandidate.corroboration disagrees with corroborationStrength over its evidence",
      )
    }

    // ── H: present only when evidence is ──────────────────────────────────────
    if (noev.evidence !== undefined) {
      return fail("b-noev unexpectedly carried evidence (its evidence.assessed is not in the log)")
    }
    if (noev.corroboration !== undefined) {
      return fail(
        `b-noev carried a corroboration score (${noev.corroboration}) with no evidence — it must be undefined`,
      )
    }

    // ── read-only ─────────────────────────────────────────────────────────────
    if (hashTree(rootDir) !== hashBefore) {
      return fail("the log tree changed after projection — harvestCandidates is not read-only")
    }

    return {
      passed: true,
      details: [
        "SCALAR — corroborationStrength rises with independent corroboration while the gate input stays put:",
        `  • monotone + saturating + bounded: 1..3 independent sources → ${scalar.strengths
          .slice(1, 4)
          .map((x) => x.toFixed(4))
          .join(" < ")} (saturating below 1; 4 sources also pinned < 1).`,
        "  • quality-weighted, same-group dedup'd, dampened by contradiction.",
        "  • Parallax: aggregateStrength(all-supporting) stayed exactly 1.0 for 1 AND 2 external_document sources — the promotion-gate input is unmoved; only the new ranking scalar distinguishes them.",
        "HARVEST — the scalar is surfaced as a ranking signal, gating nothing:",
        `  • b-corrob (2 independent sources) corroboration=${corrob.corroboration.toFixed(4)} > b-lone (1 source) ${lone.corroboration.toFixed(4)} — "best-evidenced first".`,
        "  • both still surface as candidates (candidacy = supported + clean, unchanged); b-noev (no evidence in log) surfaces with corroboration undefined.",
        `  • read-only: log tree byte-identical (hash ${hashBefore.slice(0, 12)}).`,
      ].join("\n"),
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: corroboration_strength_rewards_independent_sources")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
