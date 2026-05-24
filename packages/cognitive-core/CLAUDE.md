# @qmilab/lodestar-cognitive-core — CLAUDE.md

This is where the epistemic chain comes alive. The core consumes typed Observations and produces Claims, EvidenceSets, Beliefs, Decisions, and Explanations.

## What lives here

- **Extractors** (`src/extractors/`) — produce Claims from Observations. One extractor per observation schema (or generic LLM-driven extractor for ad-hoc schemas).
- **World model** (`src/world-model/`) — typed key-value store of the agent's current picture of the world. Separate from beliefs (beliefs are *about* world state; the world model captures current observed state).
- **Evidence linker** (`src/evidence-linker.ts`) — for a new claim, find supporting and contradicting sources from prior observations and beliefs.
- **Planner** (`src/planner.ts`) — turns goals into Decisions and Action proposals, respecting ContextPolicy.
- **Reflection** (`src/reflection.ts`) — scheduled or on-demand; produces proposals (claim, belief, skill, policy) without auto-committing.
- **Explanation generator** (`src/explanation.ts`) — produces structured Explanation records for governance events.

## Invariants

1. **No claim without an observation.** Every Claim references at least one Observation. Free-form LLM extractions without a source observation are invalid.
2. **No belief without evidence.** Every Belief points to a Claim, and adoption goes through the Memory Firewall, which requires an EvidenceSet.
3. **No decision without belief dependencies.** When `ContextPolicy.require_evidence_for_decisions = true`, decisions without `belief_dependencies` are rejected before they reach the planner output.
4. **No silent retrieval.** Every retrieval into model context goes through `@qmilab/lodestar-memory-firewall`'s `GatedRetrieval`. The core does not query the belief store directly.
5. **Reflection never auto-commits.** Reflection outputs are always proposals. The Memory Firewall (with appropriate authority) is the only path to commit.
6. **Working memory is ephemeral.** Anything in `working` is gone at session end. If something needs to survive, it must be promoted to episodic or semantic memory through the firewall.

## What does not live here

- Belief storage and lifecycle transitions: see `@qmilab/lodestar-memory-firewall`.
- Tool registry and execution: see `@qmilab/lodestar-action-kernel`.
- Trust ladder and approval surfaces: see `@qmilab/lodestar-policy-kernel`.
- Probes, sentinels, and calibrators: see `@qmilab/lodestar-harness`.
