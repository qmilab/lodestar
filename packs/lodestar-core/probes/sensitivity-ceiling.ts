#!/usr/bin/env bun
/**
 * Probe: sensitivity_ceiling_blocks_secret
 *
 * Verifies that a belief tagged `sensitivity: secret` does not surface
 * through the standard retrieval path when `policy.sensitivity_ceiling`
 * is `internal` (the default).
 *
 * Why this matters: secrets (API keys, credentials, PII fragments) must
 * not enter the model's context just because they live in the belief
 * store. Retrieval must respect the sensitivity ceiling.
 */

import type { Belief, ContextPolicy } from "@qmilab/lodestar-core"
import { DEFAULT_CONTEXT_POLICY } from "@qmilab/lodestar-core"
import {
  GatedRetrieval,
  InMemoryBeliefStore,
  InMemoryClaimStore,
} from "@qmilab/lodestar-memory-firewall"

interface ProbeResult {
  passed: boolean
  details: string
}

async function run(): Promise<ProbeResult> {
  const beliefStore = new InMemoryBeliefStore()
  const claimStore = new InMemoryClaimStore()
  const retrieval = new GatedRetrieval(beliefStore, claimStore)

  const scope = { level: "project" as const, identifier: "probe-project" }
  const now = new Date().toISOString()

  // An internal belief — should be retrievable
  const internalBelief: Belief = {
    id: crypto.randomUUID(),
    claim_id: crypto.randomUUID(),
    confidence: 0.9,
    calibration_class: "probe.sensitivity::test",
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
  await beliefStore.put(internalBelief)

  // A secret belief — should NOT be retrievable under internal ceiling
  const secretBelief: Belief = {
    id: crypto.randomUUID(),
    claim_id: crypto.randomUUID(),
    confidence: 0.9,
    calibration_class: "probe.sensitivity::test",
    scope,
    sensitivity: "secret", // <-- the gate
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefStore.put(secretBelief)

  // Default policy has sensitivity_ceiling: 'internal'
  const policy: ContextPolicy = DEFAULT_CONTEXT_POLICY

  const result = await retrieval.retrieve({ scope }, policy)

  const internalFound = result.accepted.some((b) => b.id === internalBelief.id)
  const secretFound = result.accepted.some((b) => b.id === secretBelief.id)

  if (!internalFound) {
    return {
      passed: false,
      details: "Sanity failure: internal belief was not retrieved. Test setup is broken.",
    }
  }

  if (secretFound) {
    return {
      passed: false,
      details: `Secret belief was retrieved under sensitivity_ceiling='${policy.sensitivity_ceiling}'. The sensitivity gate is not being applied correctly. This is a high-severity failure: secrets must never enter default context.`,
    }
  }

  return {
    passed: true,
    details: `Secret belief correctly excluded under sensitivity_ceiling='${policy.sensitivity_ceiling}'. Internal belief retrieved as expected.`,
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: sensitivity_ceiling_blocks_secret")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
