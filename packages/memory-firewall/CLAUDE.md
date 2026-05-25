# @qmilab/lodestar-memory-firewall — CLAUDE.md

This package governs the lifecycle of claims and beliefs. It is the gate between "an agent extracted something" and "the agent has adopted this as a belief it acts on."

## What lives here

- **Stores** (`src/stores/`) — abstract interfaces for claim, belief, and evidence storage. v0 ships an in-memory implementation; v0.2 adds Postgres.
- **Firewall** (`src/firewall.ts`) — the promotion gate. Decides whether a candidate claim can become a belief, and whether a belief can be promoted across lifecycle states.
- **Retrieval** (`src/retrieval.ts`) — gated retrieval. Respects ContextPolicy. Returns only beliefs that pass the lifecycle and sensitivity filters.

## Invariants

1. **No self-promotion.** An agent's own success does not promote a belief from `unverified` to `supported` or from `restricted` to `normal`. Promotion requires user confirmation, probe verification, or a narrow auto-promotion policy with logged evidence.

2. **Lifecycle axes are independent.** A change to `freshness_status` does not change `truth_status`. A change to `security_status` does not change `freshness_status`. Each axis has its own transition rules.

3. **Quarantine is one-way without explicit clearance.** A belief that enters `security_status: quarantined` does not return to `clean` without an explicit clearance event from an authorised actor.

4. **Retrieval respects ContextPolicy or refuses.** No retrieval path bypasses the policy gate. If a caller wants beliefs that the policy excludes, it must request `privileged_only` retrieval explicitly and be authorised for it.

5. **Every state transition produces an Explanation.** The firewall does not silently mutate state. Every promotion, demotion, quarantine, or supersession event carries a structured rationale.

6. **Contradiction routing is subject-related (Round 5).** Both the standard planner path (`GatedRetrieval.retrieve()` → `result.contradictions`) and the standalone surface (`GatedRetrieval.retrieveContradictions()` / `MemoryFirewall.retrieveContradictions()` — a thin delegate) return ONLY contradicted beliefs whose claim shares the same `structured_predicate.{subject, relation}` as one of the accepted-set beliefs the standard retrieval would return under the same policy.

   Design choices:
   - **(subject, relation) join, not subject-only.** Contradiction is meaningful when two beliefs assert different objects for the same proposition (`branch.current = main` vs `branch.current = release/foo`). Subject-only would lump unrelated relations together.
   - **Collision-free composite key.** Encoded as `JSON.stringify([subject, relation])`, not a delimiter-joined string — the Predicate schema allows free-form strings, so a delimiter byte can appear in either component (e.g. via mem0 / Letta / Zep imports of arbitrary user text).
   - **Same acceptance gates as `retrieve()`.** Freshness and uncertainty post-filters apply BEFORE predicate keys are extracted from the accepted set, and apply again to contradicted candidates. A stale supported belief that wouldn't actually be in the planner's context cannot drag in contradictions for itself; a stale contradiction cannot surface either.
   - **Claims without `structured_predicate` are excluded.** They cannot be subject-joined; the channel surfaces only what we can prove related.

   Subject-filtering implementation lives in `GatedRetrieval` (single source of truth — see `src/retrieval.ts`); `MemoryFirewall.retrieveContradictions` is a thin firewall-level surface that delegates to it. Sensitivity, scope, security, and retrieval gates still apply.

## What does not live here

- Claim extraction from observations: see `@qmilab/lodestar-cognitive-core/extractors`.
- Belief retrieval into model context: see `@qmilab/lodestar-cognitive-core` planner.
- Reflection that proposes promotions: see `@qmilab/lodestar-cognitive-core/reflection`.
- Sentinel hooks that flag suspicious beliefs: see `@qmilab/lodestar-harness/sentinels`.

## File layout

```
src/
├── index.ts                  # public exports
├── firewall.ts               # MemoryFirewall class
├── retrieval.ts              # gated retrieval
├── stores/
│   ├── claim-store.ts        # interface + in-memory impl
│   ├── belief-store.ts       # interface + in-memory impl
│   ├── evidence-store.ts     # interface + in-memory impl
│   └── memory-store.ts       # interface + in-memory impl (typed memories)
└── transitions.ts            # allowed state transitions per axis
```

## When adding a new lifecycle state

Don't. The four axes (truth, retrieval, security, freshness) are stable. If you need a new dimension, add it as a separate attribute on the Belief schema with explicit transition rules. Do not silently add values to the existing enums.

## When adding a new transition rule

1. Update `transitions.ts` with the new allowed pair (from, to, authority required).
2. Add a test in `research/probes/` that exercises both the allowed transition and a rejected one.
3. Document the rule in this CLAUDE.md.
