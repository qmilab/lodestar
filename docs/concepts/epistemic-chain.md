---
title: "The epistemic chain"
description: "The eight-link chain — Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision — that Lodestar makes first-class so an agent's reasoning becomes auditable."
---

# The epistemic chain

A transcript tells you what an agent *said*. A diff tells you what *changed*.
Neither tells you what the agent **believed was true** when it acted, where that
belief came from, or whether it was ever verified. The epistemic chain is the
structure Lodestar uses to close that gap.

Every governed step an agent takes is recorded as a link in an eight-stage chain:

```
Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
```

Each link is a first-class, Zod-validated type in `@qmilab/lodestar-core`. Because
the links are typed and connected, "why did the agent do this?" stops being an
archaeology project and becomes a query.

## The eight links

### Observation
Raw input from the world — a tool returned a file's contents, a test run
produced output, a human said something. An observation carries its `source`
(which tool, which invocation), its `context` (session, project, actor), a
`trust` marker (`raw` / `validated` / `synthetic`), and a `sensitivity` level. It
is a record of *what arrived*, not yet of what it means.

### Claim
A proposition extracted from one or more observations — something the agent
*might* come to believe. "The `note.ts` module exports a `publish()` function."
A claim names its `source_observation_ids` and its `extraction_method` (`tool` /
`llm` / `human` / `import`). It is a candidate, not yet a commitment.

### EvidenceSet
The evidence weighed for a claim — a list of `EvidenceItem`s, each with a
`relation` (`supports` / `contradicts` / `contextualizes`), a `quality`
(`direct_observation`, `tool_result`, `human_assertion`, `model_inference`,
`external_document`, `synthetic_probe`), and a freshness marker. Quality is
load-bearing: low-quality evidence cannot do high-quality work. (See
[reading isn't believing](reading-isnt-believing.md).)

### Belief
A claim the agent has actually adopted, with a `confidence` score and a
`calibration_class`. A belief is not a boolean — it sits on
[four orthogonal lifecycle axes](memory-firewall.md): is it *true*, is it
*retrievable*, is it *secure*, is it *fresh*? A belief can be true but quarantined,
or confidently held but contradicted. Adoption is governed: a single apparent
success does not promote a belief on its own.

### Decision
A choice among options, recording the `belief_dependencies` it rested on. This is
the link that makes "the agent acted on a stale/poisoned belief" a *visible,
testable* fact rather than an invisible one — the decision points at exactly the
beliefs it used.

### Action
A proposed effect on the world, gated by an [action contract](trust-ladder.md):
its required trust level, blast radius, reversibility, scope, and preconditions.
Actions run through the Action Kernel's two-phase execution — proposed, arbitrated
by policy, then re-validated at execution time.

### Outcome
What actually happened when the action ran (or was refused) — captured as a typed
observation: stdout, exit code, duration, success or failure. The outcome can be
compared against what the decision expected.

### Revision
How the system updates itself afterward. When an outcome contradicts a belief, or
a contradiction surfaces later, the belief's lifecycle state changes — and the
revision records *why*. This is the link that turns a one-shot run into a system
that can learn the right lesson (and be checked for learning the wrong one).

## Why each link is separate

Collapsing any two of these links loses information that matters for trust:

- Separating **Observation** from **Claim** is what lets Lodestar say "the agent
  read this, but treated it only as a rumour" — the foundation of the
  [firewall](reading-isnt-believing.md).
- Separating **Claim** from **Belief** is where evidence gets weighed and the
  no-self-promotion rule lives.
- Separating **Decision** from **Belief** is what makes belief-dependencies
  explicit, so a poisoned belief that *didn't* steer the plan can be told apart
  from one that did.
- Separating **Action** from **Outcome** is what lets the system grade itself and
  [calibrate](sentinels-and-calibration.md) confidence against reality.

## The chain is the audit trail

The whole chain is persisted to an append-only NDJSON event log, with payload
hashes and monotonic sequence numbers, so it is tamper-evident and replayable.
[`lodestar report`](../reference/cli.md) projects a session's log back into a
human-readable trace of exactly this chain — which is the
[trust report](../guides/get-started.md#read-the-trust-report) you read at the end
of a run.

## See it

- [Get started](../guides/get-started.md) — run a coding agent through the chain
  and read the report.
- [The memory firewall](memory-firewall.md) — the four axes a belief lives on.
- [Reading isn't believing](reading-isnt-believing.md) — why an observation
  can't promote itself.
