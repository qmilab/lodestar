# @qmilab/lodestar-memory-firewall-letta

Adapter that imports memory blocks from [Letta](https://github.com/letta-ai/letta)
(formerly MemGPT) into the Orrery memory firewall.

Same shape as `@qmilab/lodestar-memory-firewall-mem0` — see that package's
README for the broader narrative around why imports cannot
self-promote. The only difference is the upstream schema (`blocks`
instead of `memories`).

## v0.2 scope

- `importMemories(raw, options)` validates a Letta export and produces
  one Claim + Evidence + Belief per block at `truth_status: unverified`
  / `retrieval_status: restricted`.
- `exportMemories()` and `syncMemories()` throw — design-stub level.

## Usage

```ts
import { LettaAdapter } from "@qmilab/lodestar-memory-firewall-letta"

const adapter = new LettaAdapter(firewall, evidenceStore)
await adapter.importMemories(
  {
    source: "letta",
    blocks: [
      { id: "b1", label: "human", value: "User prefers Python over JS." },
    ],
  },
  {
    scope: { level: "project", identifier: "my-project" },
    sensitivity: "internal",
    source_actor_id: "human-nandan",
    trust_baseline: 0.5,
  },
)
```
