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
 * Four sub-cases:
 *
 *   A — bare `belief.transitioned` event type (synthetic shape).
 *       Baseline cascade test.
 *   B — `firewall.belief.transitioned` event type (the form Guard and
 *       the MCP proxy actually emit). Regression guard for codex P1.
 *   C — `from_value: "unverified"` directly to `contradicted` (a legal
 *       transition on the truth_status axis). Revision must record
 *       old_value='unverified', not the hardcoded 'supported'.
 *       Regression guard for codex P2 (Revision accuracy).
 *   D — historical decision: the `decision.made` event has seq <
 *       since_seq, so the cursor window omits it. observed_event_ids
 *       must still include the decision envelope id once the cascade
 *       grounds a proposal on it. Regression guard for codex P2
 *       (observed_event_ids completeness).
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

interface SubCase {
  label: string
  transition_type: "belief.transitioned" | "firewall.belief.transitioned"
  from_value: "supported" | "unverified"
  decision_before_cursor: boolean
}

const SUB_CASES: SubCase[] = [
  { label: "A (bare event type, from supported)",     transition_type: "belief.transitioned",          from_value: "supported",  decision_before_cursor: false },
  { label: "B (prefixed firewall.* event type)",      transition_type: "firewall.belief.transitioned", from_value: "supported",  decision_before_cursor: false },
  { label: "C (from_value: 'unverified' direct)",     transition_type: "belief.transitioned",          from_value: "unverified", decision_before_cursor: false },
  { label: "D (historical decision, predates cursor)", transition_type: "belief.transitioned",          from_value: "supported",  decision_before_cursor: true  },
]

async function runSubCase(sub: SubCase): Promise<{ passed: boolean; lines: string[] }> {
  const lines: string[] = []
  const beliefId = crypto.randomUUID()
  const decisionId = crypto.randomUUID()

  // Sub-case D: the decision predates a prior reflection.completed
  // cursor. We simulate that by setting since_seq = 1 (the decision
  // event lands at seq=0).
  const baseEvents: EventEnvelope[] = [
    makeEnvelope({
      seq: 0,
      type: "decision.made",
      payload: {
        id: decisionId,
        question: `Probe sub-case ${sub.label}`,
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
      seq: 1,
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
      seq: 2,
      type: sub.transition_type,
      payload: {
        belief_id: beliefId,
        axis: "truth_status",
        from_value: sub.from_value,
        to_value: "contradicted",
        by_authority: "sentinel",
        rationale_id: crypto.randomUUID(),
      },
    }),
  ]
  const decisionEnvelopeId = baseEvents[0]!.id
  const since_seq = sub.decision_before_cursor ? 1 : undefined

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
    events: baseEvents,
    since_seq,
    apply: true,
  })

  if (!capturedPayload) {
    return { passed: false, lines: [`${sub.label}: FAIL — emitReflectionCompleted not called`] }
  }

  const flagged = result.payload.proposals.filter(
    (p) => p.kind === "decision_dependency_flagged",
  )
  if (flagged.length !== 1) {
    return {
      passed: false,
      lines: [`${sub.label}: FAIL — expected exactly 1 decision_dependency_flagged proposal, got ${flagged.length}`],
    }
  }
  const proposal = flagged[0]!
  if (proposal.kind !== "decision_dependency_flagged") {
    return { passed: false, lines: [`${sub.label}: FAIL — proposal kind mismatch`] }
  }
  if (proposal.decision_id !== decisionId || proposal.contradicted_belief_id !== beliefId) {
    return {
      passed: false,
      lines: [
        `${sub.label}: FAIL — proposal did not name expected (decision=${decisionId.slice(0, 8)}, belief=${beliefId.slice(0, 8)})`,
      ],
    }
  }
  if (proposal.previous_truth_status !== sub.from_value) {
    return {
      passed: false,
      lines: [
        `${sub.label}: FAIL — proposal.previous_truth_status='${proposal.previous_truth_status}', expected '${sub.from_value}'`,
      ],
    }
  }

  // observed_event_ids must include the decision envelope id even
  // when the decision predates the cursor (sub-case D).
  if (!capturedPayload.observed_event_ids.includes(decisionEnvelopeId)) {
    return {
      passed: false,
      lines: [
        `${sub.label}: FAIL — observed_event_ids missing the decision envelope id ` +
          `(${decisionEnvelopeId.slice(0, 8)}). Auditor cannot reconstruct the cascade.`,
      ],
    }
  }

  // Revision must use the real from_value, not a hardcoded "supported".
  const rev = capturedRevisions.find(
    (r) => r.target_type === "decision" && r.target_id === decisionId,
  )
  if (!rev) {
    return { passed: false, lines: [`${sub.label}: FAIL — no Revision emitted for the decision`] }
  }
  const change = rev.changes[0]
  if (!change || change.old_value !== sub.from_value || change.new_value !== "contradicted") {
    return {
      passed: false,
      lines: [
        `${sub.label}: FAIL — Revision.changes[0] has old_value='${change?.old_value}', new_value='${change?.new_value}'; ` +
          `expected ('${sub.from_value}', 'contradicted')`,
      ],
    }
  }

  if (result.applied.decision_flags !== 1 || result.applied.errors.length > 0) {
    return {
      passed: false,
      lines: [
        `${sub.label}: FAIL — applied.decision_flags=${result.applied.decision_flags}, errors=${result.applied.errors.length}`,
      ],
    }
  }

  return {
    passed: true,
    lines: [
      `${sub.label}: PASS — proposal previous_truth_status='${proposal.previous_truth_status}', ` +
        `observed_event_ids includes decision envelope, Revision old_value='${change.old_value}'`,
    ],
  }
}

/**
 * Sub-case E — idempotence under repeated passes.
 *
 * Each `reflection.completed` envelope has `seq > cursor.to_seq` (it
 * IS the highest seq in its window). Without an envelope-seq floor in
 * `resolveSinceSeq`, the next pass over the same log would re-observe
 * the prior reflection.completed event and append a fresh no_op
 * forever. This sub-case drives two consecutive passes over the same
 * stream (empty rule space) and asserts the second pass observes
 * nothing.
 */
async function runSelfChainIdempotence(): Promise<{ passed: boolean; lines: string[] }> {
  let nextSeq = 0
  const events: EventEnvelope[] = []

  // Run pass 1 over an empty stream — emits a no_op + reflection.completed.
  const reflection = new Reflection({
    explanations: new ExplanationGenerator("probe-reflector"),
    context: {
      project_id: "probe-project",
      session_id: "probe-session",
      actor_id: "probe-reflector",
    },
    emitter: {
      async emitReflectionCompleted({ payload }) {
        const env = makeEnvelope({
          seq: nextSeq++,
          type: "reflection.completed",
          payload,
        })
        events.push(env)
        return env.id
      },
      async emitDecisionRevision() {
        return crypto.randomUUID()
      },
    },
  })

  const pass1 = await reflection.run({ trigger: "programmatic", events: [...events], apply: false })
  const pass2 = await reflection.run({ trigger: "programmatic", events: [...events], apply: false })

  // Pass 2's window must be empty — same log, the prior pass's own
  // reflection.completed envelope must NOT re-enter the window.
  if (pass2.payload.cursor.from_seq < pass1.payload.cursor.to_seq) {
    return {
      passed: false,
      lines: [
        `E (self-chain idempotence): FAIL — pass 2 since_seq=${pass2.payload.cursor.from_seq} but ` +
          `pass 1 ended at to_seq=${pass1.payload.cursor.to_seq}. The cursor floor did not advance past ` +
          `pass 1's own reflection.completed envelope.`,
      ],
    }
  }
  // Pass 2 observed nothing new — its observed_event_ids should be empty.
  if (pass2.payload.observed_event_ids.length !== 0) {
    return {
      passed: false,
      lines: [
        `E (self-chain idempotence): FAIL — pass 2 observed_event_ids has ` +
          `${pass2.payload.observed_event_ids.length} ids; expected 0 (the prior reflection.completed ` +
          `event must be excluded from the next window).`,
      ],
    }
  }
  return {
    passed: true,
    lines: [
      `E (self-chain idempotence): PASS — pass 2 since_seq=${pass2.payload.cursor.from_seq} excludes ` +
        `pass 1's emission; observed_event_ids empty as expected`,
    ],
  }
}

/**
 * Sub-case F — supersession preserves the successor pointer.
 *
 * `belief_supersession` proposals applied through Reflection must call
 * `MemoryFirewall.markSuperseded`, which transitions truth_status AND
 * stamps `superseded_by = new_belief_id`. Without the pointer, the
 * audit chain says "this belief was superseded" but cannot say by
 * what.
 */
async function runSupersessionLink(): Promise<{ passed: boolean; lines: string[] }> {
  const claimStore = new InMemoryClaimStore()
  const beliefStore = new InMemoryBeliefStore()
  const evidenceStore = new InMemoryEvidenceStore()
  const firewall = new MemoryFirewall(claimStore, beliefStore, evidenceStore, async () => {})

  // Seed two beliefs: the predecessor (truth=supported) and the
  // successor. Both share the same claim+evidence to keep setup tight.
  const claim = {
    id: crypto.randomUUID(),
    statement: "Probe claim for supersession test",
    source_observation_ids: [crypto.randomUUID()],
    extraction_method: "tool" as const,
    extracted_by: "probe-actor",
    status: "extracted" as const,
    scope: { level: "project" as const, identifier: "probe-project" },
    sensitivity: "internal" as const,
    authors: ["probe-actor"],
    created_at: new Date().toISOString(),
  }
  await firewall.acceptClaim(claim)
  const evidence = {
    id: crypto.randomUUID(),
    claim_id: claim.id,
    items: [{
      source_id: claim.source_observation_ids[0]!,
      relation: "supports" as const,
      quality: "tool_result" as const,
      independence_group: "obs:probe.tool",
      freshness: "fresh" as const,
    }],
    assessed_by: "probe-actor",
    assessed_at: new Date().toISOString(),
  }
  await evidenceStore.put(evidence)

  const explanations = new ExplanationGenerator("probe-actor")
  const adoptExplanation = explanations.forBeliefAdoption({
    belief_id: "pending",
    claim_id: claim.id,
    evidence_id: evidence.id,
    confidence: 0.8,
    rationale_text: "probe seed",
  })
  const predecessor = await firewall.adoptBelief({
    candidate: {
      claim_id: claim.id,
      confidence: 0.8,
      calibration_class: "probe::supersession",
      scope: claim.scope,
      sensitivity: claim.sensitivity,
      authority: "observed",
      truth_status: "supported",
      retrieval_status: "restricted",
      security_status: "clean",
      freshness_status: "fresh",
      observed_at: claim.created_at,
    },
    evidence_id: evidence.id,
    by_authority: "auto_observation",
    rationale: adoptExplanation,
  })
  const successor = await firewall.adoptBelief({
    candidate: {
      claim_id: claim.id,
      confidence: 0.8,
      calibration_class: "probe::supersession",
      scope: claim.scope,
      sensitivity: claim.sensitivity,
      authority: "observed",
      truth_status: "supported",
      retrieval_status: "restricted",
      security_status: "clean",
      freshness_status: "fresh",
      observed_at: claim.created_at,
    },
    evidence_id: evidence.id,
    by_authority: "auto_observation",
    rationale: adoptExplanation,
  })

  const reflection = new Reflection({
    beliefs: beliefStore,
    claims: claimStore,
    evidence: evidenceStore,
    firewall,
    explanations,
    context: {
      project_id: "probe-project",
      session_id: "probe-session",
      actor_id: "probe-reflector",
    },
  })

  const supersessionRationale = explanations.build({
    subject_type: "belief_revision",
    subject_id: predecessor.id,
    audience: "audit",
    summary: "probe: supersede predecessor with successor",
    full_text: "Probe applies a belief_supersession proposal and verifies the successor link is stamped.",
    claims_used: [claim.id],
    evidence_used: [evidence.id],
  })

  await reflection.applyProposal(
    {
      kind: "belief_supersession",
      old_belief_id: predecessor.id,
      new_belief_id: successor.id,
      rationale_id: supersessionRationale.id,
    },
    undefined,
  )

  const stored = await beliefStore.get(predecessor.id)
  if (!stored) {
    return { passed: false, lines: ["F (supersession link): FAIL — predecessor belief not found after apply"] }
  }
  if (stored.truth_status !== "superseded") {
    return {
      passed: false,
      lines: [`F (supersession link): FAIL — truth_status='${stored.truth_status}', expected 'superseded'`],
    }
  }
  if (stored.superseded_by !== successor.id) {
    return {
      passed: false,
      lines: [
        `F (supersession link): FAIL — superseded_by='${stored.superseded_by}', expected '${successor.id}'. ` +
          `The successor pointer was lost; downstream audit cannot tell which belief replaced this one.`,
      ],
    }
  }
  return {
    passed: true,
    lines: [
      `F (supersession link): PASS — truth_status='superseded', superseded_by=${successor.id.slice(0, 8)} ` +
        `(predecessor=${predecessor.id.slice(0, 8)})`,
    ],
  }
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  for (const sub of SUB_CASES) {
    const { passed, lines } = await runSubCase(sub)
    for (const l of lines) details.push(l)
    if (!passed) return { passed: false, details }
  }
  for (const sub of [runSelfChainIdempotence, runSupersessionLink]) {
    const { passed, lines } = await sub()
    for (const l of lines) details.push(l)
    if (!passed) return { passed: false, details }
  }
  details.push("All sub-cases pass: cascade fires under both event-naming forms, captures the real " +
    "from_value, lists historical decision envelopes, is idempotent under repeated passes, and " +
    "preserves the supersession successor link.")
  return { passed: true, details }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: contradicted_belief_flags_dependent_decisions")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
