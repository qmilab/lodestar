/**
 * Telenotes governed development — week 2.
 *
 * Demonstrates the full epistemic chain:
 *   Observation → Claim → EvidenceSet → Belief → (world model update)
 *
 * For this iteration:
 * 1. Action kernel proposes git.status under L0
 * 2. Policy approves
 * 3. Kernel executes; output becomes a validated Observation
 * 4. Cognitive core ingests the observation:
 *    - extracts 3 claims (branch / dirty / sync)
 *    - links evidence
 *    - adopts beliefs through the memory firewall
 *    - updates the world model
 * 5. The report is emitted to the event log and printed
 *
 * Real demo with PR creation, calibration, and probes arrives in week 8.
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { ActionKernel, type PolicyDecision } from "@qmilab/lodestar-action-kernel"
import { registerFsReadTool } from "@qmilab/lodestar-adapter-filesystem"
import { registerGitStatusTool } from "@qmilab/lodestar-adapter-git"
import {
  CognitiveCore,
  EvidenceLinker,
  ExplanationGenerator,
  InMemoryWorldModel,
  registerBuiltInExtractors,
} from "@qmilab/lodestar-cognitive-core"
import type { Observation } from "@qmilab/lodestar-core"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { TELENOTES_TOOL_POLICIES } from "./policy.lodestar.js"

const PROJECT_ID = "telenotes-governed-dev"
const SESSION_ID = `session-${Date.now()}`
const ACTOR_ID = "agent-demo"
const PROJECT_ROOT = process.cwd()
const LOG_DIR = resolve(PROJECT_ROOT, ".lodestar", "events")

const writer = new EventLogWriter(LOG_DIR)

async function emit(type: string, payload: unknown): Promise<void> {
  await writer.append({
    id: randomUUID(),
    type,
    schema_version: "0.1.0",
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    actor_id: ACTOR_ID,
    timestamp: new Date().toISOString(),
    causal_parent_ids: [],
    payload,
    payload_hash: canonicalHash(payload),
    versions: { schema_registry_version: "0.1.0" },
  })
}

function policyForTool(toolName: string): { default_level: number } {
  const found = TELENOTES_TOOL_POLICIES.find((p) => p.tool === toolName)
  if (!found) {
    throw new Error(`no policy entry for tool '${toolName}'`)
  }
  return found
}

async function policyGate(action: import("@qmilab/lodestar-core").Action): Promise<PolicyDecision> {
  const policy = policyForTool(action.tool)
  if (action.contract.required_level < policy.default_level) {
    return {
      approved: false,
      reason: `tool '${action.tool}' minimum is L${policy.default_level}`,
      approver_id: "telenotes-policy",
    }
  }
  if (policy.default_level <= 3) {
    return {
      approved: true,
      reason: `auto-approved at L${policy.default_level}`,
      approver_id: "telenotes-policy",
    }
  }
  return {
    approved: false,
    reason: `L${policy.default_level} requires approval (not yet wired)`,
    approver_id: "telenotes-policy",
  }
}

async function preconditionStub() {
  return { holds: true, observed: null }
}

// Wire up the action kernel
registerFsReadTool(PROJECT_ROOT)
registerGitStatusTool(PROJECT_ROOT)

// Wire up the cognitive core
const claims = new InMemoryClaimStore()
const beliefs = new InMemoryBeliefStore()
const evidence = new InMemoryEvidenceStore()
const worldModel = new InMemoryWorldModel()
const firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
  await emit(`firewall.${event.kind}`, event)
})
const linker = new EvidenceLinker(evidence, beliefs)
const explanations = new ExplanationGenerator("agent-demo")
const cognitive = new CognitiveCore(firewall, linker, explanations, worldModel)
registerBuiltInExtractors()

// Observation sink: send observations to the cognitive core, then emit the result.
const kernel = new ActionKernel(
  policyGate,
  preconditionStub,
  async (obs: Observation) => {
    await emit("observation.recorded", obs)
    const result = await cognitive.ingest({
      observation: obs,
      context: {
        actor_id: ACTOR_ID,
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        default_scope: { level: "project", identifier: PROJECT_ID },
        default_sensitivity: "internal",
      },
    })
    await emit("cognitive.ingested", {
      observation_id: result.observation_id,
      claim_count: result.claims.length,
      belief_count: result.beliefs.length,
      world_model_keys: result.worldModelUpdates,
    })
  },
  // Explicit kernel context — the stubs no longer fall through silently.
  // Hosts (this example, Guard, the MCP proxy) supply real values so the
  // event log can tie actions back to a real session.
  { session_id: SESSION_ID, project_id: PROJECT_ID },
)

async function main(): Promise<void> {
  console.log(`[telenotes-example] session ${SESSION_ID}`)
  console.log("[telenotes-example] proposing git.status under L0…")

  const action = kernel.propose({
    intent: "inspect repository state",
    tool: "git.status",
    inputs: { repo: "." },
    contract: {
      required_level: 0,
      blast_radius: "self",
      reversibility: "reversible",
      scope: { level: "project", identifier: PROJECT_ID },
      data_sensitivity: "private",
      preconditions: [],
    },
    proposed_by: ACTOR_ID,
  })
  await emit("action.proposed", action)

  const arbitrated = await kernel.arbitrate(action)
  await emit(arbitrated.phase === "approved" ? "action.approved" : "action.rejected", arbitrated)

  if (arbitrated.phase !== "approved") {
    console.error(`[telenotes-example] action rejected: ${arbitrated.approval?.reason}`)
    process.exit(1)
  }

  const executed = await kernel.execute(arbitrated)
  await emit(executed.phase === "completed" ? "action.completed" : "action.failed", executed)

  console.log(`[telenotes-example] action ${executed.phase}`)

  // Query the state we built
  const allClaims = await claims.list()
  const allBeliefs = await beliefs.list()
  const wmEntries = await worldModel.list({ level: "project", identifier: PROJECT_ID })

  console.log("─".repeat(64))
  console.log("Epistemic chain trace")
  console.log("─".repeat(64))
  console.log(`Claims extracted: ${allClaims.length}`)
  for (const c of allClaims) {
    console.log(`  [${c.status}] ${c.statement}`)
  }
  console.log(`\nBeliefs adopted: ${allBeliefs.length}`)
  for (const b of allBeliefs) {
    console.log(
      `  [${b.truth_status} | ${b.retrieval_status} | ${b.security_status} | ${b.freshness_status}] confidence=${b.confidence.toFixed(2)} class=${b.calibration_class}`,
    )
  }
  console.log(`\nWorld model entries: ${wmEntries.length}`)
  for (const e of wmEntries) {
    console.log(`  ${e.key} = ${JSON.stringify(e.value)} (v${e.version})`)
  }
  console.log("─".repeat(64))
  console.log(`Events at: ${LOG_DIR}/${PROJECT_ID}/`)
}

await main()
