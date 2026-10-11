#!/usr/bin/env bun
/**
 * Probe: taint_projection_matches_dependents
 *
 * The belief taint / blast-radius projection (#182): `taintSet(events, beliefId)`
 * answers "what did this belief touch?" by walking the causal edges the log already
 * records (belief → decision → action → outcome → effect observation → claim →
 * belief …). The invariant is that the set is EXACT: every real dependent, and
 * nothing else — a blast-radius that over-reports is noise, one that under-reports
 * hides damage.
 *
 * Run against a REAL on-disk NDJSON log (EventLogWriter → EventLogReader). The
 * seeded session has one quarantined belief (b-root) and four decision chains:
 *
 *   d-direct   depends on [b-root, b-bystander] → a-direct (completed) → o-direct
 *              → obs-effect → claim c-derived → b-derived        (transitive hop)
 *   d-held     depends on [b-root] → a-held (pending_approval, secret)
 *   d-second   depends on [b-derived] → a-second (rejected, no outcome)
 *   d-loop     depends on [b-derived] → a-loop → o-loop → obs-feedback → claim
 *              c-root (the ROOT's own claim) → b-root          (a cycle back)
 *   d-guard    depends on [b-root] → a-guard, NO action.outcome (ordinary Guard / MCP
 *              sessions emit none): the kernel's observation.recorded with
 *              source.invocation_id = a-guard → claim c-guard → b-guard
 *   d-unrelated depends on [b-bystander] only → a-unrelated → o-unrelated →
 *              obs-unrelated → b-unrelated-derived              (must be excluded)
 *
 *   A — the taint set equals exactly the known dependents (decisions, actions,
 *       outcomes, beliefs): d-direct, d-held, d-second, d-loop; their four
 *       actions; o-direct, o-loop; b-root, b-derived — and NOTHING from the
 *       unrelated chain. (headline)
 *   B — transitive: b-derived (reached via an outcome's effect observation) pulls
 *       in d-second and d-loop at wave 2, and a held / rejected action is included
 *       with its phase.
 *   C — the cycle terminates: the loop back to b-root adds nothing and every id
 *       appears once.
 *   D — the sensitivity ceiling redacts: at the default `internal`, the secret
 *       action's intent/inputs, every decision's question (fail-closed) and the
 *       confidential claim's statement are withheld — the node keeps its id and
 *       `payload_hash`; at `secret` they are present; an invalid ceiling throws.
 *   E — read-only: the log tree is byte-identical and the input array unmutated.
 *   F — a belief nothing depends on yields an empty dependent set and an unknown
 *       belief reports `root_found: false`.
 */

import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Action, Belief, Claim } from "@qmilab/lodestar-core"
import { FIREWALL_BELIEF_ADOPTED_EVENT_TYPE } from "@qmilab/lodestar-core"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
} from "@qmilab/lodestar-event-log"
import { taintSet } from "@qmilab/lodestar-trace"

interface ProbeResult {
  passed: boolean
  details: string
}

const PROJECT = "taint-probe-project"
const SESSION = "taint-probe-session"
const ACTOR = "taint-probe-actor"
const TS = "2026-10-11T00:00:00.000Z"

function fail(details: string): ProbeResult {
  return { passed: false, details }
}

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

function belief(id: string, claimId: string, o: Partial<Belief> = {}): Belief {
  return {
    id,
    claim_id: claimId,
    confidence: 0.9,
    calibration_class: "probe",
    scope: { level: "project", identifier: PROJECT },
    sensitivity: "internal",
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: TS,
    ...o,
  }
}

function claim(
  id: string,
  statement: string,
  sources: string[],
  sensitivity: Claim["sensitivity"] = "internal",
): Claim {
  return {
    id,
    statement,
    structured_predicate: { subject: id, relation: "is", object: statement },
    source_observation_ids: sources,
    extraction_method: "tool",
    extracted_by: ACTOR,
    status: "accepted",
    scope: { level: "project", identifier: PROJECT },
    sensitivity,
    authors: [ACTOR],
    created_at: TS,
  }
}

function action(
  id: string,
  decisionId: string,
  phase: Action["phase"],
  dataSensitivity: Action["contract"]["data_sensitivity"] = "private",
): Action {
  return {
    id,
    decision_id: decisionId,
    intent: `intent-of-${id}`,
    tool: "probe.tool",
    inputs: { marker: `inputs-of-${id}` },
    contract: {
      required_level: 3,
      blast_radius: "project",
      reversibility: "reversible",
      scope: { level: "project", identifier: PROJECT },
      data_sensitivity: dataSensitivity,
      preconditions: [],
    },
    phase,
    audit: [],
    proposed_at: TS,
    proposed_by: ACTOR,
  }
}

function decision(id: string, deps: string[]): Record<string, unknown> {
  return {
    id,
    question: `question-of-${id}`,
    options: [{ id: "go", description: "go" }],
    selected_option_id: "go",
    rationale_id: `exp-${id}`,
    belief_dependencies: deps,
    policy_dependencies: [],
    made_by: ACTOR,
    made_at: TS,
  }
}

async function seedLog(rootDir: string): Promise<void> {
  const writer = new EventLogWriter(rootDir)
  let n = 0
  const append = (type: string, payload: unknown): Promise<unknown> => {
    n += 1
    return writer.append({
      schema_version: "1",
      project_id: PROJECT,
      session_id: SESSION,
      actor_id: ACTOR,
      timestamp: TS,
      causal_parent_ids: [],
      versions: {},
      id: `ev-${n}`,
      type,
      payload,
    })
  }
  const adopt = async (b: Belief): Promise<void> => {
    await append("belief.adopted", b)
    await append(FIREWALL_BELIEF_ADOPTED_EVENT_TYPE, {
      kind: "belief.adopted",
      belief_id: b.id,
      claim_id: b.claim_id,
      evidence_id: `evid-${b.id}`,
      rationale_id: `exp-${b.id}`,
      by_authority: "promotion",
      at: TS,
      by_actor_id: ACTOR,
    })
  }
  const outcome = (id: string, actionId: string, effects: string[]): Promise<unknown> =>
    append("action.outcome", {
      id,
      action_id: actionId,
      result: "success",
      effect_observation_ids: effects,
      side_effects_observed: [],
      duration_ms: 5,
      observed_at: TS,
    })

  // The root: a quarantined belief whose claim is itself sourced from obs-feedback
  // (that edge closes the cycle via d-loop's outcome). Confidential claim → the
  // statement is withheld at the default ceiling.
  await append(
    "claim.extracted",
    claim("c-root", "Deploy tokens may be shared.", ["obs-feedback"], "confidential"),
  )
  await adopt(belief("b-root", "c-root", { security_status: "quarantined" }))
  await append("claim.extracted", claim("c-bystander", "CI is green.", ["obs-ci"]))
  await adopt(belief("b-bystander", "c-bystander"))

  // d-direct → a-direct → o-direct → obs-effect → c-derived → b-derived
  await append("decision.made", decision("d-direct", ["b-root", "b-bystander"]))
  await append("action.proposed", action("a-direct", "d-direct", "proposed"))
  await append("action.completed", action("a-direct", "d-direct", "completed"))
  await outcome("o-direct", "a-direct", ["obs-effect"])
  await append(
    "claim.extracted",
    claim("c-derived", "Token rotation is unnecessary.", ["obs-effect"], "confidential"),
  )
  await adopt(belief("b-derived", "c-derived"))

  // d-held → a-held (secret, parked)
  await append("decision.made", decision("d-held", ["b-root"]))
  await append("action.pending_approval", action("a-held", "d-held", "pending_approval", "secret"))
  await outcome("o-held", "a-held", ["obs-held-effect"])
  // A later, forged duplicate naming a DIFFERENT decision must not erase the genuine edge.
  await append(
    "action.pending_approval",
    action("a-held", "d-unrelated", "pending_approval", "secret"),
  )

  // d-guard → a-guard: output observation links by invocation_id, no outcome event
  await append("decision.made", decision("d-guard", ["b-root"]))
  await append("action.completed", action("a-guard", "d-guard", "completed"))
  await append("observation.recorded", {
    id: "obs-guard-out",
    schema: "probe.output@1",
    payload: { ok: true },
    source: { tool: "probe.tool", invocation_id: "a-guard", captured_at: TS },
    context: { session_id: SESSION, project_id: PROJECT, actor_id: ACTOR },
    trust: "validated",
    sensitivity: "internal",
  })
  await append("claim.extracted", claim("c-guard", "Guard-observed fact.", ["obs-guard-out"]))
  await adopt(belief("b-guard", "c-guard"))

  // wave 2: depend on b-derived
  await append("decision.made", decision("d-second", ["b-derived"]))
  await append("action.rejected", action("a-second", "d-second", "rejected"))
  await append("decision.made", decision("d-loop", ["b-derived"]))
  await append("action.completed", action("a-loop", "d-loop", "completed"))
  await outcome("o-loop", "a-loop", ["obs-feedback"])

  // unrelated chain: must be excluded entirely
  await append("decision.made", decision("d-unrelated", ["b-bystander"]))
  await append("action.completed", action("a-unrelated", "d-unrelated", "completed"))
  await outcome("o-unrelated", "a-unrelated", ["obs-unrelated"])
  await append(
    "claim.extracted",
    claim("c-unrelated", "Unrelated downstream fact.", ["obs-unrelated"]),
  )
  await adopt(belief("b-unrelated-derived", "c-unrelated"))

  // a leaf belief nothing depends on
  await append("claim.extracted", claim("c-leaf", "Nobody uses this.", ["obs-leaf"]))
  await adopt(belief("b-leaf", "c-leaf"))
}

const sorted = (xs: string[]): string => [...xs].sort().join(",")

async function run(): Promise<ProbeResult> {
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-taint-"))
  try {
    await seedLog(rootDir)
    const hashBefore = hashTree(rootDir)
    const events = await new EventLogReader(rootDir).readAll(PROJECT)
    const snapshot = JSON.stringify(events)

    const t = taintSet(events, "b-root")

    // ── A / B / C: the exact set ────────────────────────────────────────────
    const expect = {
      decisions: "d-direct,d-guard,d-held,d-loop,d-second",
      actions: "a-direct,a-guard,a-held,a-loop,a-second",
      outcomes: "o-direct,o-held,o-loop",
      beliefs: "b-derived,b-guard,b-root",
    }
    const got = {
      decisions: sorted(t.decisions.map((d) => d.decision_id)),
      actions: sorted(t.actions.map((a) => a.action_id)),
      outcomes: sorted(t.outcomes.map((o) => o.outcome_id)),
      beliefs: sorted(t.beliefs.map((b) => b.belief_id)),
    }
    for (const k of ["decisions", "actions", "outcomes", "beliefs"] as const) {
      if (got[k] !== expect[k]) {
        return fail(`taint ${k} should be exactly [${expect[k]}] but were [${got[k]}]`)
      }
    }
    if (!t.root_found) return fail("root belief reported as not found")

    const wave = (xs: Array<{ depth: number }>): string => xs.map((x) => x.depth).join(",")
    const d2 = t.decisions.filter((d) => d.depth === 2).map((d) => d.decision_id)
    if (sorted(d2) !== "d-loop,d-second") {
      return fail(
        `transitive decisions should be reached at wave 2, got [${d2}] (${wave(t.decisions)})`,
      )
    }
    const phases = Object.fromEntries(t.actions.map((a) => [a.action_id, a.phase]))
    if (phases["a-held"] !== "pending_approval" || phases["a-second"] !== "rejected") {
      return fail(
        `held / rejected actions must be included with their phase: ${JSON.stringify(phases)}`,
      )
    }
    const ids = [
      ...t.decisions.map((d) => d.decision_id),
      ...t.actions.map((a) => a.action_id),
      ...t.outcomes.map((o) => o.outcome_id),
      ...t.beliefs.map((b) => b.belief_id),
    ]
    if (new Set(ids).size !== ids.length) return fail(`an id was visited twice: ${ids}`)

    // ── D: ceiling ──────────────────────────────────────────────────────────
    const held = t.actions.find((a) => a.action_id === "a-held")
    const direct = t.actions.find((a) => a.action_id === "a-direct")
    if (
      !held?.redacted ||
      held.intent !== undefined ||
      held.inputs !== undefined ||
      !held.payload_hash
    ) {
      return fail("secret action should be redacted (hash kept) at the internal ceiling")
    }
    if (!direct || direct.redacted || direct.intent !== "intent-of-a-direct") {
      return fail("private action should be visible at the internal ceiling")
    }
    if (t.decisions.some((d) => d.question !== undefined || !d.redacted)) {
      return fail("decisions must fail closed to redacted at the internal ceiling")
    }
    const derived = t.beliefs.find((b) => b.belief_id === "b-derived")
    const oHeld = t.outcomes.find((o) => o.outcome_id === "o-held")
    if (
      !oHeld?.redacted ||
      oHeld.result !== undefined ||
      oHeld.effect_observation_ids.join() !== "obs-held-effect"
    ) {
      return fail("a redacted outcome must hide its result but keep its effect-observation edges")
    }
    if (!derived?.redacted || derived.statement !== undefined || !derived.payload_hash) {
      return fail("confidential claim statement should be withheld at the internal ceiling")
    }
    const open = taintSet(events, "b-root", { sensitivityCeiling: "secret" })
    if (
      open.actions.some((a) => a.redacted || a.intent === undefined) ||
      open.decisions.some((d) => d.question === undefined) ||
      open.beliefs.some((b) => b.statement === undefined)
    ) {
      return fail("nothing should be redacted at the secret ceiling")
    }
    if (sorted(open.actions.map((a) => a.action_id)) !== expect.actions) {
      return fail("the ceiling must change content, never membership")
    }
    let threw = false
    try {
      taintSet(events, "b-root", { sensitivityCeiling: "bogus" as never })
    } catch {
      threw = true
    }
    if (!threw) return fail("an invalid ceiling must throw, not silently redact nothing")

    // ── F: leaf + unknown ───────────────────────────────────────────────────
    const leaf = taintSet(events, "b-leaf")
    if (
      leaf.decisions.length + leaf.actions.length + leaf.outcomes.length !== 0 ||
      leaf.beliefs.length !== 1
    ) {
      return fail("a belief nothing depends on must have an empty dependent set")
    }
    if (taintSet(events, "b-does-not-exist").root_found) {
      return fail("an unknown belief must report root_found: false")
    }

    // ── E: read-only ────────────────────────────────────────────────────────
    if (hashTree(rootDir) !== hashBefore) return fail("the log changed on disk")
    if (JSON.stringify(events) !== snapshot) return fail("the input events array was mutated")

    return {
      passed: true,
      details: [
        `Taint set of quarantined b-root over a ${events.length}-event on-disk log:`,
        `  • decisions [${got.decisions}], actions [${got.actions}], outcomes [${got.outcomes}], beliefs [${got.beliefs}] — exactly the known dependents.`,
        "  • EXCLUDED: d-unrelated / a-unrelated / o-unrelated / b-unrelated-derived / b-bystander (no edge to b-root).",
        "  • Transitive: b-derived (via o-direct's effect observation) pulled in d-second + d-loop at wave 2; held + rejected actions included with phase; the loop back to b-root terminated.",
        "  • Ceiling `internal`: secret action, decision questions (fail-closed) and the confidential statement redacted (hash kept); `secret` shows all; invalid ceiling throws.",
        `  • Read-only: log tree byte-identical (hash ${hashBefore.slice(0, 12)}), input array untouched.`,
      ].join("\n"),
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: taint_projection_matches_dependents")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
