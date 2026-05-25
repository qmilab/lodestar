# @qmilab/lodestar-memory-firewall

Lifecycle gates for claims and beliefs — four orthogonal axes (truth,
retrieval, security, freshness) with per-axis transition rules. Part of
[Lodestar](https://qmilab.com/lodestar) — the trust layer for AI agents.

The Memory Firewall is the gate between *"an agent extracted
something"* and *"the agent has adopted this as a belief it will act
on."* It is the answer to memory poisoning: agent-written memories
cannot promote themselves.

## Install

```sh
npm install @qmilab/lodestar-memory-firewall
# or
bun add @qmilab/lodestar-memory-firewall
```

## The four lifecycle axes

A belief moves independently on four axes. Promoting on one does not
promote on another.

| Axis | States |
| --- | --- |
| `truth_status` | `unverified` → `supported` → `contradicted` |
| `retrieval_status` | `normal` ↔ `restricted` ↔ `quarantined` |
| `security_status` | `clean` ↔ `quarantined` (one-way without explicit clearance) |
| `freshness_status` | `fresh` → `stale` → `expired` |

The orthogonality is deliberate. A belief can be `supported` but
`stale`, or `clean` but `unverified`, or `quarantined` but otherwise
truthful. Collapsing the axes into a single enum throws away the
information that makes informed retrieval possible.

## Usage

```ts
import {
  MemoryFirewall,
  GatedRetrieval,
  InMemoryClaimStore,
  InMemoryBeliefStore,
  InMemoryEvidenceStore,
} from "@qmilab/lodestar-memory-firewall"

const firewall = new MemoryFirewall({
  claims: new InMemoryClaimStore(),
  beliefs: new InMemoryBeliefStore(),
  evidence: new InMemoryEvidenceStore(),
})

await firewall.transitionClaim({
  claim_id: claim.id,
  axis: "truth_status",
  from: "unverified",
  to: "supported",
  authority: "user_confirmation",
  reason: "user confirmed in chat",
})

const retrieval = new GatedRetrieval(firewall)
const result = await retrieval.query({
  context_policy: policy,
  topic: "current branch",
})
```

## Invariants

1. **No self-promotion.** An agent's own success does not promote a
   belief from `unverified` to `supported`, or from `restricted` to
   `normal`. Promotion needs user confirmation, probe verification, or
   a narrow auto-promotion policy with logged evidence.
2. **Auto-observation gate.** `external_document` and
   `model_inference` evidence cannot promote a claim to
   `truth_status: supported` automatically — only human or
   verifier-grade evidence can.
3. **Quarantine is one-way.** A belief that enters
   `security_status: quarantined` does not return to `clean` without
   an explicit clearance event from an authorised actor.
4. **Retrieval respects ContextPolicy.** No retrieval path silently
   bypasses the policy.
5. **Every transition produces an Explanation.** No silent state
   mutation.

## License

[Apache 2.0](./LICENSE).
