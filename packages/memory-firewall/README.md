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
| `retrieval_status` | `normal` ↔ `restricted` ↔ `hidden` |
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

const claims = new InMemoryClaimStore()
const beliefs = new InMemoryBeliefStore()
const evidence = new InMemoryEvidenceStore()

const firewall = new MemoryFirewall(claims, beliefs, evidence, async (event) => {
  // route firewall audit events to your event log
})

// Promote one axis of an existing belief. The authority is what gives
// the firewall permission to make the transition; user_confirmation
// is one of the few authorities allowed to lift truth_status.
await firewall.transitionAxis({
  belief_id: belief.id,
  axis: "truth_status",
  to_value: "supported",
  by_authority: "user_confirmation",
  reason: "user confirmed in chat",
})

// Retrieval goes through the gate. It returns four buckets — what
// was accepted, what was rejected (and why), uncertainties surfaced
// per policy, and contradictions if the policy allows.
const retrieval = new GatedRetrieval(beliefs)
const result = await retrieval.retrieve(
  { scope: { level: "project", identifier: "my-project" } },
  contextPolicy,
)
// result.accepted, result.rejected, result.contradictions, result.uncertainties
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
5. **Every transition produces an audit event.** No silent state
   mutation — the audit sink passed to the constructor receives a
   structured event for every accepted claim, adopted belief, and
   axis transition.

## License

[Apache 2.0](./LICENSE).
