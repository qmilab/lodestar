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
  const retrieval = new GatedRetrieval(beliefs)

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
      details:
        `Expected exactly 1 related contradiction, got ${contradictions.length}.`,
    }
  }

  return {
    passed: true,
    details:
      "Standard retrieve() returned only supported beliefs (A). " +
      "retrieveContradictions() returned only the related contradicted belief " +
      "(B, same subject+relation as A). Unrelated contradicted belief (C, " +
      "different subject) was correctly excluded.",
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
