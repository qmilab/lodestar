# @qmilab/lodestar-memory-firewall-mem0

Adapter that imports memories from [mem0](https://github.com/mem0ai/mem0)
into the Orrery memory firewall.

## v0.2 scope (Batch 2 deliverable)

- `importMemories(raw, options)` is implemented end-to-end: validates
  the mem0 export schema, constructs one Claim + one EvidenceSet per
  record, and adopts each as a Belief at `truth_status: unverified` /
  `retrieval_status: restricted`. Returns a structured result with
  per-record rejection reasons.
- `exportMemories()` and `syncMemories()` throw — full semantics need
  adapter-specific design work that exceeds this batch's budget.

## Usage

```ts
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@qmilab/lodestar-memory-firewall"
import { Mem0Adapter } from "@qmilab/lodestar-memory-firewall-mem0"

const claims = new InMemoryClaimStore()
const beliefs = new InMemoryBeliefStore()
const evidence = new InMemoryEvidenceStore()
const firewall = new MemoryFirewall(claims, beliefs, evidence, async () => {})

const adapter = new Mem0Adapter(firewall, evidence)

const result = await adapter.importMemories(
  {
    source: "mem0",
    memories: [
      { id: "m1", memory: "User prefers small, focused PRs.", user_id: "u1" },
    ],
  },
  {
    scope: { level: "project", identifier: "my-project" },
    sensitivity: "internal",
    source_actor_id: "human-nandan",
    trust_baseline: 0.5,
  },
)

console.log(result)
// { adapter: "mem0", imported_count: 1, ..., belief_ids: [...] }
```

## Why imports cannot self-promote

mem0 records are external documents from the firewall's point of view.
The Round 5 invariant says external_document evidence cannot promote
silently through `auto_observation` — adopting them at `truth_status:
supported` would defeat the no-self-promotion rule that protects
against MemoryGraft-class attacks. The adapter therefore lands every
import at `unverified/restricted`, and a reflection pass or human
action must explicitly promote them before they enter normal
retrieval.

## What is not in scope

- Real mem0 SDK integration (HTTP calls, vector search, etc.). The
  adapter operates on an exported JSON structure, not against a live
  mem0 instance.
- Bidirectional sync (writing Orrery beliefs back into mem0).
- Schema evolution. The export shape is captured against the v0
  upstream format; future mem0 versions will need a separate adapter
  pack.
