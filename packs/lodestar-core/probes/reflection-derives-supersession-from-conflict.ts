#!/usr/bin/env bun
/**
 * Probe: reflection_derives_supersession_from_conflict
 *
 * Locks the reflection DERIVE rule (epic #154 child B). Reflection's cascade
 * rule only *reacts* to a `belief.transitioned → contradicted` event a sentinel
 * or the firewall already recorded. The DERIVE rule *derives* a contradiction
 * from live belief state: two `supported` beliefs in the same scope that share a
 * claim's `structured_predicate.(subject, relation)` but assert different
 * `object`s. It proposes a `belief_supersession` — the older belief
 * `superseded_by` the newer (recency is the one signal the rule has).
 *
 * Why two conflicting *supported* beliefs are seeded directly here: the #157
 * ingest-time evidence-linker join records a `contradicts` item against a
 * conflicting prior belief, which nets the new claim's strength ≤ 0 and BLOCKS
 * its adoption — so a conflicting pair cannot normally arise through one ingest
 * path. The derive rule is the reflection-time scan that catches conflicts that
 * entered through *different* paths (external-memory imports, user assertions,
 * separate sessions later merged). The probe models that by seeding the beliefs
 * directly into the firewall-governed store, exactly as #157's uncertainty
 * scenario seeds peers.
 *
 * Invariants pinned:
 *   A  happy path — two clean supported conflicting beliefs adopted in the
 *      window produce exactly ONE supersession proposal, oriented older→newer.
 *   B  propose-only — `run({apply:true})` SURFACES the proposal but does NOT
 *      transition the older belief (it stays `supported`); the applied summary
 *      counts it as `belief_supersessions_proposed`, never `belief_supersessions`.
 *   C  explicit apply — a reviewer applying the same proposal via the public
 *      `applyProposal` DOES supersede the older belief (truth_status=superseded,
 *      superseded_by → the newer). The apply path already existed; only detect
 *      is new.
 *   D  same object → no proposal (corroboration, not conflict).
 *   E  different (subject, relation) → no proposal.
 *   F  an invalidated/isolated peer (quarantined here) does NOT trigger a
 *      supersession — the same `isEligibleJoinPeer` gate the #157 join uses
 *      (+ a clean control proving the gate is what blocks it).
 *   G  the equal-sensitivity gate — a `secret` peer and an `internal` trigger
 *      never pair, in EITHER direction (the secret belief is also a window
 *      trigger), so a derived proposal can't signal a higher-compartment
 *      belief's existence (+ an equal-sensitivity control).
 *   H  an `unverified` peer does NOT trigger — the rule requires TWO supported
 *      beliefs (the linker keeps `unverified` for Parallax; the derive rule does
 *      not) (+ a supported control).
 *   I  single-fire idempotence — a later pass whose window holds no adoption
 *      event re-proposes nothing, though both supported beliefs still conflict
 *      in the store.
 *   J  incremental — a freshly-adopted belief conflicting with a PRE-EXISTING
 *      supported belief (whose adoption predates the window) still fires once.
 *   K  no stores → no-op (a dry-run inspection pass cannot derive conflicts).
 *   L  both real adoption-event shapes fire the rule — the BARE `belief.adopted`
 *      (full Belief object, id at `payload.id`, what hosts emit; A–K use it) and
 *      the `firewall.belief.adopted` audit twin (id at `payload.belief_id`).
 */

import {
  ExplanationGenerator,
  Reflection,
  type ReflectionEmitter,
} from "@qmilab/lodestar-cognitive-core"
import type {
  Belief,
  BeliefAuthority,
  Claim,
  EventEnvelope,
  ResourceScope,
  Sensitivity,
} from "@qmilab/lodestar-core"
import {
  type BeliefStore,
  type ClaimStore,
  type EvidenceStore,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"

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

const OLD_TS = "2026-01-01T00:00:00.000Z"
const NEW_TS = "2026-02-01T00:00:00.000Z"

function freshStores(): Stores {
  return {
    claims: new InMemoryClaimStore(),
    beliefs: new InMemoryBeliefStore(),
    evidence: new InMemoryEvidenceStore(),
  }
}

function scope(id: string): ResourceScope {
  return { level: "project", identifier: id }
}

function buildReflection(stores: Stores): Reflection {
  const firewall = new MemoryFirewall(
    stores.claims,
    stores.beliefs,
    stores.evidence,
    async () => {},
  )
  const explanations = new ExplanationGenerator("probe-actor")
  const emitter: ReflectionEmitter = {
    async emitReflectionCompleted() {
      return crypto.randomUUID()
    },
    async emitDecisionRevision() {
      return crypto.randomUUID()
    },
  }
  return new Reflection({
    beliefs: stores.beliefs,
    claims: stores.claims,
    evidence: stores.evidence,
    firewall,
    explanations,
    emitter,
    context: {
      project_id: "probe-project",
      session_id: "probe-session",
      actor_id: "probe-actor",
    },
  })
}

interface SeedOpts {
  sensitivity?: Sensitivity
  observedAt?: string
  truthStatus?: Belief["truth_status"]
  securityStatus?: Belief["security_status"]
  retrievalStatus?: Belief["retrieval_status"]
  confidence?: number
  authority?: BeliefAuthority
}

/**
 * Seed a belief + its claim directly into the firewall-governed store. The
 * derive rule reads `claim.structured_predicate` and live belief state only,
 * so no evidence set is needed; the belief defaults to a clean, confident,
 * supported, restricted state (an eligible join peer).
 */
async function seedBelief(
  stores: Stores,
  sc: ResourceScope,
  subject: string,
  relation: string,
  object: unknown,
  opts: SeedOpts = {},
): Promise<Belief> {
  const sensitivity = opts.sensitivity ?? "internal"
  const observed_at = opts.observedAt ?? OLD_TS
  const claim: Claim = {
    id: crypto.randomUUID(),
    statement: `seeded ${subject} ${relation} ${JSON.stringify(object)}`,
    structured_predicate: { subject, relation, object },
    source_observation_ids: [crypto.randomUUID()],
    extraction_method: "tool",
    extracted_by: "probe-actor",
    status: "extracted",
    scope: sc,
    sensitivity,
    authors: ["probe-actor"],
    created_at: observed_at,
  }
  await stores.claims.put(claim)
  const belief: Belief = {
    id: crypto.randomUUID(),
    claim_id: claim.id,
    confidence: opts.confidence ?? 0.95,
    calibration_class: "probe::derive",
    scope: sc,
    sensitivity,
    authority: opts.authority ?? "observed",
    truth_status: opts.truthStatus ?? "supported",
    retrieval_status: opts.retrievalStatus ?? "restricted",
    security_status: opts.securityStatus ?? "clean",
    freshness_status: "fresh",
    observed_at,
  }
  await stores.beliefs.put(belief)
  return belief
}

/**
 * The **bare `belief.adopted`** event a real host emits (guard `runGuarded`, the
 * MCP proxy, the runtime gate all `emit("belief.adopted", belief)`): its payload
 * is the **full `Belief` object**, so the belief id is `payload.id` — NOT
 * `payload.belief_id`. The probe uses this real shape so the derive rule's
 * window gate is exercised against what hosts actually write. The rule reads the
 * id and then looks the belief up in the governed store, so a forged event can
 * at most trigger a scan of a belief that is already legitimately stored (and
 * proposals are propose-only) — there is no authenticity gate to forge past.
 */
function adoptedEvent(belief: Belief, seq: number): EventEnvelope {
  return baseEnvelope(seq, "belief.adopted", "0.1.0", belief)
}

/**
 * The **`firewall.belief.adopted`** audit twin a host stamps alongside the bare
 * event: its payload carries `belief_id` (not the full belief). The derive rule
 * must accept this shape too — a stream may carry only the twin.
 */
function firewallAdoptedEvent(belief: Belief, seq: number): EventEnvelope {
  return baseEnvelope(seq, "firewall.belief.adopted", "1", {
    kind: "belief.adopted",
    belief_id: belief.id,
    claim_id: belief.claim_id,
    evidence_id: crypto.randomUUID(),
    rationale_id: crypto.randomUUID(),
    by_authority: "auto_observation",
    at: belief.observed_at,
    by_actor_id: "probe-actor",
  })
}

function baseEnvelope(
  seq: number,
  type: string,
  schema_version: string,
  payload: unknown,
): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    seq,
    type,
    schema_version,
    project_id: "probe-project",
    session_id: "probe-session",
    actor_id: "probe-actor",
    timestamp: new Date().toISOString(),
    logical_clock: seq,
    causal_parent_ids: [],
    payload_hash: "probe",
    payload,
    versions: {},
  }
}

function supersessionsOf(proposals: { kind: string }[]) {
  return proposals.filter(
    (p): p is { kind: "belief_supersession"; old_belief_id: string; new_belief_id: string } =>
      p.kind === "belief_supersession",
  )
}

async function run(): Promise<{ passed: boolean; checks: Check[] }> {
  const checks: Check[] = []

  // ── A: happy path — one proposal, oriented older → newer ──────────────────
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-A")
    const older = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: OLD_TS })
    const newer = await seedBelief(stores, sc, "/branch", "current", "release", {
      observedAt: NEW_TS,
    })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(older, 0), adoptedEvent(newer, 1)],
      apply: false,
    })
    const supers = supersessionsOf(result.payload.proposals)
    checks.push({
      name: "A: two conflicting supported beliefs produce exactly one supersession proposal",
      pass: supers.length === 1,
      detail: `supersession proposals=${supers.length}, total proposals=${result.payload.proposals.length}`,
    })
    checks.push({
      name: "A: the proposal is oriented older → newer (old=older belief, new=newer belief)",
      pass:
        supers.length === 1 &&
        supers[0]!.old_belief_id === older.id &&
        supers[0]!.new_belief_id === newer.id,
      detail:
        supers.length === 1
          ? `old=${supers[0]!.old_belief_id === older.id ? "older✓" : "WRONG"}, new=${supers[0]!.new_belief_id === newer.id ? "newer✓" : "WRONG"}`
          : "no single proposal",
    })
  }

  // ── B + C: propose-only under apply:true, then explicit apply commits ──────
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-BC")
    const older = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: OLD_TS })
    const newer = await seedBelief(stores, sc, "/branch", "current", "release", {
      observedAt: NEW_TS,
    })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(older, 0), adoptedEvent(newer, 1)],
      apply: true, // the load-bearing flag: even so, derive proposals must NOT apply
    })
    const supers = supersessionsOf(result.payload.proposals)
    const olderAfterRun = await stores.beliefs.get(older.id)
    checks.push({
      name: "B: under apply:true the proposal is surfaced but counted propose-only (not applied)",
      pass:
        result.applied.belief_supersessions_proposed === 1 &&
        result.applied.belief_supersessions === 0,
      detail: `proposed=${result.applied.belief_supersessions_proposed}, applied=${result.applied.belief_supersessions}`,
    })
    checks.push({
      name: "B: under apply:true the older belief is NOT auto-superseded (stays supported)",
      pass: olderAfterRun?.truth_status === "supported",
      detail: `older.truth_status after run({apply:true}) = ${olderAfterRun?.truth_status ?? "(missing)"}`,
    })

    // C: a reviewer applies the proposal explicitly.
    let applyThrew = false
    if (supers.length === 1) {
      try {
        await reflection.applyProposal(
          {
            kind: "belief_supersession",
            old_belief_id: supers[0]!.old_belief_id,
            new_belief_id: supers[0]!.new_belief_id,
            rationale_id: crypto.randomUUID(),
          },
          crypto.randomUUID(), // a reflection.completed event id, as run() would supply
        )
      } catch {
        applyThrew = true
      }
    }
    const olderAfterApply = await stores.beliefs.get(older.id)
    checks.push({
      name: "C: explicit applyProposal supersedes the older belief (superseded_by → newer)",
      pass:
        !applyThrew &&
        olderAfterApply?.truth_status === "superseded" &&
        olderAfterApply?.superseded_by === newer.id,
      detail: `older.truth_status=${olderAfterApply?.truth_status}, superseded_by=${olderAfterApply?.superseded_by === newer.id ? "newer✓" : olderAfterApply?.superseded_by}`,
    })
  }

  // ── D: same object → corroboration, no proposal ───────────────────────────
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-D")
    const a = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: OLD_TS })
    const b = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: NEW_TS })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(a, 0), adoptedEvent(b, 1)],
      apply: false,
    })
    checks.push({
      name: "D: two supported beliefs with the SAME object produce no proposal (no false positive)",
      pass: supersessionsOf(result.payload.proposals).length === 0,
      detail: `supersession proposals=${supersessionsOf(result.payload.proposals).length}`,
    })
  }

  // ── E: different (subject, relation) → no proposal ────────────────────────
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-E")
    const a = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: OLD_TS })
    const b = await seedBelief(stores, sc, "/deploy", "target", "prod", { observedAt: NEW_TS })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(a, 0), adoptedEvent(b, 1)],
      apply: false,
    })
    checks.push({
      name: "E: different (subject, relation) produces no proposal",
      pass: supersessionsOf(result.payload.proposals).length === 0,
      detail: `supersession proposals=${supersessionsOf(result.payload.proposals).length}`,
    })
  }

  // ── F: invalidated/isolated peer (quarantined) does not trigger ───────────
  {
    // F-control: identical setup, both clean → one proposal (gate is the cause).
    const ctl = freshStores()
    const ctlReflection = buildReflection(ctl)
    const scCtl = scope("derive-F-ctl")
    const cOld = await seedBelief(ctl, scCtl, "/lock", "holds", "keyA", { observedAt: OLD_TS })
    const cNew = await seedBelief(ctl, scCtl, "/lock", "holds", "keyB", { observedAt: NEW_TS })
    const ctlResult = await ctlReflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(cOld, 0), adoptedEvent(cNew, 1)],
      apply: false,
    })
    checks.push({
      name: "F-control: two clean supported conflicting beliefs DO produce a proposal",
      pass: supersessionsOf(ctlResult.payload.proposals).length === 1,
      detail: `supersession proposals=${supersessionsOf(ctlResult.payload.proposals).length}`,
    })

    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-F")
    const clean = await seedBelief(stores, sc, "/lock", "holds", "keyA", { observedAt: NEW_TS })
    const quarantined = await seedBelief(stores, sc, "/lock", "holds", "keyB", {
      observedAt: OLD_TS,
      securityStatus: "quarantined",
    })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(clean, 0), adoptedEvent(quarantined, 1)],
      apply: false,
    })
    checks.push({
      name: "F: a quarantined peer does NOT trigger a supersession (isEligibleJoinPeer gate holds, both directions)",
      pass: supersessionsOf(result.payload.proposals).length === 0,
      detail: `supersession proposals=${supersessionsOf(result.payload.proposals).length}`,
    })
  }

  // ── G: equal-sensitivity gate — secret peer never pairs with internal ─────
  {
    // G-control: equal sensitivity (internal/internal) → one proposal.
    const ctl = freshStores()
    const ctlReflection = buildReflection(ctl)
    const scCtl = scope("derive-G-ctl")
    const cOld = await seedBelief(ctl, scCtl, "/api", "needs", "tokA", {
      observedAt: OLD_TS,
      sensitivity: "internal",
    })
    const cNew = await seedBelief(ctl, scCtl, "/api", "needs", "tokB", {
      observedAt: NEW_TS,
      sensitivity: "internal",
    })
    const ctlResult = await ctlReflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(cOld, 0), adoptedEvent(cNew, 1)],
      apply: false,
    })
    checks.push({
      name: "G-control: equal-sensitivity (internal) conflicting beliefs produce a proposal",
      pass: supersessionsOf(ctlResult.payload.proposals).length === 1,
      detail: `supersession proposals=${supersessionsOf(ctlResult.payload.proposals).length}`,
    })

    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-G")
    const internalB = await seedBelief(stores, sc, "/api", "needs", "tokA", {
      observedAt: NEW_TS,
      sensitivity: "internal",
    })
    const secretB = await seedBelief(stores, sc, "/api", "needs", "tokB", {
      observedAt: OLD_TS,
      sensitivity: "secret",
    })
    // BOTH adopted in the window — so the secret belief is itself a trigger,
    // exercising the direction `max_sensitivity` alone would NOT block.
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(internalB, 0), adoptedEvent(secretB, 1)],
      apply: false,
    })
    checks.push({
      name: "G: a secret peer never pairs with an internal trigger (equal-sensitivity gate, both directions)",
      pass: supersessionsOf(result.payload.proposals).length === 0,
      detail: `supersession proposals=${supersessionsOf(result.payload.proposals).length}`,
    })
  }

  // ── H: an unverified peer does not trigger (rule requires TWO supported) ───
  {
    // H-control: supported peer → one proposal.
    const ctl = freshStores()
    const ctlReflection = buildReflection(ctl)
    const scCtl = scope("derive-H-ctl")
    const cOld = await seedBelief(ctl, scCtl, "/cfg", "is", "x", { observedAt: OLD_TS })
    const cNew = await seedBelief(ctl, scCtl, "/cfg", "is", "y", {
      observedAt: NEW_TS,
      truthStatus: "supported",
    })
    const ctlResult = await ctlReflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(cOld, 0), adoptedEvent(cNew, 1)],
      apply: false,
    })
    checks.push({
      name: "H-control: a supported peer produces a proposal",
      pass: supersessionsOf(ctlResult.payload.proposals).length === 1,
      detail: `supersession proposals=${supersessionsOf(ctlResult.payload.proposals).length}`,
    })

    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-H")
    const supported = await seedBelief(stores, sc, "/cfg", "is", "x", { observedAt: OLD_TS })
    const unverified = await seedBelief(stores, sc, "/cfg", "is", "y", {
      observedAt: NEW_TS,
      truthStatus: "unverified",
    })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [adoptedEvent(supported, 0), adoptedEvent(unverified, 1)],
      apply: false,
    })
    checks.push({
      name: "H: an unverified peer does NOT trigger a supersession (the linker keeps unverified; the derive rule does not)",
      pass: supersessionsOf(result.payload.proposals).length === 0,
      detail: `supersession proposals=${supersessionsOf(result.payload.proposals).length}`,
    })
  }

  // ── I: single-fire idempotence — a window with no adoption event re-fires nothing ──
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-I")
    const older = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: OLD_TS })
    const newer = await seedBelief(stores, sc, "/branch", "current", "release", {
      observedAt: NEW_TS,
    })
    const adoptions = [adoptedEvent(older, 0), adoptedEvent(newer, 1)]
    // First pass: both adoptions in window → fires once.
    const first = await reflection.run({ trigger: "programmatic", events: adoptions, apply: false })
    // Second pass: cursor advanced past the adoptions; the window holds only a
    // later, non-adoption domain event. The conflict still exists in the store
    // but must NOT be re-proposed.
    const trailing: EventEnvelope = {
      id: crypto.randomUUID(),
      seq: 2,
      type: "decision.made",
      schema_version: "1",
      project_id: "probe-project",
      session_id: "probe-session",
      actor_id: "probe-actor",
      timestamp: new Date().toISOString(),
      logical_clock: 2,
      causal_parent_ids: [],
      payload_hash: "probe",
      payload: { id: crypto.randomUUID(), question: "noop", belief_dependencies: [] },
      versions: {},
    }
    const second = await reflection.run({
      trigger: "programmatic",
      events: [...adoptions, trailing],
      since_seq: 1, // window = (seq > 1) = [trailing], no adoption event
      apply: false,
    })
    checks.push({
      name: "I: first pass fires once; a later pass with no adoption in its window re-proposes nothing",
      pass:
        supersessionsOf(first.payload.proposals).length === 1 &&
        supersessionsOf(second.payload.proposals).length === 0,
      detail: `first=${supersessionsOf(first.payload.proposals).length}, second=${supersessionsOf(second.payload.proposals).length}`,
    })
  }

  // ── J: incremental — a new belief conflicting with a PRE-EXISTING one fires ──
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-J")
    const preExisting = await seedBelief(stores, sc, "/svc", "status", "up", { observedAt: OLD_TS })
    const fresh = await seedBelief(stores, sc, "/svc", "status", "down", { observedAt: NEW_TS })
    // Only the fresh belief's adoption is in this window (the pre-existing one
    // predates the cursor); the conflict must still surface once.
    const result = await reflection.run({
      trigger: "tail_batch",
      events: [adoptedEvent(preExisting, 0), adoptedEvent(fresh, 1)],
      since_seq: 0, // window = (seq > 0) = [fresh adoption only]
      apply: false,
    })
    const supers = supersessionsOf(result.payload.proposals)
    checks.push({
      name: "J: a freshly-adopted belief conflicting with a pre-existing supported belief fires once (old=pre-existing)",
      pass:
        supers.length === 1 &&
        supers[0]!.old_belief_id === preExisting.id &&
        supers[0]!.new_belief_id === fresh.id,
      detail:
        supers.length === 1
          ? `old=${supers[0]!.old_belief_id === preExisting.id ? "pre-existing✓" : "WRONG"}`
          : `proposals=${supers.length}`,
    })
  }

  // ── K: no stores → the derive rule is a no-op, not an error ────────────────
  {
    const explanations = new ExplanationGenerator("probe-actor")
    const dryRun = new Reflection({
      explanations,
      context: {
        project_id: "probe-project",
        session_id: "probe-session",
        actor_id: "probe-actor",
      },
    })
    const someBelief: Belief = {
      id: crypto.randomUUID(),
      claim_id: crypto.randomUUID(),
      confidence: 0.95,
      calibration_class: "probe",
      scope: scope("derive-K"),
      sensitivity: "internal",
      authority: "observed",
      truth_status: "supported",
      retrieval_status: "restricted",
      security_status: "clean",
      freshness_status: "fresh",
      observed_at: OLD_TS,
    }
    let threw = false
    let proposals = -1
    try {
      const result = await dryRun.run({
        trigger: "cli",
        events: [adoptedEvent(someBelief, 0)],
        apply: false,
      })
      proposals = supersessionsOf(result.payload.proposals).length
    } catch {
      threw = true
    }
    checks.push({
      name: "K: a dry-run pass without belief/claim stores derives no supersession and does not throw",
      pass: !threw && proposals === 0,
      detail: threw ? "threw" : `supersession proposals=${proposals}`,
    })
  }

  // ── L: both real adoption-event shapes trigger the rule ───────────────────
  //    Scenarios A–K already drive the BARE `belief.adopted` form (the full
  //    Belief object → id at `payload.id`). L drives the `firewall.belief.adopted`
  //    audit twin (id at `payload.belief_id`) and asserts it fires too, so a
  //    stream carrying only the twin still surfaces the conflict.
  {
    const stores = freshStores()
    const reflection = buildReflection(stores)
    const sc = scope("derive-L")
    const older = await seedBelief(stores, sc, "/branch", "current", "main", { observedAt: OLD_TS })
    const newer = await seedBelief(stores, sc, "/branch", "current", "release", {
      observedAt: NEW_TS,
    })
    const result = await reflection.run({
      trigger: "programmatic",
      events: [firewallAdoptedEvent(older, 0), firewallAdoptedEvent(newer, 1)],
      apply: false,
    })
    checks.push({
      name: "L: the firewall.belief.adopted twin (belief_id payload) also triggers the rule",
      pass: supersessionsOf(result.payload.proposals).length === 1,
      detail: `supersession proposals=${supersessionsOf(result.payload.proposals).length}`,
    })
  }

  return { passed: checks.every((c) => c.pass), checks }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: reflection_derives_supersession_from_conflict")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const c of result.checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`)
  console.log(`      ${c.detail}`)
}
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
