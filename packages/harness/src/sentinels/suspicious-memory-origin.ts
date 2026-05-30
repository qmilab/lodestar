import type { EventEnvelope } from "@qmilab/lodestar-core"
import {
  Sentinel,
  type SentinelFinding,
  asBeliefView,
  asDecisionView,
  asEvidenceSetView,
} from "../sentinel.js"

/**
 * Suspicious memory-origin sentinel.
 *
 * Roadmap (Batch 4): "Watches `belief.adopted`; alerts when an
 * `external_document`-sourced belief becomes a `belief_dependency` of a
 * Decision."
 *
 * The shape it catches: content from a file / webpage / email — the
 * highest-poisoning-risk evidence quality — is laundered through a belief
 * and then leaned on to make a decision. The Round 5 auto-observation gate
 * already stops such content from auto-promoting to `supported`; this
 * sentinel covers the residual path where a still-`external_document`-rooted
 * belief nonetheless ends up steering a decision.
 *
 * Tracking: a belief does not carry its evidence quality directly. The
 * origin is learned from the `evidence.assessed` event (the EvidenceSet's
 * items carry `quality`), tied to a belief via the shared `claim_id` on the
 * subsequent `belief.adopted`. The alert itself fires later, at
 * `decision.made`, when such a belief appears in `belief_dependencies`.
 *
 * One alert per offending belief (subject `kind: "belief"`), not one per
 * decision — this is deliberate. It matches the reflection schema's note
 * that a `sentinel.alerted` names a `belief_id` as subject, and it is what
 * the eventual `arbitrate` hook wants: a belief-scoped flag it can look up
 * against a later action's `belief_dependencies`.
 */
export class SuspiciousMemoryOriginSentinel extends Sentinel {
  readonly name = "suspicious-memory-origin"
  readonly description =
    "Flags a decision that depends on a belief whose supporting evidence includes an external_document item — the highest poisoning-risk origin."

  /**
   * State is partitioned by session and dropped on session end. The
   * evidence→belief→decision chain is intra-session, and the in-memory
   * stores are session-scoped, so nothing of value survives a session;
   * this is what bounds memory on a long-running live tail. (Cross-session
   * provenance is the job of the persistent belief store — Batch 4 step 7 —
   * and its dedicated probe, not this in-memory tail watcher.)
   */
  private readonly bySession = new Map<
    string,
    {
      /** claim_ids whose evidence set carries a non-contradicting external_document item */
      externalDocClaims: Set<string>
      /** belief_id -> claim_id */
      beliefClaim: Map<string, string>
      /** (decision_id, belief_id) pairs already alerted, so a replayed decision does not double-fire */
      alerted: Set<string>
    }
  >()

  private stateFor(sessionId: string) {
    let state = this.bySession.get(sessionId)
    if (!state) {
      state = { externalDocClaims: new Set(), beliefClaim: new Map(), alerted: new Set() }
      this.bySession.set(sessionId, state)
    }
    return state
  }

  inspect(event: EventEnvelope): SentinelFinding[] {
    switch (event.type) {
      case "evidence.assessed": {
        const evidence = asEvidenceSetView(event.payload)
        if (evidence?.claim_id && this.hasExternalDocSupport(evidence)) {
          this.stateFor(event.session_id).externalDocClaims.add(evidence.claim_id)
        }
        return []
      }
      case "belief.adopted": {
        const belief = asBeliefView(event.payload)
        if (belief?.claim_id) {
          this.stateFor(event.session_id).beliefClaim.set(belief.id, belief.claim_id)
        }
        return []
      }
      case "decision.made":
        return this.checkDecision(event)
      default:
        return []
    }
  }

  private hasExternalDocSupport(evidence: {
    items?: Array<{ relation?: string; quality?: string }>
  }): boolean {
    for (const item of evidence.items ?? []) {
      // A contradicting external document is not a poisoning risk to act
      // on — only evidence the belief actually rests on matters.
      if (item.quality === "external_document" && item.relation !== "contradicts") return true
    }
    return false
  }

  private checkDecision(event: EventEnvelope): SentinelFinding[] {
    const decision = asDecisionView(event.payload)
    if (!decision) return []
    const state = this.stateFor(event.session_id)
    const dependencies = decision.belief_dependencies ?? []

    const findings: SentinelFinding[] = []
    for (const beliefId of dependencies) {
      const claimId = state.beliefClaim.get(beliefId)
      if (claimId === undefined || !state.externalDocClaims.has(claimId)) continue
      const key = `${decision.id} ${beliefId}`
      if (state.alerted.has(key)) continue
      state.alerted.add(key)
      findings.push({
        rule: "external-document-belief-steers-decision",
        severity: "warning",
        subject: { kind: "belief", id: beliefId },
        message: `Decision ${decision.id} depends on belief ${beliefId}, whose supporting evidence includes external_document content (file/webpage/email — high poisoning risk).`,
        observed_event_ids: [event.id],
        detail: {
          decision_id: decision.id,
          belief_id: beliefId,
          claim_id: claimId,
        },
      })
    }
    return findings
  }

  override onSessionEnd(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
