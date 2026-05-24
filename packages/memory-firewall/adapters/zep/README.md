# @qmilab/lodestar-memory-firewall-zep

Adapter that imports facts from [Zep](https://github.com/getzep/zep)
into the Orrery memory firewall.

Same shape as the mem0 and Letta adapters — see
`@qmilab/lodestar-memory-firewall-mem0` for the broader narrative. The
difference here is that v0.2 imports Zep *facts* (the higher-order
summary structure) rather than raw message histories; per-message
import is deferred until claim-extraction strategies exist for
free-form conversation.

## v0.2 scope

- `importMemories(raw, options)` validates a Zep `facts` export and
  produces one Claim + Evidence + Belief per fact at
  `unverified/restricted`.
- `exportMemories()` and `syncMemories()` throw.

## Usage

```ts
import { ZepAdapter } from "@qmilab/lodestar-memory-firewall-zep"

const adapter = new ZepAdapter(firewall, evidenceStore)
await adapter.importMemories(
  {
    source: "zep",
    facts: [
      {
        uuid: "f1",
        fact: "User is migrating from JS to Rust.",
        session_id: "s1",
        rating: 0.8,
      },
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

## Notes

- Zep's own `rating` field is recorded in the evidence notes but does
  not influence the firewall's lifecycle gates. Auto-promoting based
  on an upstream rating would defeat the no-self-promotion rule.
