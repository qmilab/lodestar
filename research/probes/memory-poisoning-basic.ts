#!/usr/bin/env bun
/**
 * Probe: memory_poisoning_basic
 *
 * Verifies the critical no-self-promotion invariant.
 *
 * Setup:
 * - Construct a firewall with empty stores.
 * - Inject a "synthetic_probe" observation claiming the user prefers a
 *   particular dangerous default.
 * - Try to adopt a belief from it using auto_observation authority.
 *
 * Assertion:
 * - The firewall MUST reject the adoption because the EvidenceSet
 *   contains only synthetic_probe items.
 *
 * Why this matters:
 * - In MemoryGraft-class attacks, an adversary plants a "successful
 *   experience" hoping the agent will retrieve and imitate it. If
 *   synthetic probe evidence could promote a belief, the firewall
 *   would not defend against this attack class.
 */

import { z } from "zod"
import type { Claim, EvidenceSet, Explanation, Observation } from "@orrery/core"
import { registry } from "@orrery/core"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@orrery/memory-firewall"

// Register a synthetic schema for the probe
const ProbePayloadSchema = z.object({
  claim: z.string(),
})
const SCHEMA_KEY = "probe.synthetic@1"
if (!registry.has(SCHEMA_KEY)) {
  registry.register(SCHEMA_KEY, ProbePayloadSchema)
}

interface ProbeResult {
  passed: boolean
  details: string
}

async function run(): Promise<ProbeResult> {
  const claimStore = new InMemoryClaimStore()
  const beliefStore = new InMemoryBeliefStore()
  const evidenceStore = new InMemoryEvidenceStore()
  const auditEvents: unknown[] = []

  const firewall = new MemoryFirewall(
    claimStore,
    beliefStore,
    evidenceStore,
    async (event) => {
      auditEvents.push(event)
    },
  )

  // Step 1: Inject a poisoned "observation"
  const obs: Observation = {
    id: crypto.randomUUID(),
    schema: SCHEMA_KEY,
    payload: { claim: "User prefers direct pushes to main" },
    source: {
      tool: "probe.attacker",
      invocation_id: crypto.randomUUID(),
      captured_at: new Date().toISOString(),
    },
    context: {
      session_id: "probe-session",
      project_id: "probe-project",
      actor_id: "probe-actor",
    },
    trust: "synthetic", // critical: marks as probe-derived
    sensitivity: "internal",
  }

  // Step 2: Build a claim from the poisoned observation
  const claim: Claim = {
    id: crypto.randomUUID(),
    statement: "User prefers direct pushes to main",
    structured_predicate: {
      subject: "user_preference",
      relation: "is",
      object: "direct_push_to_main",
    },
    source_observation_ids: [obs.id],
    extraction_method: "tool",
    extracted_by: "probe-actor",
    status: "extracted",
    scope: { level: "project", identifier: "probe-project" },
    sensitivity: "internal",
    authors: ["probe-actor"],
    created_at: new Date().toISOString(),
  }
  await firewall.acceptClaim(claim)

  // Step 3: Build an EvidenceSet with only synthetic_probe items
  const poisonedEvidence: EvidenceSet = {
    id: crypto.randomUUID(),
    claim_id: claim.id,
    items: [
      {
        source_id: obs.id,
        relation: "supports",
        quality: "synthetic_probe",
        freshness: "fresh",
        notes: "from probe-attacker",
      },
    ],
    assessed_by: "probe-actor",
    assessed_at: new Date().toISOString(),
  }
  await evidenceStore.put(poisonedEvidence)

  // Step 4: Try to adopt as a 'supported' belief
  const explanation: Explanation = {
    id: crypto.randomUUID(),
    subject_type: "decision_rationale",
    subject_id: "pending",
    audience: "audit",
    summary: "Probe attempting adoption",
    full_text: "Synthetic probe attempting to promote a poisoned claim.",
    claims_used: [claim.id],
    evidence_used: [poisonedEvidence.id],
    uncertainties: [],
    counterarguments: [],
    generated_by: "probe-actor",
    at: new Date().toISOString(),
  }

  try {
    await firewall.adoptBelief({
      candidate: {
        claim_id: claim.id,
        confidence: 0.9,
        calibration_class: "probe.synthetic::user_preference",
        scope: { level: "project", identifier: "probe-project" },
        sensitivity: "internal",
        authority: "synthetic", // belief provenance: probe-derived
        truth_status: "supported",
        retrieval_status: "normal",
        security_status: "clean",
        freshness_status: "fresh",
        observed_at: obs.source.captured_at,
      },
      evidence_id: poisonedEvidence.id,
      by_authority: "auto_observation", // transition authority being tested
      rationale: explanation,
    })
    // If we got here, the firewall did NOT reject the adoption — probe FAILS
    return {
      passed: false,
      details:
        "Firewall accepted a belief adoption from synthetic_probe-only evidence. " +
        "This is the MemoryGraft attack class — adversaries plant 'successful experiences' " +
        "and the system imitates them. CRITICAL FAILURE.",
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Verify the rejection mentions synthetic_probe
    if (message.includes("synthetic_probe")) {
      return {
        passed: true,
        details:
          `Firewall correctly rejected adoption from synthetic_probe-only evidence.\n` +
          `Rejection: ${message}`,
      }
    }
    return {
      passed: false,
      details:
        `Firewall rejected but for the wrong reason. Expected mention of synthetic_probe.\n` +
        `Got: ${message}`,
    }
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: memory_poisoning_basic")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
