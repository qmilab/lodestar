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
  observation type produces candidate claims. Two extractors ship
  built-in: `GitStatusExtractor` and `FsReadExtractor`. Both are
  pattern-based, not LLM-based — the source of evidence determines
  trust, not the extractor.
- **Evidence linker** — binds the candidate claim to the observations
  that produced it, computes aggregate strength, and labels the
  evidence kind (`tool_output`, `external_document`,
  `model_inference`, `user_input`, etc.).
- **Belief adoption** — proposes the candidate claim through the
  Memory Firewall. The firewall decides whether it can be adopted, at
  what truth/retrieval status, and with what initial freshness. The
  Cognitive Core never promotes a claim itself.
- **World model** — an in-memory store of currently-adopted beliefs,
  keyed by topic. The planner uses this as the read side.
- **Explanation generator** — produces an `Explanation` object for
  every chain transition, so downstream tracing has a structured
  rationale to render.

## Usage

```ts
import {
  CognitiveCore,
  registerBuiltInExtractors,
  InMemoryWorldModel,
} from "@qmilab/lodestar-cognitive-core"
import {
  MemoryFirewall,
  InMemoryClaimStore,
  InMemoryBeliefStore,
  InMemoryEvidenceStore,
} from "@qmilab/lodestar-memory-firewall"

registerBuiltInExtractors()

const firewall = new MemoryFirewall({
  claims: new InMemoryClaimStore(),
  beliefs: new InMemoryBeliefStore(),
  evidence: new InMemoryEvidenceStore(),
})

const core = new CognitiveCore({
  firewall,
  worldModel: new InMemoryWorldModel(),
})

await core.ingest({ observation, session_id })
```

## Invariants

1. **The Cognitive Core does not promote claims.** It proposes; the
   Memory Firewall disposes. The split is intentional.
2. **Evidence kind is part of the contract.** A claim derived from
   `external_document` evidence is labeled as such, and the firewall's
   auto-observation gate will refuse to silently promote it.
3. **Extractors are deterministic by default.** Built-in extractors
   are pattern-based. LLM extractors are possible but must declare
   `extraction_method: "model"` so the firewall can apply the
   appropriate gate.

## License

[Apache 2.0](./LICENSE).
