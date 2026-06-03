---
title: "The memory firewall"
description: "Four orthogonal lifecycle axes — truth, retrieval, security, freshness — plus the no-self-promotion rule and the context policy that gates what reaches the model."
---

# The memory firewall

Most memory systems describe a stored fact with one collapsed status: it's
"active" or it isn't. That single axis can't express the states that actually
matter for trust. A belief can be *true* but *secret*. It can be *confidently
held* but *contradicted by newer evidence*. It can be *clean* but *stale*. Collapse
those into one enum and you lose the very distinctions you need to govern memory
safely.

Lodestar's memory firewall describes every [belief](epistemic-chain.md) with
**four orthogonal lifecycle axes**, governs the transitions between their states,
and gates what is allowed to reach the model.

## The four axes

| Axis | States | Question it answers |
| --- | --- | --- |
| `truth_status` | `unverified` · `supported` · `contradicted` · `superseded` | Is it true? |
| `retrieval_status` | `hidden` · `restricted` · `normal` · `privileged_only` · `blocked` | May it be retrieved? |
| `security_status` | `clean` · `suspicious` · `quarantined` · `malicious` | Is it safe? |
| `freshness_status` | `fresh` · `stale` · `expired` | Is it current? |

They are deliberately independent. A poisoned belief can be set
`security_status: quarantined` **without** touching its `truth_status` —
quarantine blocks it from retrieval while preserving the full audit trail of why
the system once thought it was safe. A belief can go `truth_status: contradicted`
while staying `retrieval_status: normal`, so the contradiction surfaces in context
rather than vanishing. Separate axes mean separate, recorded decisions.

Each axis has its own transition table; a belief never jumps states silently. And
a fifth attribute, `sensitivity` (`public` / `internal` / `confidential` /
`secret`), travels alongside the axes — describing the *content* of a belief, not
its *state*. A belief can be true, fresh, clean, and supported, and still be
secret.

## No self-promotion

The load-bearing rule: **an agent's own success does not promote a memory.**

This is what defeats MemoryGraft-style attacks, where an adversary plants a
"successful experience" hoping the agent will later imitate it. Lodestar's firewall
does not move a candidate belief to `supported` from a single apparent success.
Promotion requires user confirmation, independent corroboration, probe
verification, or a narrow auto-promotion policy with logged evidence — never the
agent vouching for itself. It pairs directly with the
[auto-observation gate](reading-isnt-believing.md): content read from the outside
can't promote itself, and neither can the agent that read it.

The `guard-import-no-self-promote` probe pins this invariant.

## The context policy gates retrieval

Storing a belief safely is only half the job; the other half is governing what
reaches the model. The cognitive core consults a **`ContextPolicy`** every time it
assembles context — for claim extraction, planning, decisions, or explanations.
Its conservative v0 default:

- only `truth_status: supported` beliefs load,
- only `retrieval_status: normal` beliefs load,
- only `security_status: clean` beliefs load,
- a freshness ceiling (`P30D`) and a `sensitivity_ceiling` (`internal`) apply,
- contradictions and uncertainties are surfaced, not silently dropped,
- decisions are required to cite their belief dependencies.

A quarantined or suspicious belief therefore **cannot influence the planner** —
regardless of how high its stated confidence was when it was created. In LLM
systems, what enters context often matters more than what is stored; the context
policy makes "the planner used a stale belief" or "the explanation leaked a secret"
into testable invariants rather than invisible bugs. The
`quarantined-not-retrievable` and `sensitivity-ceiling` probes hold the line.

## Contradiction routing

When new evidence contradicts an existing belief, the contradiction must not just
disappear behind the retrieval filter. The firewall routes related contradicted
beliefs through a dedicated channel (`retrieveContradictions`) so the planner can
*see* the conflict rather than silently losing the losing side. Across a session,
a contradicted belief also flags the decisions that depended on it — the
`contradicted-belief-flags-dependent-decisions` probe checks that the cascade
reaches the right places.

## Plugs in front of your memory layer

The firewall is a horizontal component: it governs *which* beliefs are adopted,
retrieved, quarantined, or blocked — it does not replace your memory store.
Adapters exist for [mem0](https://github.com/mem0ai/mem0),
[Letta](https://github.com/letta-ai/letta), and [Zep](https://github.com/getzep/zep),
so a team can keep its existing memory layer and put a firewall in front of it.
State persists through in-memory **and** Postgres backends behind one interface,
so belief/claim/evidence state can be shared across sessions.

## Related

- [The epistemic chain](epistemic-chain.md) — where beliefs come from.
- [Reading isn't believing](reading-isnt-believing.md) — the auto-observation
  gate that pairs with no-self-promotion.
- [Threat model: memory poisoning](threat-model/memory-poisoning.md) — the attacks
  the firewall is designed against.
