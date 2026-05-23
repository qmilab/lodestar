#!/usr/bin/env bun
/**
 * Probe: quarantined_belief_not_retrievable
 *
 * Verifies that a belief with `security_status: quarantined` does not
 * surface through the standard `GatedRetrieval.retrieve()` path, even
 * if its truth_status is 'supported' and freshness_status is 'fresh'.
 *
 * Why this matters: quarantine is the firewall's response to a sentinel
 * raising suspicion about a belief's provenance or content. The planner
 * must not see quarantined beliefs even if they would otherwise pass
 * every other gate.
 */

import type { Belief, ContextPolicy } from "@orrery/core"
import { DEFAULT_CONTEXT_POLICY } from "@orrery/core"
import {
  GatedRetrieval,
  InMemoryBeliefStore,
} from "@orrery/memory-firewall"

interface ProbeResult {
  passed: boolean
  details: string
}

async function run(): Promise<ProbeResult> {
  const beliefStore = new InMemoryBeliefStore()
  const retrieval = new GatedRetrieval(beliefStore)

  const scope = { level: "project" as const, identifier: "probe-project" }
  const now = new Date().toISOString()

  // A normal supported belief — should be retrievable
  const cleanBelief: Belief = {
    id: crypto.randomUUID(),
    claim_id: crypto.randomUUID(),
    confidence: 0.9,
    calibration_class: "probe.quarantine::test",
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
  await beliefStore.put(cleanBelief)

  // A quarantined belief — should NOT be retrievable
  const quarantinedBelief: Belief = {
    id: crypto.randomUUID(),
    claim_id: crypto.randomUUID(),
    confidence: 0.9,
    calibration_class: "probe.quarantine::test",
    scope,
    sensitivity: "internal",
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "quarantined", // <-- the gate
    freshness_status: "fresh",
    observed_at: now,
    last_verified_at: now,
  }
  await beliefStore.put(quarantinedBelief)

  // Use the default policy, which allows security_status: ["clean"] only
  const policy: ContextPolicy = DEFAULT_CONTEXT_POLICY

  const result = await retrieval.retrieve({ scope }, policy)

  const accepted = result.accepted
  const cleanFound = accepted.some((b) => b.id === cleanBelief.id)
  const quarantinedFound = accepted.some((b) => b.id === quarantinedBelief.id)

  if (!cleanFound) {
    return {
      passed: false,
      details: "Sanity failure: clean supported belief was not retrieved. Test setup is broken.",
    }
  }

  if (quarantinedFound) {
    return {
      passed: false,
      details:
        "Quarantined belief was retrieved through the standard planner path. " +
        "The security_status gate is not being applied correctly.",
    }
  }

  return {
    passed: true,
    details:
      "Quarantined belief correctly excluded from standard retrieval. " +
      "Clean belief retrieved as expected.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: quarantined_belief_not_retrievable")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
