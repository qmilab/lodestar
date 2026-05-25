# @qmilab/lodestar-cognitive-core

Claim extraction, evidence linking, and belief adoption for the
Lodestar epistemic chain — the layer above the Memory Firewall. Part of
[Lodestar](https://qmilab.com/lodestar) — the trust layer for AI agents.

The Cognitive Core is what turns an Observation into a Claim, links
that Claim to its supporting evidence, and proposes it to the Memory
Firewall for adoption as a Belief.

## Install

```sh
npm install @qmilab/lodestar-cognitive-core
# or
bun add @qmilab/lodestar-cognitive-core
```

## What it does

- **Claim extractors** — `registerExtractor()` declares how a given
  observation schema produces candidate claims. Two extractors ship
  built-in via `registerBuiltInExtractors()`: `GitStatusExtractor` and
  `FsReadExtractor`. Both are pattern-based, not LLM-based.
- **Evidence linker** — binds a candidate claim to its source
  observations and any related prior beliefs, returning an
  `EvidenceSet` the firewall can evaluate.
- **Explanation generator** — produces a structured `Explanation`
  for chain transitions.
- **World model** — an in-memory key-value store of currently-adopted
  beliefs, keyed by topic.
- **Belief adoption** — `core.ingest(observation, context)` runs the
  end-to-end pass and proposes adoption through the Memory Firewall.
  The firewall decides whether to adopt, at what truth/retrieval
  status, and with what freshness. The Cognitive Core never promotes
  a claim itself.

## Usage

```ts
import {
  CognitiveCore,
  EvidenceLinker,
  ExplanationGenerator,
  InMemoryWorldModel,
  registerBuiltInExtractors,
} from "@qmilab/lodestar-cognitive-core"
import {
  MemoryFirewall,
  InMemoryClaimStore,
  InMemoryBeliefStore,
  InMemoryEvidenceStore,
} from "@qmilab/lodestar-memory-firewall"

registerBuiltInExtractors()

const claims = new InMemoryClaimStore()
const beliefs = new InMemoryBeliefStore()
const evidence = new InMemoryEvidenceStore()
const firewall = new MemoryFirewall(claims, beliefs, evidence, async () => {})

const core = new CognitiveCore(
  firewall,
  new EvidenceLinker(evidence, beliefs),
  new ExplanationGenerator("agent-1"),
  new InMemoryWorldModel(),
)

await core.ingest({
  observation,
  context: {
    actor_id: "agent-1",
    project_id: "my-project",
    session_id: "sess-1",
    default_scope: { level: "project", identifier: "my-project" },
    default_sensitivity: "internal",
  },
})
```

## Invariants

1. **The Cognitive Core does not promote claims.** It proposes; the
   Memory Firewall disposes. The split is intentional.
2. **No claim without an observation.** Every Claim references at
   least one source Observation.
3. **No belief without evidence.** Adoption is gated by the firewall,
   which requires an `EvidenceSet` built by the `EvidenceLinker`.
4. **Evidence kind is part of the contract.** A claim derived from
   `external_document` or `model_inference` evidence is labeled as
   such; the firewall's auto-observation gate then refuses to silently
   promote it to `truth_status: supported`.

## License

[Apache 2.0](./LICENSE).
