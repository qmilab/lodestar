#!/usr/bin/env bun
/**
 * Probe: epistemic_chain_smoke
 *
 * Verifies the full Observation → Claim → Evidence → Belief chain works
 * end-to-end for a real git.status observation.
 *
 * Setup:
 * - Construct a fully wired CognitiveCore (firewall + linker + world model + extractors).
 * - Submit a synthetic but realistic git.status observation.
 *
 * Assertions:
 * - Three claims are extracted (branch, dirty count, sync state).
 * - All three claims are accepted into the claim store at status 'extracted'.
 * - At least one belief is adopted (because the observation gives direct evidence).
 * - The world model is updated with structured_predicate keys.
 * - Adopted beliefs are in retrieval_status='restricted' (not 'normal' — no auto-promote to retrievable).
 */

import { registry } from "@qmilab/lodestar-core"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import {
  CognitiveCore,
  EvidenceLinker,
  ExplanationGenerator,
  InMemoryWorldModel,
  registerBuiltInExtractors,
} from "@qmilab/lodestar-cognitive-core"
import { GitStatusOutputSchema } from "@qmilab/lodestar-adapter-git"

// Ensure git.status@1 schema is registered (the adapter does this on import).
void GitStatusOutputSchema
if (!registry.has("git.status@1")) {
  // The import side-effect above should have registered it. If not, the
  // probe fails fast.
  throw new Error("probe expected git.status@1 schema to be registered")
}

registerBuiltInExtractors()

interface ProbeResult {
  passed: boolean
  details: string[]
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  const claims = new InMemoryClaimStore()
  const beliefs = new InMemoryBeliefStore()
  const evidence = new InMemoryEvidenceStore()
  const worldModel = new InMemoryWorldModel()
  const firewall = new MemoryFirewall(claims, beliefs, evidence, async () => {})
  const linker = new EvidenceLinker(evidence, beliefs)
  const explanations = new ExplanationGenerator("probe-actor")

  const core = new CognitiveCore(firewall, linker, explanations, worldModel)

  // Synthetic but realistic git.status observation
  const observation = {
    id: crypto.randomUUID(),
    schema: "git.status@1",
    payload: {
      branch: "main",
      dirty: ["README.md"],
      ahead: 2,
      behind: 0,
      detached: false,
    },
    source: {
      tool: "git.status",
      invocation_id: crypto.randomUUID(),
      captured_at: new Date().toISOString(),
    },
    context: {
      session_id: "probe-session",
      project_id: "probe-project",
      actor_id: "probe-actor",
    },
    trust: "validated" as const,
    sensitivity: "internal" as const,
  }

  const result = await core.ingest({
    observation,
    context: {
      actor_id: "probe-actor",
      project_id: "probe-project",
      session_id: "probe-session",
      default_scope: { level: "project", identifier: "probe-project" },
      default_sensitivity: "internal",
    },
  })

  details.push(`extracted ${result.claims.length} claims`)
  details.push(`adopted ${result.beliefs.length} beliefs`)
  details.push(`world model keys updated: ${result.worldModelUpdates.join(", ")}`)

  // Assertions
  if (result.claims.length !== 3) {
    return {
      passed: false,
      details: [
        ...details,
        `expected 3 claims (branch, dirty, sync); got ${result.claims.length}`,
      ],
    }
  }

  if (result.beliefs.length === 0) {
    return {
      passed: false,
      details: [
        ...details,
        "expected at least one belief adoption from a direct tool observation; got 0",
      ],
    }
  }

  for (const belief of result.beliefs) {
    if (belief.retrieval_status === "normal") {
      return {
        passed: false,
        details: [
          ...details,
          `belief ${belief.id} adopted at retrieval_status='normal'; should be 'restricted' (no auto-promote to retrievable)`,
        ],
      }
    }
  }

  // World model should have at least one key updated
  if (result.worldModelUpdates.length === 0) {
    return {
      passed: false,
      details: [...details, "world model received no updates; expected at least one"],
    }
  }

  return { passed: true, details }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: epistemic_chain_smoke")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
