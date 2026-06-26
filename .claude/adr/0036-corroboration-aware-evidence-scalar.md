# ADR-0036: Corroboration-aware evidence scalar as a separate, non-gate signal

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Nandan
- **Related:** #158 (epic #154, deferred from child A / #157), ADR-0031, ADR-0032, ADR-0033, PR #166

## Context

`aggregateStrength` (`memory-firewall/src/stores/evidence-store.ts`) is normalized
`(S − C)/(S + C)`, so an all-supporting evidence set is **always exactly `1.0`** no
matter how many independent sources back it — only contradiction moves the scalar.
#157's original AC#1 ("corroboration → a higher number") was unsatisfiable against it
and was reframed (ADR-0032) around a *promotion outcome*; the **scalar** version was
split out to #158.

The constraint that kept it out of #157 still holds: `aggregateStrength` is the **gate
input**. `cognitive-core/core.ts` adopts a belief only at `> 0` and auto-promotes to
`truth_status: supported` only at `>= 0.7` (with the Parallax quality gate on top), and
`firewall.ts` re-checks `> 0`. De-normalizing it in place would shift confidence and the
promotion threshold for **every** belief — a calibration change needing its own story
and a re-baseline of every consumer.

The motivation for #158 is **ranking/legibility**, not gating: a consumer (Asterism's
durable-memory harvest, a "best-evidenced first" UI) wants to tell a lone-source lesson
from a well-corroborated one. That is a number *beside* the gate, not a new gate.

## Decision

Add a **second, additive scalar** `corroborationStrength(evidence)` next to
`aggregateStrength` (single file, single source of the independence-group semantics —
shared `strongestPerGroup`, so the two aggregators can't drift on what counts as
corroboration). Leave `aggregateStrength` and every gate path **byte-for-byte
unchanged**.

Model: a **noisy-OR** over independent supporting groups — "probability at least one
independent source is right". Each group contributes `p = quality × freshness ×
SOURCE_CONFIDENCE_CEILING ∈ [0, 0.95]`; `score = supportConfidence ×
(1 − contradictConfidence)`. The `0.95` ceiling (mirroring core.ts's existing confidence
clamp) keeps even a lone `direct_observation` below the cap, so corroboration is *always*
legible. The score is monotone in independent supporting groups, saturating, bounded in
`[0, 1)`, quality-weighted, and dampened by contradiction.

Wire it into the one consumer that motivates it: `harvestCandidates` stamps a derived
`MemoryCandidate.corroboration` (present only when evidence is) so the Keep queue can rank
"best-evidenced first". This adds a `trace → memory-firewall` dependency (publishes in
order; no cycle) — the cost of importing the single source rather than duplicating the
formula. Harvest's candidacy gate and oldest-first ordering are **unchanged**: the score
ranks, it does not gate.

Like `aggregateStrength`, this is a v0 heuristic, not calibrated, and is **off** the
stable `public-api-surface` ledger (deliberately recalibratable).

## Consequences

- **All four #158 ACs fall out with no gate change.** Monotone/saturating (the new
  scalar), bounded + gate-backward-compatible (the gate never sees it), Parallax
  (structural — two `external_document` still can't auto-promote because the gate path is
  untouched), consumers audited (nothing to re-baseline — `aggregateStrength` is
  unchanged; the cross-belief / generic-llm probes that assert specific
  `aggregateStrength` values still pass).
- One new probe, `corroboration-strength-rewards-independent-sources`, pins the scalar's
  contract directly *and* drives the real harvest projection over an on-disk NDJSON log
  (the ranking use case + the gate-untouched headline).
- The harvest projection gains an optional ranking field; #161's behavior (candidacy,
  order, no-launder) is unaffected.

## Alternatives considered

- **De-normalize `aggregateStrength` in place** — rejected (same reason as #157): shifts
  the promotion gate for all consumers; needs a calibration story. The whole point of a
  separate scalar is to avoid touching the gate.
- **Compute corroboration inline in `harvest.ts`** (no `trace → memory-firewall` dep) —
  rejected: duplicates the noisy-OR + independence-group logic, the exact drift ADR-0032
  avoided by sharing `predicateKey`. Single source wins over a saved dependency edge.
- **Put `corroborationStrength` in `@qmilab/lodestar-core`** — rejected: it would split
  the two sibling aggregators across packages. They share `strongestPerGroup`; they
  belong in one file.
- **Promote the scalar to the stable public-API ledger** — rejected: it is an
  uncalibrated v0 heuristic, exactly the kind of surface kept experimental (its sibling
  `aggregateStrength` isn't on the ledger either).
