#!/usr/bin/env bun
/**
 * Probe: context_policy_contradiction_routing
 *
 * Verifies the Round 5 fix for contradiction routing through the
 * Memory Firewall.
 *
 * Standard retrieval filters by `policy.allowed_truth_statuses`
 * (default: `["supported"]`), so contradicted beliefs never reach the
 * planner through that channel — including ones that directly
 * conflict with what the planner is about to act on.
 *
 * The fix: `MemoryFirewall.retrieveContradictions(query, policy)`
 * returns contradicted beliefs whose claim shares the same
 * `structured_predicate.{subject, relation}` as one of the accepted
 * retrieval candidates. Unrelated contradictions (different subject
 * or different relation) are intentionally excluded.
 *
 * This probe constructs:
 *   - Belief A: SUPPORTED, claim about (subject="branch", relation="current")
 *   - Belief B: CONTRADICTED, claim about (subject="branch", relation="current")
 *               (related to A — should surface)
 *   - Belief C: CONTRADICTED, claim about (subject="latency", relation="p99")
 *               (unrelated — should NOT surface)
 *
 * Pass conditions:
 *   1. Standard retrieve() returns only A (existing behavior preserved)
 *   2. retrieveContradictions() returns exactly [B] (related)
 *   3. C is excluded (unrelated subject)
 */

import type { Belief, Claim, ContextPolicy } from "@qmilab/lodestar-core"
import { DEFAULT_CONTEXT_POLICY } from "@qmilab/lodestar-core"
import {
  GatedRetrieval,
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"

interface ProbeResult {
  passed: boolean
  details: string
}

async function run(): Promise<ProbeResult> {
  const claims = new InMemoryClaimStore()
  const beliefs = new InMemoryBeliefStore()
  const evidence = new InMemoryEvidenceStore()
  const firewall = new MemoryFirewall(claims, beliefs, evidence, async () => {})
  const retrieval = new GatedRetrieval(beliefs, claims)

  const scope = { level: "project" as const, identifier: "probe-project" }
  const now = new Date().toISOString()
  const actor = "probe.contradiction-routing"

  // ---- Belief A: SUPPORTED, branch.current = "main"
  const claimA: Claim = {
    id: crypto.randomUUID(),
    statement: "Current branch is main",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope,
    sensitivity: "internal",
    authors: [actor],
    created_at: now,
    structured_predicate: { subject: "branch", relation: "current", object: "main" },
  }
  await claims.put(claimA)
  const beliefA: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimA.id,
    confidence: 0.9,
    calibration_class: "probe.contradiction-routing::branch.current",
    scope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefs.put(beliefA)

  // ---- Belief B: CONTRADICTED, branch.current = "release/foo"
  // Related to A: same (subject, relation), different object. SHOULD surface.
  const claimB: Claim = {
    id: crypto.randomUUID(),
    statement: "Current branch is release/foo",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope,
    sensitivity: "internal",
    authors: [actor],
    created_at: now,
    structured_predicate: {
      subject: "branch",
      relation: "current",
      object: "release/foo",
    },
  }
  await claims.put(claimB)
  const beliefB: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimB.id,
    confidence: 0.8,
    calibration_class: "probe.contradiction-routing::branch.current",
    scope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "contradicted",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefs.put(beliefB)

  // ---- Belief C: CONTRADICTED, latency.p99 = 250ms
  // Unrelated to A's subject. Should NOT surface in retrieveContradictions().
  const claimC: Claim = {
    id: crypto.randomUUID(),
    statement: "Service p99 latency is 250ms",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope,
    sensitivity: "internal",
    authors: [actor],
    created_at: now,
    structured_predicate: {
      subject: "latency",
      relation: "p99",
      object: 250,
    },
  }
  await claims.put(claimC)
  const beliefC: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimC.id,
    confidence: 0.8,
    calibration_class: "probe.contradiction-routing::latency.p99",
    scope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "contradicted",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefs.put(beliefC)

  const policy: ContextPolicy = DEFAULT_CONTEXT_POLICY

  // ── Check 1: standard retrieve() returns only SUPPORTED beliefs ──
  const result = await retrieval.retrieve({ scope }, policy)
  const acceptedIds = new Set(result.accepted.map((b) => b.id))
  if (!acceptedIds.has(beliefA.id)) {
    return {
      passed: false,
      details: "Sanity failure: supported belief A was not in the accepted set.",
    }
  }
  if (acceptedIds.has(beliefB.id) || acceptedIds.has(beliefC.id)) {
    return {
      passed: false,
      details:
        "Contradicted beliefs leaked into standard retrieval's accepted set. " +
        "The allowed_truth_statuses gate is not being applied.",
    }
  }

  // ── Check 2: retrieveContradictions() returns the related one ──
  const contradictions = await firewall.retrieveContradictions({ scope }, policy)
  const contradictionIds = new Set(contradictions.map((b) => b.id))

  if (!contradictionIds.has(beliefB.id)) {
    return {
      passed: false,
      details:
        "Related contradicted belief B (same subject+relation as accepted A) " +
        "was NOT returned by retrieveContradictions. The subject-relation " +
        "join is broken.",
    }
  }

  // ── Check 3: unrelated contradicted belief does NOT surface ──
  if (contradictionIds.has(beliefC.id)) {
    return {
      passed: false,
      details:
        "Unrelated contradicted belief C (different subject) was returned " +
        "by retrieveContradictions. The subject-relation filter is leaking.",
    }
  }

  if (contradictions.length !== 1) {
    return {
      passed: false,
      details: `Expected exactly 1 related contradiction, got ${contradictions.length}.`,
    }
  }

  // ── Check 4 (Codex r1 P2 #1): the standard retrieve() path's
  //    contradictions channel is ALSO subject-filtered — not just the
  //    standalone retrieveContradictions(). Planner callers using
  //    `result.contradictions` must not see unrelated contradictions
  //    leak through.
  const standardContradictionIds = new Set(result.contradictions.map((b) => b.id))
  if (!standardContradictionIds.has(beliefB.id)) {
    return {
      passed: false,
      details:
        "retrieve().contradictions did not include the related contradicted " +
        "belief B. The subject-filtering is not wired into the standard " +
        "planner path — planner callers won't see the contradiction at all.",
    }
  }
  if (standardContradictionIds.has(beliefC.id)) {
    return {
      passed: false,
      details:
        "retrieve().contradictions LEAKED the unrelated contradicted belief C. " +
        "The standard planner path is bypassing the subject-relation filter.",
    }
  }
  if (result.contradictions.length !== 1) {
    return {
      passed: false,
      details: `retrieve().contradictions had ${result.contradictions.length} entries; expected 1.`,
    }
  }

  // ── Check 5 (Codex r1 P2 #2): a STALE supported belief must not seed
  //    the related-keys set. If it did, contradictions for facts that
  //    aren't actually in the planner's context would surface anyway.
  //
  //    Construct a scenario with a fresh policy (freshness_max_age = P30D
  //    inherited from DEFAULT) where:
  //      - supported belief D is OLDER than 30 days (gets freshness-rejected)
  //      - contradicted belief E shares (subject, relation) with D
  //    The new retrieveContradictions must NOT return E, because D
  //    wouldn't actually be in the accepted context.
  const STALE_AGE_MS = 60 * 24 * 60 * 60 * 1000 // 60 days
  const stale = new Date(Date.now() - STALE_AGE_MS).toISOString()
  const isolatedScope = {
    level: "project" as const,
    identifier: "probe-project-stale",
  }

  const claimD: Claim = {
    id: crypto.randomUUID(),
    statement: "Old observed branch",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope: isolatedScope,
    sensitivity: "internal",
    authors: [actor],
    created_at: stale,
    structured_predicate: {
      subject: "release-train",
      relation: "head",
      object: "v0.0.1",
    },
  }
  await claims.put(claimD)
  const beliefD: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimD.id,
    confidence: 0.9,
    calibration_class: "probe.contradiction-routing::release-train.head",
    scope: isolatedScope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh", // freshness_status axis is decorative;
    // freshness_max_age uses observed_at
    observed_at: stale,
    last_verified_at: stale,
  }
  await beliefs.put(beliefD)

  const claimE: Claim = {
    id: crypto.randomUUID(),
    statement: "Different release-train head",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope: isolatedScope,
    sensitivity: "internal",
    authors: [actor],
    created_at: now,
    structured_predicate: {
      subject: "release-train",
      relation: "head",
      object: "v0.5.0",
    },
  }
  await claims.put(claimE)
  const beliefE: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimE.id,
    confidence: 0.9,
    calibration_class: "probe.contradiction-routing::release-train.head",
    scope: isolatedScope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "contradicted",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefs.put(beliefE)

  const staleScopeContradictions = await firewall.retrieveContradictions(
    { scope: isolatedScope },
    policy,
  )
  if (staleScopeContradictions.some((b) => b.id === beliefE.id)) {
    return {
      passed: false,
      details:
        "Contradicted belief E surfaced even though its only related " +
        "supported belief D was freshness-rejected from the accepted set. " +
        "The accept-set computation is not applying the freshness gate " +
        "before extracting predicate keys.",
    }
  }
  if (staleScopeContradictions.length !== 0) {
    return {
      passed: false,
      details: `Expected 0 contradictions in the stale-scope test (the only supported belief was freshness-rejected), got ${staleScopeContradictions.length}.`,
    }
  }

  // ── Check 6 (Codex r1 P3): collision-free predicate keys. Construct
  //    two beliefs whose (subject, relation) pairs would collide under a
  //    naive `subject + sep + relation` encoding if the separator byte
  //    appears in either component. Verify they are NOT joined.
  const collisionScope = {
    level: "project" as const,
    identifier: "probe-project-collision",
  }
  const claimF: Claim = {
    id: crypto.randomUUID(),
    statement: "Crafted A",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope: collisionScope,
    sensitivity: "internal",
    authors: [actor],
    created_at: now,
    structured_predicate: { subject: "a\x00b", relation: "c", object: 1 },
  }
  await claims.put(claimF)
  const beliefF: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimF.id,
    confidence: 0.9,
    calibration_class: "probe.contradiction-routing::collision",
    scope: collisionScope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefs.put(beliefF)

  // Belief G is contradicted with predicate (subject="a", relation="b\x00c") —
  // SHOULD NOT match F's (subject="a\x00b", relation="c") under a proper
  // tuple encoding. Under the naive subject + "\x00" + relation it
  // would falsely collide.
  const claimG: Claim = {
    id: crypto.randomUUID(),
    statement: "Crafted B",
    source_observation_ids: [`obs-${crypto.randomUUID()}`],
    extraction_method: "tool",
    extracted_by: actor,
    status: "accepted",
    scope: collisionScope,
    sensitivity: "internal",
    authors: [actor],
    created_at: now,
    structured_predicate: { subject: "a", relation: "b\x00c", object: 2 },
  }
  await claims.put(claimG)
  const beliefG: Belief = {
    id: crypto.randomUUID(),
    claim_id: claimG.id,
    confidence: 0.9,
    calibration_class: "probe.contradiction-routing::collision",
    scope: collisionScope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "contradicted",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefs.put(beliefG)

  const collisionContradictions = await firewall.retrieveContradictions(
    { scope: collisionScope },
    policy,
  )
  if (collisionContradictions.some((b) => b.id === beliefG.id)) {
    return {
      passed: false,
      details:
        "Contradicted belief G surfaced as 'related' to F under a crafted " +
        "(subject, relation) pair that only collides with F's pair under a " +
        "naive delimiter encoding. The predicate key encoding is not " +
        "collision-free.",
    }
  }

  return {
    passed: true,
    details:
      "Standard retrieve() returned only supported beliefs (A); " +
      "retrieveContradictions() and retrieve().contradictions both " +
      "returned exactly the related contradicted belief (B). Unrelated " +
      "contradicted belief (C, different subject) was correctly excluded. " +
      "Stale-rejected supported belief (D) did NOT seed the join key set, " +
      "so its contradiction (E) was excluded. Crafted predicate keys " +
      "(F vs G) that collide under a naive delimiter encoding are " +
      "correctly distinguished.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: context_policy_contradiction_routing")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
