# ADR-0034: Reflection DERIVE rule — propose-only supersession from conflicting supported beliefs

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Nandan
- **Related:** #154 (epic, child B), #157 / ADR-0032 (the evidence-linker cross-belief join it builds on), ADR-0031 (belief→lesson mapping), #158 (deferred corroboration-aware scalar)

## Context

`reflection.ts` only ever *cascaded* a pre-existing contradiction: a
`belief.transitioned → contradicted` event the firewall or a sentinel already
recorded flags dependent decisions. It never **derived** a contradiction from
belief state. Per epic #154, a pure-ingest chain that never tripped a sentinel
therefore produced only `no_op`s — no contradiction, no supersession was ever
surfaced from an observation chain. Child B closes that: the `markSuperseded`
*apply* path already exists (ADR-0032 left transitioning the prior belief to
reflection); only the *detect* rule was missing.

Three forces shaped the design:

1. **The #157 ingest-time join already blocks the obvious case.** When a new
   claim conflicts with a prior supported belief on `(subject, relation)`, the
   linker records a `contradicts` item that nets the claim's strength `≤ 0`, so
   it is *not adopted*. Two conflicting supported beliefs therefore cannot
   normally co-exist via a single ingest path — they arise when beliefs enter
   through *different* paths (external-memory imports, user/policy assertions,
   separately-built sessions later merged). The derive rule is the
   reflection-time scan that catches exactly those.
2. **A derived contradiction is a hypothesis, not a fact.** Recency is the only
   signal the rule has; it cannot know whether the world changed (supersession)
   or two sources genuinely disagree (one is wrong). Auto-demoting a real
   `supported` belief on that signal is unsafe.
3. **The output is human-facing and names both beliefs.** It feeds the
   human-review / Keep gate the motivating consumer (Asterism) wants — so it
   must not leak a higher-sensitivity belief's existence into a lower
   compartment.

## Decision

A third reflection rule, `detectDerivedSupersessions`. For each belief whose
`belief.adopted` / `firewall.belief.adopted` event lands in the cursor window
(single-fire idempotence, mirroring the cascade's "contradiction in the window"
gate), walk the belief store for another belief in the same scope sharing the
trigger's claim `predicateKey(subject, relation)` but asserting a different
`stableStringify(object)`, and emit one `belief_supersession` proposal per
conflicting pair — older `superseded_by` newer (ordered by `observed_at` by
instant, then `last_verified_at`, then id; deduped on the oriented pair).

- **Propose-only, enforced at the run loop.** `run()` surfaces the proposal in
  `payload.proposals` but **never applies it, even under `apply: true`** — they
  are tracked by reference and skipped in the apply loop, counted in a new
  `AppliedSummary.belief_supersessions_proposed` (never `belief_supersessions`).
  A reviewer applies one explicitly via the existing public `applyProposal`.
- **Supersession-only output.** The rule detects a *contradiction* but proposes
  a *supersession* (the actionable resolution that carries the
  `superseded_by → newer` link). It does not emit a raw `contradicted`
  transition, which would force the rule to pick which belief is "wrong" — the
  reviewer's call. The rationale documents both beliefs so a reviewer can
  instead adjudicate it as a mutual contradiction.
- **Full gate reuse, narrowed.** Peers reuse the evidence-linker's exported
  `isEligibleJoinPeer` (clean security, not contradicted/superseded/expired,
  retrievable, confident-or-asserted) **plus `truth_status === "supported"`**
  (the epic's "two supported beliefs"; the linker keeps `unverified` for
  Parallax, the derive rule does not), over the shared `predicateKey` /
  `stableStringify` — single source, no drift.
- **Equal-sensitivity pairing — stricter than the linker's `≤` ceiling.**
  Because the output names both beliefs to a human, a cross-compartment pairing
  would leak in *whichever* direction the higher belief sits — and the higher
  belief can itself be the window trigger, the direction a `max_sensitivity`
  ceiling alone does not block. Pair only `peer.sensitivity === trigger.sensitivity`.
- **No authenticity gate needed.** Unlike the harvest projection (ADR-0033),
  the rule reads everything substantive from the firewall-governed store and
  only *proposes*; a forged `belief.adopted` event can at most trigger a scan of
  an already-legitimate belief. The event only selects *which* beliefs to scan.
- Needs the belief + claim stores; a dry-run pass without them is a no-op, not
  an error (consistent with `lodestar reflect`'s store-less inspection mode).

## Consequences

- No `packages/core` schema change — `belief_supersession` already exists in
  `ReflectionProposalSchema`; the only API addition is the
  `AppliedSummary.belief_supersessions_proposed` counter (cognitive-core local).
- No production behaviour change for existing hosts: the only `Reflection.run`
  caller today is the CLI at `apply: false`, and derive proposals never
  auto-apply regardless.
- Locked by `reflection-derives-supersession-from-conflict` (16 checks, A–K),
  in-memory (the rule adds no store method; #157's probe already covers Postgres
  store semantics). 69 first-party probes / 73 total.

## Alternatives considered

- **Apply derived proposals under `apply: true` like the cascade rule** —
  rejected: auto-demoting a real supported belief on a recency heuristic is the
  unsafe move the epic's "never auto-apply" forbids; the conflict needs human
  adjudication.
- **Emit a raw `belief_transition → contradicted`** — rejected: forces the rule
  to pick a loser; supersession is the resolution the rule can actually ground
  (temporal order) and carries the `superseded_by` link.
- **Mirror the linker's `≤ ceiling` sensitivity gate** — rejected for this rule:
  it leaves the secret-belief-as-trigger direction open, leaking a
  higher-compartment belief's existence into a human-facing proposal.
- **Re-scan all state every pass (no window gate)** — rejected: re-proposes the
  same unresolved conflict forever (the "no_op forever" anti-pattern the cursor
  model exists to avoid).
