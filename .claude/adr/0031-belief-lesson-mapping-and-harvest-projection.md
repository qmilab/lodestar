# ADR-0031: Beliefs map to durable lessons; a read-side harvest projection in -trace

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Nandan, Claude
- **Related:** issue #154 (epic — cognitive-core belief enrichment for durable-memory
  harvest), ADR-0014 (the "every read-side surface is a pure projection over
  `EventEnvelope[]`" principle), ADR-0029 (observe through events/projections, not store
  interfaces), the `pendingApprovals` graduation to `@qmilab/lodestar-trace`

## Context

A downstream consumer (Asterism) wants to harvest *belief-grade, evidence-carrying,
human-reviewable durable memory* from a run's epistemic chain. That raised a mapping
question with no recorded answer: a Lodestar belief today often **reads** as current
world-state ("branch is X", "file is N bytes"), because the two shipping extractors
(`git.status`, `fs.read`) emit current-state claims. Is the intended consumer mapping
**belief → a current-state store**, or **belief → a durable "lesson"**? Without a lock,
each consumer would invent its own answer, and a harvest surface would calcify around
whichever one shipped first.

Two facts constrain the choice. (1) Lodestar **already** separates concerns: the
`WorldModel` is the agent's current observed state (`core.ts` writes it from
`structured_predicate` at a fixed confidence), while a `Belief` is an evidence-backed,
lifecycle-tracked proposition *about* the world. (2) The belief machinery — evidence
provenance, `truth_status`, **supersession (`superseded_by`)**, calibration — is exactly
what a durable lesson store needs and a current-state KV does not.

## Decision

1. **Beliefs map to durable lessons, not current world-state.** The `WorldModel` remains
   the current-state store. A consumer harvesting durable memory reads the **belief**
   store/event stream; if it also needs current state, it reads the `WorldModel`
   separately. Whether a given belief *reads* as state vs. lesson is a **claim-design
   (extractor) choice** upstream, not a property the harvest surface must reconcile.
2. **Supersession is the lesson-replacement primitive.** A newer lesson supersedes an
   older one via `superseded_by`, **preserving the audit trail** rather than overwriting —
   the property a current-state KV deliberately lacks.
3. **Add a read-side harvest projection in `@qmilab/lodestar-trace`.** A pure projection
   over `EventEnvelope[]` that surfaces, at end-of-run, the **supported** beliefs and the
   **superseded-with-history** chains as **review-ready memory candidates**, each carrying
   its evidence + provenance so a human reviewer can judge it. It lands in `-trace`
   (projection belongs there per the viewer's charter — the same home `pendingApprovals`
   graduated to), **mirrors `pendingApprovals`'** shape, and is **advisory / human-review
   gated — never auto-promoted**. No `packages/core` schema change: it reuses `Belief` /
   `EvidenceSet` / `Explanation` and emits no new event (it is a read, not new state).

## Consequences

- **Easier:** consumers get one stable, supported harvest surface and a locked mapping, so
  they stop each inventing their own (and stop binding to the experimental store interfaces
  — consistent with ADR-0029). Supersession gives lesson replacement with the audit trail
  intact.
- **Harder / accepted:** a current-state-shaped belief ("branch is X") harvested as a
  "lesson" is noise — but that is the **reviewer's** call (the human-review gate) and the
  **consumer's** extractor-design responsibility; the projection's job is to surface honest
  evidence + provenance, not to classify. The projection is only as useful as the upstream
  claims are lesson-shaped, which is why generic/LLM extraction (epic child C-2) is the
  natural follow-on.
- The harvest surface is read-only and additive; it can ship independently of epic children
  A and B (it surfaces whatever beliefs exist; A/B make more of them corroborated/superseded).

## Alternatives considered

- **belief → current-state store.** Rejected: that is the `WorldModel`'s job; beliefs carry
  evidence/lifecycle/calibration a current-state KV doesn't need, and overwrite-on-update
  would lose the audit trail that supersession preserves.
- **Harvest projection in `@qmilab/lodestar-viewer`.** Rejected: projection belongs in
  `-trace` (the viewer's own charter), exactly the reasoning behind the `pendingApprovals`
  graduation.
- **A new durable `memory.candidate@1` event type.** Rejected for v0: the projection is a
  pure read over existing events; emitting a new event would duplicate state. Revisit only
  if candidates must be tracked across runs (e.g. "already-reviewed" status).
