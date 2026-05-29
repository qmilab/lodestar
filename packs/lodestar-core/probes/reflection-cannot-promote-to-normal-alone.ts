#!/usr/bin/env bun
/**
 * Probe: reflection_cannot_promote_to_normal_alone
 *
 * Per the Batch 4 reflection-pass design (`docs/architecture/reflection-pass.md`,
 * Q5): reflection authority cannot promote a belief to `retrieval_status: normal`
 * on its own. The invariant is enforced *structurally* by the absence of
 * `"reflection"` from the `restricted → normal` row of `RETRIEVAL_TRANSITIONS`
 * in `packages/memory-firewall/src/transitions.ts`. This probe locks the
 * invariant in writing — if a future change adds `reflection` to that row,
 * the probe fails and the diff has to deal with it.
 *
 * Two assertions:
 *   (a) `authoritiesFor("retrieval_status", "restricted", "normal")` does
 *       not include `"reflection"`.
 *   (b) A hand-built `belief_transition` proposal that targets the
 *       restricted → normal transition under reflection authority, when
 *       applied via Reflection (which calls `MemoryFirewall.transitionAxis`
 *       with `by_authority: "reflection"`), is rejected by the firewall.
 *
 * Why both: (a) catches an accidental table edit; (b) catches a bypass
 * — code that constructs the proposal but routes around the table.
 */

import {
  ExplanationGenerator,
  Reflection,
  type ReflectionEmitter,
} from "@qmilab/lodestar-cognitive-core"
import type { Belief, Claim, EvidenceSet, ReflectionProposal } from "@qmilab/lodestar-core"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
  authoritiesFor,
} from "@qmilab/lodestar-memory-firewall"

interface ProbeResult {
  passed: boolean
  details: string[]
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []

  // ── Assertion (a): table-level invariant ──────────────────────────────
  const authorities = authoritiesFor("retrieval_status", "restricted", "normal")
  details.push(
    `authoritiesFor(retrieval_status, restricted → normal) = [${authorities.join(", ")}]`,
  )
  if (authorities.includes("reflection")) {
    return {
      passed: false,
      details: [
        ...details,
        "FAIL: 'reflection' is listed as an authority for restricted → normal retrieval. " +
          "The Round 5 / Batch 4 invariant says reflection alone cannot promote to normal " +
          "retrieval. Either revert the transition-table change or update the design doc.",
      ],
    }
  }
  details.push("OK: 'reflection' not present in restricted → normal authorities")

  // ── Assertion (b): runtime bypass guard ────────────────────────────────
  const claimStore = new InMemoryClaimStore()
  const beliefStore = new InMemoryBeliefStore()
  const evidenceStore = new InMemoryEvidenceStore()
  const firewall = new MemoryFirewall(claimStore, beliefStore, evidenceStore, async () => {})

  // Seed a real belief at unverified + restricted with a real claim and
  // evidence so the firewall's transitionAxis has something to act on.
  const claim: Claim = {
    id: crypto.randomUUID(),
    statement: "Probe claim for reflection retrieval-promotion test",
    structured_predicate: {
      subject: "probe_subject",
      relation: "is",
      object: "probe_value",
    },
    source_observation_ids: [crypto.randomUUID()],
    extraction_method: "tool",
    extracted_by: "probe-actor",
    status: "extracted",
    scope: { level: "project", identifier: "probe-project" },
    sensitivity: "internal",
    authors: ["probe-actor"],
    created_at: new Date().toISOString(),
  }
  await firewall.acceptClaim(claim)

  const evidence: EvidenceSet = {
    id: crypto.randomUUID(),
    claim_id: claim.id,
    items: [
      {
        source_id: claim.source_observation_ids[0]!,
        relation: "supports",
        quality: "tool_result",
        independence_group: "obs:probe.tool",
        freshness: "fresh",
        notes: "probe-supplied evidence",
      },
    ],
    assessed_by: "probe-actor",
    assessed_at: new Date().toISOString(),
  }
  await evidenceStore.put(evidence)

  const explanationGen = new ExplanationGenerator("probe-actor")
  const adoptionExplanation = explanationGen.forBeliefAdoption({
    belief_id: "pending",
    claim_id: claim.id,
    evidence_id: evidence.id,
    confidence: 0.6,
    rationale_text: "Probe: seed an unverified+restricted belief for retrieval-promotion test",
  })
  const seed: Belief = await firewall.adoptBelief({
    candidate: {
      claim_id: claim.id,
      confidence: 0.6,
      calibration_class: "probe::reflection_retrieval",
      scope: claim.scope,
      sensitivity: claim.sensitivity,
      authority: "observed",
      truth_status: "unverified",
      retrieval_status: "restricted",
      security_status: "clean",
      freshness_status: "fresh",
      observed_at: claim.created_at,
    },
    evidence_id: evidence.id,
    by_authority: "auto_observation",
    rationale: adoptionExplanation,
  })
  details.push(`seeded belief ${seed.id.slice(0, 8)} at truth=unverified, retrieval=restricted`)

  // Hand-craft a belief_transition proposal that targets restricted → normal.
  // This is the bypass attempt — it constructs the proposal directly,
  // not via reflection's own rule set (which wouldn't emit one).
  const transitionRationale = explanationGen.build({
    subject_type: "belief_revision",
    subject_id: seed.id,
    audience: "audit",
    summary: "Probe: hand-crafted bypass attempt",
    full_text:
      "Probe attempts to feed Reflection a hand-crafted proposal targeting " +
      "restricted → normal retrieval. The firewall must reject this.",
    claims_used: [claim.id],
    evidence_used: [evidence.id],
  })
  const bypassProposal: ReflectionProposal = {
    kind: "belief_transition",
    belief_id: seed.id,
    axis: "retrieval_status",
    from_value: "restricted",
    to_value: "normal",
    rationale_id: transitionRationale.id,
  }

  // Capture emitted reflection.completed payload via a stub emitter.
  let emittedPayload: { proposals: ReflectionProposal[] } | undefined
  const emitter: ReflectionEmitter = {
    async emitReflectionCompleted({ payload }) {
      emittedPayload = payload
      return crypto.randomUUID()
    },
    async emitDecisionRevision() {
      return crypto.randomUUID()
    },
  }

  const reflection = new Reflection({
    beliefs: beliefStore,
    claims: claimStore,
    evidence: evidenceStore,
    firewall,
    explanations: explanationGen,
    emitter,
    context: {
      project_id: "probe-project",
      session_id: "probe-session",
      actor_id: "probe-reflector",
    },
  })

  // Drive the bypass proposal through Reflection's OWN apply path —
  // not the firewall directly. If a future change ever has
  // Reflection route around `MemoryFirewall.transitionAxis` (e.g.
  // calling `beliefStore.transition` directly), the firewall-only
  // test wouldn't catch it; this one does.
  // Pass a real reflection_event_id so the audit-chain guard is
  // satisfied and this check isolates the table-level rejection
  // (the thing under test) rather than the missing-event guard.
  const dummyReflectionEventId = crypto.randomUUID()
  let reflectionApplyThrew = false
  let reflectionErrorMessage = ""
  try {
    await reflection.applyProposal(bypassProposal, dummyReflectionEventId)
  } catch (err) {
    reflectionApplyThrew = true
    reflectionErrorMessage = err instanceof Error ? err.message : String(err)
  }

  if (!reflectionApplyThrew) {
    return {
      passed: false,
      details: [
        ...details,
        "FAIL: Reflection.applyProposal accepted retrieval_status restricted → normal under 'reflection' authority. " +
          "This contradicts the design-doc Q5 invariant — the apply path is routing around the firewall.",
      ],
    }
  }
  if (!/retrieval_status|normal|reflection/.test(reflectionErrorMessage)) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: Reflection.applyProposal threw, but the error did not name the table-level rejection. Got: ${reflectionErrorMessage}. Expected the firewall's transition-not-allowed message.`,
      ],
    }
  }
  details.push(`OK: Reflection.applyProposal rejected bypass with: ${reflectionErrorMessage}`)

  // An empty event window is a true no-op: reflection observes
  // nothing, emits nothing, and the cursor stays put. (Repeated
  // passes over an unchanged log must be idempotent — emitting a
  // no_op here would append forever.)
  const emptyResult = await reflection.run({
    trigger: "programmatic",
    events: [],
    apply: false,
  })
  if (emptyResult.emitted) {
    return {
      passed: false,
      details: [
        ...details,
        "FAIL: reflection emitted a reflection.completed over an empty window. An empty window " +
          "must be a true no-op (no emission) so repeated passes stay idempotent.",
      ],
    }
  }
  if (emptyResult.payload.proposals.length !== 0) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: empty-window pass produced ${emptyResult.payload.proposals.length} proposal(s); expected 0.`,
      ],
    }
  }
  details.push("OK: empty-window pass is a true no-op (emitted=false, zero proposals)")

  // Confirm Reflection's own rule set never produces a normal-retrieval proposal.
  // The cascade rule only emits decision_dependency_flagged and no_op,
  // so no belief_transition targeting retrieval_status: normal can
  // originate from reflection itself. Verify over a window containing a
  // contradiction (which exercises the rule set).
  const ruleSetResult = await reflection.run({
    trigger: "tail_cascade",
    events: [
      {
        id: crypto.randomUUID(),
        seq: 0,
        type: "belief.transitioned",
        schema_version: "1",
        project_id: "probe-project",
        session_id: "probe-session",
        actor_id: "probe-actor",
        timestamp: new Date().toISOString(),
        logical_clock: 0,
        causal_parent_ids: [],
        payload_hash: "probe",
        payload: {
          belief_id: crypto.randomUUID(),
          axis: "truth_status",
          from_value: "supported",
          to_value: "contradicted",
          by_authority: "sentinel",
          rationale_id: crypto.randomUUID(),
        },
        versions: {},
      },
    ],
    apply: false,
  })
  const offenders = ruleSetResult.payload.proposals.filter(
    (p) =>
      p.kind === "belief_transition" && p.axis === "retrieval_status" && p.to_value === "normal",
  )
  if (offenders.length > 0) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: reflection's own rule set produced ${offenders.length} proposal(s) targeting retrieval_status: normal. This rule should not exist.`,
      ],
    }
  }
  details.push("OK: reflection's own rule set produces no restricted → normal retrieval proposals")

  // Stale-proposal guard: a belief_transition proposal carries the
  // source state it was minted against (from_value). If the belief
  // has since moved, applying the proposal must be rejected — the
  // rationale was written for a different source. Seed belief is at
  // truth_status=unverified; a proposal claiming from_value=supported
  // → contradicted (a legal reflection transition for the *supported*
  // source) must be refused because the belief is actually unverified.
  const staleRationale = explanationGen.build({
    subject_type: "belief_revision",
    subject_id: seed.id,
    audience: "audit",
    summary: "Probe: stale-source belief_transition proposal",
    full_text:
      "Probe verifies a belief_transition proposal whose from_value no longer matches the belief is rejected.",
    claims_used: [claim.id],
    evidence_used: [evidence.id],
  })
  const staleProposal: ReflectionProposal = {
    kind: "belief_transition",
    belief_id: seed.id,
    axis: "truth_status",
    from_value: "supported", // belief is actually 'unverified'
    to_value: "contradicted",
    rationale_id: staleRationale.id,
  }
  let staleRejected = false
  let staleError = ""
  try {
    await reflection.applyProposal(staleProposal, dummyReflectionEventId)
  } catch (err) {
    staleRejected = true
    staleError = err instanceof Error ? err.message : String(err)
  }
  if (!staleRejected) {
    return {
      passed: false,
      details: [
        ...details,
        "FAIL: applyProposal accepted a belief_transition whose from_value='supported' did not match " +
          "the belief's actual truth_status='unverified'. A stale proposal mutated state under a " +
          "rationale written for a different source.",
      ],
    }
  }
  if (!/stale|expected from|currently/.test(staleError)) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL: stale proposal was rejected, but not by the expected_from guard. Got: ${staleError}`,
      ],
    }
  }
  details.push(`OK: stale belief_transition (from_value mismatch) rejected with: ${staleError}`)

  void emittedPayload // tracked above; surface for audit if needed

  return {
    passed: true,
    details: [
      ...details,
      "All checks pass: reflection cannot — by table or by runtime — promote a belief " +
        "to retrieval_status: normal on its own, and stale belief_transition proposals are refused.",
    ],
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: reflection_cannot_promote_to_normal_alone")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
