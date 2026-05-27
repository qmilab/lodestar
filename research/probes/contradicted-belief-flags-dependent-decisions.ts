#!/usr/bin/env bun
/**
 * Probe: contradicted_belief_flags_dependent_decisions
 *
 * The second Batch-2-deferred firewall invariant
 * (`docs/roadmap.md` lines 192-194), now unblocked by the Batch 4
 * reflection pass: when a belief that a past Decision recorded in its
 * `belief_dependencies` transitions to `truth_status: contradicted`,
 * a reflection pass must surface a `decision_dependency_flagged`
 * proposal naming the Decision and the contradicted belief.
 *
 * Mechanics:
 *   1. Construct a synthetic event stream containing a `decision.made@1`
 *      event whose `belief_dependencies` includes belief B.
 *   2. Append a `belief.transitioned` event recording B transitioning
 *      to truth_status: contradicted.
 *   3. Run Reflection over the stream.
 *   4. Assert the resulting `reflection.completed` payload contains a
 *      `decision_dependency_flagged` proposal naming the decision and
 *      the contradicted belief.
 *   5. Assert that applying the proposal emits a Revision via the
 *      ReflectionEmitter — target_type='decision', target_id=decision_id.
 */

import {
  ExplanationGenerator,
  Reflection,
  type ReflectionEmitter,
} from "@qmilab/lodestar-cognitive-core"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import type { EventEnvelope, ReflectionCompletedPayload, Revision } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string[]
}

function makeEnvelope(input: {
  seq: number
  type: string
  payload: unknown
}): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    seq: input.seq,
    type: input.type,
    schema_version: "1",
    project_id: "probe-project",
    session_id: "probe-session",
    actor_id: "probe-actor",
    timestamp: new Date(Date.now() + input.seq * 100).toISOString(),
    logical_clock: input.seq,
    causal_parent_ids: [],
    payload_hash: `probe-${input.seq}`,
    payload: input.payload,
    versions: {},
  }
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []

  const beliefId = crypto.randomUUID()
  const decisionId = crypto.randomUUID()

  const events: EventEnvelope[] = [
    makeEnvelope({
      seq: 0,
      type: "belief.adopted",
      payload: {
        belief_id: beliefId,
        claim_id: crypto.randomUUID(),
        evidence_id: crypto.randomUUID(),
        rationale_id: crypto.randomUUID(),
        by_authority: "auto_observation",
      },
    }),
    makeEnvelope({
      seq: 1,
      type: "decision.made",
      payload: {
        id: decisionId,
        question: "Probe: should we use direct-push?",
        options: [{ id: "yes", description: "use direct-push" }],
        selected_option_id: "yes",
        rationale_id: crypto.randomUUID(),
        belief_dependencies: [beliefId],
        policy_dependencies: [],
        made_by: "probe-actor",
        made_at: new Date().toISOString(),
      },
    }),
    makeEnvelope({
      seq: 2,
      type: "belief.transitioned",
      payload: {
        belief_id: beliefId,
        axis: "truth_status",
        from_value: "supported",
        to_value: "contradicted",
        by_authority: "sentinel",
        rationale_id: crypto.randomUUID(),
      },
    }),
  ]

  // Capture both the reflection.completed and any decision Revisions.
  let capturedPayload: ReflectionCompletedPayload | undefined
  const capturedRevisions: Revision[] = []
  const emitter: ReflectionEmitter = {
    async emitReflectionCompleted({ payload }) {
      capturedPayload = payload
      return crypto.randomUUID()
    },
    async emitDecisionRevision({ revision }) {
      capturedRevisions.push(revision)
      return crypto.randomUUID()
    },
  }

  const claimStore = new InMemoryClaimStore()
  const beliefStore = new InMemoryBeliefStore()
  const evidenceStore = new InMemoryEvidenceStore()
  const firewall = new MemoryFirewall(claimStore, beliefStore, evidenceStore, async () => {})

  const reflection = new Reflection({
    beliefs: beliefStore,
    claims: claimStore,
    evidence: evidenceStore,
    firewall,
    explanations: new ExplanationGenerator("probe-reflector"),
    emitter,
    context: {
      project_id: "probe-project",
      session_id: "probe-session",
      actor_id: "probe-reflector",
    },
  })

  const result = await reflection.run({
    trigger: "tail_cascade",
    events,
    apply: true,
  })

  details.push(`pass id ${result.pass_id.slice(0, 8)}`)
  details.push(`observed ${result.payload.observed_event_ids.length} event(s)`)
  details.push(`proposals: ${result.payload.proposals.length}`)
  for (const p of result.payload.proposals) {
    if (p.kind === "decision_dependency_flagged") {
      details.push(`  - decision_dependency_flagged decision=${p.decision_id.slice(0, 8)} contradicted_belief=${p.contradicted_belief_id.slice(0, 8)}`)
    } else {
      details.push(`  - ${p.kind}`)
    }
  }

  if (!capturedPayload) {
    return {
      passed: false,
      details: [...details, "FAIL: emitReflectionCompleted was not called."],
    }
  }

  const flagged = result.payload.proposals.filter(
    (p) => p.kind === "decision_dependency_flagged",
  )
  if (flagged.length === 0) {
    return {
      passed: false,
      details: [
        ...details,
        "FAIL: no decision_dependency_flagged proposal emitted. " +
          "The cascade rule did not fire — reflection failed to link the contradicted " +
          "belief to the dependent Decision.",
      ],
    }
  }

  const match = flagged.find(
    (p) =>
      p.kind === "decision_dependency_flagged" &&
      p.decision_id === decisionId &&
      p.contradicted_belief_id === beliefId,
  )
  if (!match) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: decision_dependency_flagged proposal did not name the expected pair ` +
          `(decision=${decisionId.slice(0, 8)}, belief=${beliefId.slice(0, 8)}).`,
      ],
    }
  }
  details.push(`OK: proposal correctly names (decision=${decisionId.slice(0, 8)}, belief=${beliefId.slice(0, 8)})`)

  // Apply step must have emitted a Revision with target_type='decision'.
  const decisionRevs = capturedRevisions.filter(
    (r) => r.target_type === "decision" && r.target_id === decisionId,
  )
  if (decisionRevs.length === 0) {
    return {
      passed: false,
      details: [
        ...details,
        "FAIL: applying the proposal did not emit a Revision for the dependent Decision. " +
          "The cascade is observable in the proposal but the audit-grade Revision side is missing.",
      ],
    }
  }
  const rev = decisionRevs[0]!
  details.push(`OK: emitted Revision target=${rev.target_type}:${rev.target_id.slice(0, 8)}`)

  if (result.applied.decision_flags !== flagged.length) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: applied.decision_flags=${result.applied.decision_flags} but flagged.length=${flagged.length}.`,
      ],
    }
  }
  details.push(`OK: applied.decision_flags=${result.applied.decision_flags} matches proposal count`)

  if (result.applied.errors.length > 0) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: apply step recorded ${result.applied.errors.length} error(s): ` +
          result.applied.errors.map((e) => `${e.proposal_kind}: ${e.message}`).join("; "),
      ],
    }
  }

  return {
    passed: true,
    details: [
      ...details,
      "All checks pass: contradicted belief reaches the dependent Decision via a " +
        "decision_dependency_flagged proposal AND via an audit-grade Revision event.",
    ],
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: contradicted_belief_flags_dependent_decisions")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
