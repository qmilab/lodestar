# ADR-0032: Evidence-linker cross-belief join via quality inheritance

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Nandan
- **Related:** #157 (epic #154, child A), #158 (deferred scalar aggregator), ADR-0031, docs/internal/scope-157-evidence-linker-claim-store-join.md
- **Refined by:** ADR-0037 (#165) — the P2#1 world-model write rule (a net-contradicted claim does not overwrite observed state) is extended so a positive-but-auto-observation-gated claim is also withheld from current state.

## Context

`evidence-linker.ts:61-76` is a placeholder: every belief is judged in isolation, with
no second-source corroboration and nothing ever `contradicted` from an observation
chain. #157 fills it. Two forces shaped the approach:

1. **#157's AC#1 ("corroboration → higher `aggregateStrength`") is unsatisfiable.** The
   aggregator is normalized `(S − C)/(S + C)`, so an all-supporting set is **always**
   `1.0` regardless of how many independent sources back it; only contradiction moves the
   scalar. De-normalizing it would shift belief confidence and the `≥ 0.7` promotion
   threshold for every consumer (`core.ts`, `reflection`, `guard`) — a calibration
   change out of scope for a linker fix.
2. A `Belief` carries no source/independence pointer (only `claim_id`), so the linker
   has nothing to set a cross-belief evidence item's quality from on its own.

## Decision

Implement the join by walking `belief.claim_id → ClaimStore.get` (a new linker dep) for
the prior claim's `structured_predicate`, and reading the prior belief's own
`EvidenceSet` via the already-held `EvidenceStore` for its **strongest supporting
quality + matching `independence_group`**. The cross-belief item **inherits** that
quality and group: same `(subject, relation)` + same `object` → `supports`; different
`object` → `contradicts`. Reuse the `(subject, relation)` `predicateKey` from
`retrieval.ts`, **extracted to a shared exported helper** so the two joins can't drift.
The shared cross-belief logic lives in a `protected crossBeliefItems()` helper that all
four linker bodies call: the three `Doc`/`MCP`/`Runtime`-aware subclasses **override**
`linkForClaim` rather than calling `super` (the strict-insert `EvidenceStore.put` forbids
a `super` + patch), so the join cannot live only in the base method.

**Reframe AC#1** around the **promotion outcome** rather than the scalar: a lone-source
`external_document` claim, independently corroborated by a higher-quality belief in a
distinct group, promotes `unverified → supported` (where alone it stays `unverified`).
The corroboration-aware *scalar* is split out to **#158** as future work.

## Consequences

- Every AC falls out with **no `aggregateStrength` change and no gate change**: quality
  inheritance means two `external_document` beliefs keep `strongest = external_document`
  (blocked, Parallax holds), a stronger independent source clears the gate (promotion),
  and a same-source re-read dedups to nothing. Store parity is free (interface-only).
- Finally *implements* the "independent corroboration promotes" path `core.ts` already
  documents but never built — as a crisp, binary, probe-able flip.
- The linker stays pure (records items only; never transitions the prior belief — that
  is reflection's job, epic child B).
- Accepted v0 simplifications: a prior belief contributes only its strongest item's
  group; the join is O(beliefs-in-scope) per ingest.

## Alternatives considered

- **Change `aggregateStrength` to reward independent groups** (make the scalar rise) —
  rejected for #157: shifts confidence + the promotion threshold for all consumers and
  needs a calibration story; deferred to #158.
- **Hardcode the cross-belief item quality** (e.g. always `direct_observation`) —
  rejected: would let two `external_document` beliefs promote, breaking Parallax (AC#3).
- **Put the join only in the base `linkForClaim`** — rejected: the three subclasses
  re-implement the body, so it would silently skip them.
