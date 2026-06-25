# ADR-0033: The harvest projection's candidacy gate

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Nandan, Claude
- **Related:** ADR-0031 (beliefs map to durable lessons; the read-side harvest
  projection), ADR-0032 (the evidence-linker cross-belief join), issue #154
  (epic — cognitive-core belief enrichment), the `pendingApprovals` projection
  in `@qmilab/lodestar-trace`

## Context

ADR-0031 locked the *mapping* — a `Belief` is a durable **lesson**, and a
read-side projection in `-trace` surfaces end-of-run **supported** beliefs and
**superseded-with-history** chains as advisory, human-review-gated memory
candidates. This ADR records the decisions the *implementation* (`harvestCandidates`,
epic item D) had to make that ADR-0031 left open.

ADR-0031's stated philosophy is "surface honest evidence + provenance, **not** to
classify" — the reviewer judges whether a lesson is keeper-worthy. Taken
literally, the projection would surface every belief whose current `truth_status`
is `supported`. But the harvest queue is a **position of trust**: a human is one
click ("Keep") away from carrying a surfaced lesson into the next run. That makes
it a softer instance of exactly what the Memory Firewall exists to prevent —
firewall-rejected content reaching a trusted position. A belief the firewall
**quarantined** (poisoned) or **hard-demoted** (`retrieval_status: blocked` /
`hidden` / `privileged_only`) but that nonetheless carries `truth_status:
supported` would, under a pure "surface everything supported" rule, be advertised
as a keeper candidate — laundering it past the no-self-promotion guarantee into a
human Keep queue.

The evidence-linker join (ADR-0032, #157) hit the dual of this and converged on a
reusable rule over four Codex rounds: *anything that lets prior beliefs influence
a trusted outcome must re-apply the firewall's full retrieval gate set, and a
belief the firewall rejected must not have downstream effects through a side
channel.* The harvest projection is a read surface, not a belief-derivation step,
so the rule is not wholesale — but the security-relevant subset of it applies.

## Decision

1. **Candidacy gate — the security-relevant subset of `DEFAULT_CONTEXT_POLICY`.**
   A belief is a keeper candidate only when its **reconstructed current** state is
   - `truth_status: supported` (a corroborated lesson; `unverified` /
     `contradicted` are not, and `superseded` appears only as history, decision 3), **and**
   - `security_status: clean`, **and**
   - `retrieval_status` ∈ {`normal`, `restricted`}.

   This mirrors the firewall's own context-policy defaults on exactly the two
   axes where surfacing would launder a firewall decision. `restricted` is kept
   (it is a normal adopted state, as in the ADR-0032 join's eligibility set);
   `hidden` / `blocked` / `privileged_only` are excluded.

2. **Freshness, sensitivity, scope, and confidence are surfaced, not gated.**
   These are the reviewer's call (ADR-0031: a stale or state-shaped lesson is
   noise the *reviewer* discards), so the projection surfaces all four lifecycle
   axes + confidence + scope on the candidate's `Belief` and lets the human judge.
   Sensitivity in particular is **not** gated here: the harvest read is a local
   operator surface (like `pendingApprovals`, which gates nothing), and an
   **egress** consumer — the session shipper — applies its own sensitivity ceiling
   when the candidate leaves the host. Gating sensitivity in the projection would
   double-apply a ceiling the wrong layer owns.

3. **The gate applies wherever rejected content would reach the Keep queue — a
   candidate *and* its supersession history.** A superseded belief is folded into
   the `supersedes` audit trail of the successor that replaced it (newest-first),
   preserving "we used to believe X, then learned Y", and is never a top-level
   candidate. But a predecessor that fails the *security* gate (quarantined /
   hard-demoted) is **dropped from the history too** — its content must not reach
   the human queue even as audit trail (the walk still traverses *through* it so a
   clean ancestor behind a rejected link still surfaces). Truth status is not gated
   on history members (a predecessor is `superseded` by construction). A
   supersession chain whose current head is not a clean, supported, retrievable
   lesson surfaces nothing — conservative for v0.

4. **Both adoption and transitions are trusted only when firewall-authored.** A
   governed agent's raw `ctx.emit` writes to the same log but is pinned to the
   session schema version and cannot stamp the firewall's
   (`FIREWALL_EVENT_SCHEMA_VERSION`), which is the load-bearing distinction:

   - **Adoption.** A `belief.adopted` event carries the full `Belief`, but it is
     surfaced **only** when a host-authored `firewall.belief.adopted@1` audit (the
     schema-stamped event the firewall emits on every gate-cleared adoption)
     confirms the *same* `belief_id` **and** the record's `claim_id` matches the
     audit's. So an agent cannot `ctx.emit("belief.adopted", …)` a fabricated belief
     into the Keep queue (no audit), nor swap a genuine id onto a different claim's
     content (claim_id mismatch) — both are correctly not harvestable. The full
     record is taken **first-wins** per id, so a later forged re-emit cannot
     overwrite a genuine adoption's content (e.g. flip `quarantined → clean`). The
     candidate's **evidence** is the *exact* set the audit's `evidence_id` names —
     not the latest assessment for the claim, which may post-date what cleared the
     gate — so the provenance shown is the provenance the firewall approved.
   - **Transitions.** Reconstruction (which replays `firewall.belief.transitioned`
     in logical-clock order, so an `unverified → supported` promotion counts and a
     `supported → quarantined` demotion excludes) trusts a transition only when it
     carries the canonical type, `schema_version === FIREWALL_EVENT_SCHEMA_VERSION`,
     and a payload that strictly validates — so an agent cannot fake a
     `security_status → clean` clearance. A bare `belief.transitioned` or a
     `kind`-tagged agent emit is **not** trusted.

   (A pure projection still cannot defend against direct log-file tampering — that
   is the signing boundary every projection shares, exactly as `pendingApprovals`
   trusts the guard's audit. This closes the *in-process* forgery paths a governed
   agent has via `ctx.emit`: forge an adoption, overwrite adoption content, or forge
   a clearance.)

No `packages/core` schema change and no new event (ADR-0031 decision 3 holds):
`MemoryCandidate` / `SupersededLesson` are `-trace` projection types reusing
`Belief` / `Claim` / `EvidenceSet`.

## Consequences

- **Easier:** a poisoned or hard-demoted belief cannot be advertised as a keeper
  candidate, so the no-self-promotion guarantee extends cleanly to durable memory.
  Consumers get the same conservative posture the firewall already enforces, on
  the axes that matter, without re-implementing the gate.
- **Harder / accepted:** the projection makes *two* security classifications
  (quarantined-out, hard-demoted-out) rather than ADR-0031's "classify nothing"
  ideal. This is a deliberate, narrow exception justified by the trust position of
  the Keep queue; everything non-security stays the reviewer's call. A
  state-shaped lesson ("branch is main") still surfaces if it is supported/clean —
  that is the reviewer's discard, and the upstream extractor's design
  responsibility (epic child C-2).
- The gate is the locked spec of the `harvest-projection-surfaces-durable-lessons`
  probe (the headline assertion: a quarantined / blocked belief appears nowhere in
  the queue, not even as history).

## Alternatives considered

- **Surface every supported belief, gate nothing (literal ADR-0031).** Rejected:
  it would advertise a quarantined-but-supported or blocked-but-supported belief as
  a keeper candidate, laundering firewall-rejected content into the human Keep
  queue — the exact failure the firewall exists to prevent, one approval click away.
- **Re-apply the firewall's *full* retrieval gate (scope + freshness + sensitivity
  + uncertainty), as the ADR-0032 join does.** Rejected for a read surface: it
  would hide stale or cross-scope lessons the reviewer might still want, double-apply
  the sensitivity ceiling the shipper owns at egress, and over-rotate a "surface for
  judgment" projection into a "decide for the human" one. Only the security-relevant
  subset is justified.
- **Surface superseded beliefs as their own candidates.** Rejected: it duplicates
  the lesson (the successor is the current lesson) and buries the replacement signal.
  History-under-successor keeps the audit trail without the noise.
