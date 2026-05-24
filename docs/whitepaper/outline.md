# Whitepaper outline — "Lodestar: Epistemic Governance for Agentic Systems"

**Target venue**: arXiv preprint first, then adapted to one of: USENIX Security, AAAI Workshop on Safe and Responsible AI, ICML/NeurIPS Workshop on Agentic AI. The systems-paper framing also opens SOSP/OSDI but only with a stronger empirical evaluation than v0.2 will support.

**Target length**: ~25 pages (arXiv), reducible to ~12 pages for venue submission.

**Author**: Nandan, QMI Lab. Future co-authors as collaborators join.

**Status**: outline, ready for first-draft work after Batch 2 lands.

---

## Title and abstract

### Title

> **Lodestar: Epistemic Governance for Agentic Systems**

Alternates worth considering:
- "Epistemic Governance: An Architectural Primitive for Trustworthy AI Agents"
- "Beyond Observability: Governing Belief, Memory, and Action in Agentic Systems"

### Abstract (~250 words)

Structure:
1. **One-sentence problem statement.** Current agentic systems can record what an agent *did*, but not what it *believed* before doing it, why those beliefs were adopted, or whether they were verified.
2. **Three-sentence motivation.** Observability tools (LangSmith, Langfuse) capture LLM call traces but stop at the call boundary. Memory layers (mem0, Letta, Zep) persist information but have no principled answer to "what is safe to retrieve, promote, or trust." This gap is increasingly load-bearing as agents act on persistent state and as memory-poisoning attacks (MINJA, MemoryGraft) demonstrate concrete failure modes.
3. **Three-sentence contribution.** We present *epistemic governance* as an architectural primitive: a governance layer that treats claims, evidence, beliefs, decisions, actions, outcomes, and revisions as first-class artifacts. The architecture comprises (a) an Action Kernel with two-phase execution and precondition revalidation, (b) a Memory Firewall with four orthogonal lifecycle axes (truth, retrieval, security, freshness) and per-axis transition tables, (c) a Cognitive Core that walks the epistemic chain (Observation → Claim → Evidence → Belief), and (d) a Harness for probes, sentinels, and calibration. We instantiate the design in Lodestar, an open-source TypeScript implementation, and demonstrate that the no-self-promotion rule in the Memory Firewall defeats synthetic-experience injection attacks of the MemoryGraft class.
4. **Two-sentence framing of scope.** Lodestar is presented as a design contribution validated by working implementation and adversarial probes, not as an empirical study of agent failure rates. We argue that epistemic governance is a missing architectural category alongside observability, memory management, and runtime, and that its absence is increasingly difficult to defend.

---

## 1. Introduction (~3 pages)

### 1.1 The agent governance gap

Open with concrete failure: a coding agent confidently making the wrong change because a planted README convinced it the project's coding conventions required something specific. A web research agent citing fabricated sources because a memory was poisoned during a previous session. A customer-service agent revealing PII because a sentinel didn't exist to catch the data path.

Frame the underlying gap: agents can act, agents can remember, but no system today can answer "what did the agent *believe*, where did that belief come from, and whether it was verified."

### 1.2 What "trust" means in this paper

Define "trust" operationally as the ability to answer five questions about any agent action:

1. What did the agent believe was true when it acted?
2. Where did that belief come from?
3. What evidence supported it?
4. Was the belief verified, and to what confidence?
5. After the outcome, did the agent revise its belief correctly?

Argue that this is not the same as observability (which records calls), not the same as memory (which stores facts), not the same as policy enforcement (which gates actions). It is a separate category that must coexist with all three.

### 1.3 Contributions

Explicit list:

1. **The epistemic chain as architectural primitive.** A typed pipeline (Observation → Claim → Evidence → Belief → Decision → Action → Outcome → Revision) implemented as first-class artifacts rather than as inferred annotations on traces.

2. **The Memory Firewall.** A governance gate between extracted claims and adopted beliefs, with four orthogonal lifecycle axes and per-axis transition tables. Enforces the no-self-promotion rule that defeats MemoryGraft-class attacks.

3. **The Action Kernel with two-phase execution.** A pattern that separates action proposal from action execution, with precondition revalidation at execution time to defend against TOCTOU attacks.

4. **The Trust Ladder.** A six-level (L0–L5) framework for action authorization that integrates blast radius, reversibility, and data sensitivity into a single policy surface.

5. **A replay-grade audit log.** Append-only event log with monotonic sequence numbers, logical clocks, and payload hashes, sufficient for full reproducibility of an agent's epistemic state at any point in its history.

6. **Lodestar, an open-source implementation.** A working TypeScript implementation under Apache 2.0, with two passing adversarial probes (memory-poisoning resistance and full-chain integrity) and an end-to-end example producing an 11-event audit trail.

### 1.4 Roadmap of the paper

Standard "the rest of this paper is organized as follows" paragraph mapping to sections.

---

## 2. Background and related work (~3 pages)

### 2.1 Agent runtimes

Brief coverage of OpenClaw, Hermes (Nous Research), Claude Code, Cursor, LangGraph, CrewAI, Mastra. Their role and their explicit non-coverage of belief/evidence governance. Cite their docs and recent surveys.

### 2.2 LLM observability

Coverage of LangSmith, Langfuse, Phoenix, Braintrust, Datadog LLM Observability. They record LLM calls, prompt/completion pairs, latency, cost, structured evaluation results. They do not record beliefs or evidence. Cite each project's positioning and at least one academic treatment of LLM observability practices.

### 2.3 Agent memory systems

Coverage of mem0, Letta (formerly MemGPT), Zep, Cognee. They persist
information across sessions but lack a principled governance layer for
which memories should be promoted or retrieved. The gap is one of
continuity vs governance rather than a security claim about any
specific implementation.

(An earlier version of this outline cited a specific mem0 CVSS 8.1
vulnerability; the Round 5 review retracted that claim because the
source was secondary and the closest verifiable advisory was for a
different project. See `docs/architecture/v02-delta.md` Round 5
section for the retraction.)

### 2.4 Memory poisoning attacks

Detailed coverage of:

- **MINJA** (Memory Injection Attack via query-only manipulation) — Wang et al.
- **MemoryGraft** — single-shot indirect memory grafting via benign content
- **AgentPoison** — direct attacks on RAG knowledge bases under elevated access
- **Sleeper memory poisoning** — fabricated memories planted via external context

Treat these as the empirical motivation. Note the "under idealised conditions" qualifier on published attack rates.

### 2.5 Agent governance and policy enforcement

Microsoft Agent Governance Toolkit, MCP gateways, scanning tools. They focus on tool-level policy. They do not extend governance to memory or to beliefs.

### 2.6 Capability machines and provenance tracking

Brief connection to capability-based security (CHERI, the original capability machines from Lampson), provenance systems (PROV-O, OpenLineage), and immutable audit logs (Certificate Transparency, Sigstore). Position Lodestar as borrowing principles from these older traditions and applying them to agentic systems.

### 2.7 Calibration and uncertainty in LLMs

Brief coverage of work on LLM confidence calibration (ECE, Brier score, temperature scaling for LLMs), SMARTCAL, recent calibration evaluation methodologies. Position Lodestar's Calibrator as integration-level rather than a novel calibration algorithm.

---

## 3. The epistemic chain (~4 pages)

### 3.1 Overview

The chain as eight typed artifacts:

```
Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
```

Diagram showing the flow and the gate points (Memory Firewall sits between Claim and Belief; Action Kernel sits between Decision and Action; Cognitive Core walks the whole chain).

### 3.2 The artifacts

For each artifact, give:
- One-paragraph definition
- Key schema fields (no full Zod listing — that's an appendix)
- Lifecycle considerations
- Concrete example from the Telenotes scenario

Cover all eight in turn. Emphasize that each is *persisted*, *typed*, and *citable* — not annotations on traces but first-class records.

### 3.3 Why first-class artifacts

Argue that you can in principle reconstruct beliefs from traces post-hoc (and observability tools attempt this), but that doing so without first-class typed artifacts:
- Loses provenance (which trace step produced which belief?)
- Loses evidence linking (which earlier observations supported the belief?)
- Loses lifecycle (how did the belief transition from unverified to supported?)
- Loses replay-grade reconstruction (can you rebuild the agent's exact state at time T?)

This is a design argument, not an empirical one. The empirical demonstration that the architecture is implementable is in §10.

### 3.4 The ContextPolicy gate

How retrieval into the agent's context is bounded by an explicit policy declaring allowed truth statuses, retrieval statuses, security statuses, sensitivity ceilings, and contradiction/uncertainty inclusion.

The point: no implicit retrieval. Every belief that enters the model's prompt has cleared an explicit policy check, and the check itself is logged.

---

## 4. The Memory Firewall (~5 pages)

This is the paper's key technical contribution. Allocate the most space here.

### 4.1 The four orthogonal lifecycle axes

For each axis (truth_status, retrieval_status, security_status, freshness_status):
- The values it can take
- What transitions are allowed
- Which authorities can perform each transition
- Why this is independent of the other axes

Use a concrete example showing a belief moving along multiple axes (e.g., a belief that goes from `unverified → supported` on the truth axis, while simultaneously moving from `restricted → normal` on the retrieval axis, while remaining `clean` on the security axis and `fresh` on the freshness axis).

### 4.2 BeliefAuthority vs TransitionAuthority

Explain why these are different concepts and why conflating them caused bugs in earlier drafts.

- **BeliefAuthority** (provenance): observed / inferred / user_asserted / policy_asserted / imported / synthetic
- **TransitionAuthority** (runtime role): user / policy / probe / sentinel / reflection / auto_observation / system

Argue that the separation is necessary because a belief's *origin* and the *roles allowed to mutate* it are orthogonal properties.

### 4.3 The no-self-promotion rule

State the rule formally: an agent's own apparent success does not promote a belief from `unverified` to `supported`. Promotion requires explicit user confirmation, probe verification, or narrow auto-promotion under conditions that include a non-synthetic evidence requirement.

Walk through why this defeats MemoryGraft-class attacks:
- Attacker plants a "successful experience" in a memory the agent will retrieve
- The agent retrieves the memory, treats it as evidence for a related belief
- *Without* the rule: the belief gets promoted, the agent later acts on the poisoned belief
- *With* the rule: the synthetic provenance is detected, the belief is not promoted

Cite the architectural probe (in §10) that demonstrates the rule firing correctly.

### 4.4 The transition tables

Compact tabular presentation of the allowed transitions per axis. Probably:

| Axis | From | To | Authorities |
| --- | --- | --- | --- |
| truth | unverified | supported | user, probe, reflection, auto_observation |
| ... | ... | ... | ... |

Discuss notable asymmetries:
- Quarantined → clean requires user authority only (sentinels cannot un-quarantine)
- Unblocking requires user (not policy, not sentinel)
- Malicious is terminal

### 4.5 Evidence aggregation

The aggregateStrength function. How quality-weighted, freshness-weighted, independence-grouped evidence items combine into a scalar. Discuss why this is deliberately simple in v0.2 and how it can be replaced (it's an algorithm, not a schema commitment).

### 4.6 Gated retrieval

How retrieval into model context routes through the firewall. The ContextPolicy structure. The distinction between standard retrieval (planner uses) and privileged retrieval (sentinels and probes use). Why the planner has no path to bypass the policy.

### 4.7 Limitations

Honest section on what the firewall does NOT defend against:
- Direct prompt injection in the LLM call itself (Lodestar's scope ends at the tool boundary)
- Compromised tool implementations (the Action Kernel verifies output schemas but does not verify execution semantics)
- Adversarial users with elevated authority (user authority is trusted; if the user account is compromised, Lodestar cannot help)
- Side-channel attacks on the event log (the log assumes its append-only invariant is preserved by the substrate)

---

## 5. The Action Kernel (~3 pages)

### 5.1 Two-phase execution

`propose` → `arbitrate` → `execute`. Why three phases instead of two: arbitration is a separate phase because it produces a structured `PolicyDecision` artifact (not just a boolean) and the decision itself can be audited.

### 5.2 Precondition revalidation

The TOCTOU defense. Preconditions are evaluated at proposal time (cheap) and re-evaluated at execution time (cheap again, but against possibly-changed world state). If the world has changed in a way that invalidates a precondition between proposal and execution, the action fails before side effects.

### 5.3 Output schema verification

Every tool declares an `output_schema_key` referencing the registry. Tool outputs are validated against the schema before becoming Observations. This prevents an out-of-contract output from poisoning the rest of the chain.

### 5.4 The trust ladder L0–L5

Six levels:
- L0 — pure observation, no side effects
- L1 — local writes (filesystem only, no network)
- L2 — non-public actions affecting the agent's own scope only
- L3 — actions affecting shared but private resources (git branches, private databases)
- L4 — actions affecting external resources (PRs, deployments, messages to outside parties) — default for actions touching external systems
- L5 — irreversible high-impact actions (production deploys, deletions, financial transactions)

Default policy: higher levels require explicit approval. The level is declared in the action contract, not inferred.

### 5.5 Why blast radius and reversibility are orthogonal

Show why a single L0–L5 number is insufficient and the ActionContract carries explicit `blast_radius` and `reversibility` fields. Some actions are local but irreversible; some are external but cheap to undo. The trust ladder summarizes; the contract is the source of truth.

---

## 6. The Cognitive Core (~3 pages)

### 6.1 Extractors

How observations become claims. Schema-bound extractors (deterministic) vs generic LLM-driven extractors (fallback). Why schema-bound is preferred where available.

### 6.2 Evidence linker

How a new claim's EvidenceSet is constructed: from the source observation, from prior beliefs whose subject matches, from related claims in the same scope. The v0.2 implementation is intentionally simple; v0.3 adds LLM-driven evidence discovery.

### 6.3 The World Model

A typed, versioned, scoped key-value store separate from beliefs. Beliefs are *about* world state; the world model *is* the current observed state. Versions are kept (last N) so contradictions can be diagnosed.

### 6.4 The orchestrator

How an Observation walks the chain end-to-end: extract → submit claims → link evidence → adopt beliefs (where evidence is strong enough) → update world model. The orchestrator does not make decisions; that's the planner's job.

### 6.5 Reflection

A scheduled or on-demand pass that produces proposals (claim status changes, belief promotions, skill registrations, policy revisions). Critical invariant: reflection NEVER auto-commits. It produces proposals; the Memory Firewall is the only commit path.

---

## 7. The Harness (~3 pages)

### 7.1 Probes

Deterministic adversarial tests. Each probe constructs an attack scenario and verifies the architecture's response.

Cover the two implemented probes in detail:
- **Memory poisoning basic** — synthetic-probe evidence is rejected
- **Epistemic chain smoke** — full chain runs end-to-end

Outline the additional probes planned in Batch 3:
- Prompt-injection probe
- Tool-poisoning probe
- Confidence-drift probe

### 7.2 Sentinels

Runtime monitors. Each sentinel watches the firewall's transition stream or the action kernel's output stream and raises Incidents when patterns match.

Outline planned sentinels:
- Low-confidence action sentinel
- Suspicious memory-origin sentinel
- Anomalous tool sequence sentinel

### 7.3 Calibrators

Confidence-vs-outcome measurement. The Calibrator consumes the event log, groups beliefs by `calibration_class`, and computes per-class ECE/Brier scores.

Position this carefully: Lodestar is not contributing a novel calibration *algorithm*. It is providing the *infrastructure* for calibration to happen continuously and at the right granularity (per-claim-class, per-scope, per-source).

### 7.4 The probe pack format

How probes are packaged and shared. The `lodestar.probe-pack.json` manifest. Why this is the marketplace surface (see §11).

---

## 8. Threat model (~3 pages)

### 8.1 Attack classes covered

For each, give: attacker capabilities, attack mechanism, Lodestar's defense, residual risk.

- MINJA (query-only memory injection)
- MemoryGraft (indirect memory grafting)
- Sleeper memory poisoning
- AgentPoison (direct RAG knowledge base attacks)
- Tool poisoning (compromised MCP server)
- Skill provenance attacks (unsigned skill execution)
- TOCTOU on action preconditions

### 8.2 Attack classes NOT covered

Honest section. Lodestar does not defend against:
- LLM-internal prompt injection
- Adversarial users with legitimate authority
- Substrate compromises (the event log assumes append-only)
- Side-channel attacks
- Model jailbreaks at the inference layer

### 8.3 The threat model boundary

Clarify what Lodestar treats as trusted: the substrate, the event log writer, the user account, the schemas. What Lodestar treats as adversarial: tool outputs, retrieved memories, external content, downstream agents.

---

## 9. Calibration framework (~2 pages)

### 9.1 Per-class calibration

Beliefs carry a `calibration_class` field. Calibrators group by class. This is finer-grained than global calibration: a model may be well-calibrated on "current branch is X" claims and poorly calibrated on "the bug is in module Y" claims, and the framework surfaces that difference.

### 9.2 Continuous calibration

The framework runs continuously over the event log, not as a one-time evaluation. As outcomes accumulate, calibration estimates improve. Drift is visible.

### 9.3 The minimum viable calibrator

For v0.2, the calibrator is described but not yet running with real data. Outline what the minimum viable calibrator produces (per-class confidence histogram, ECE estimate, sample count, last-updated timestamp).

### 9.4 What this paper does not claim

Explicit: this is integration-level work. We are not proposing a new calibration algorithm. We are claiming that *making calibration a first-class part of the architecture* (with the right granularity) is the contribution.

---

## 10. Implementation and validation (~3 pages)

### 10.1 Lodestar

The open-source TypeScript implementation. Bun runtime. Strict TypeScript with `noUncheckedIndexedAccess`. Apache 2.0. Currently at pre-v0.1 / week-2 scaffold.

### 10.2 Architecture as code

The repository structure mirrors the architecture. Each architectural component is a separate package. Schemas in `@qmilab/lodestar-core`, event log in `@qmilab/lodestar-event-log`, action kernel in `@qmilab/lodestar-action-kernel`, memory firewall in `@qmilab/lodestar-memory-firewall`, cognitive core in `@qmilab/lodestar-cognitive-core`. Adapters in `@qmilab/lodestar-adapter-*`.

### 10.3 The two passing probes

Report results from running both probes:

```
probe: memory_poisoning_basic — PASS
  Firewall correctly rejected adoption from synthetic_probe-only evidence.

probe: epistemic_chain_smoke — PASS
  3 claims extracted, 3 beliefs adopted, 3 world model keys updated
  from a single git.status observation.
```

Discuss what passing each probe demonstrates and what it does not.

### 10.4 The Telenotes example

End-to-end trace of an action proposal walking through the epistemic chain. 11-event audit trail. Show the actual event sequence with seq numbers and logical clocks.

### 10.5 Performance considerations

Brief. Memory-resident stores in v0.2. Postgres-backed stores in v0.3 with pgvector for retrieval. Expected per-action overhead estimates.

### 10.6 What v0.2 does not yet demonstrate

Honest:
- No live LLM-driven extractor (the v0.2 probes use schema-bound extractors only)
- No production-scale event log volume
- No multi-session continuity tests
- No real attack-replay against a deployed agent
- Calibrator infrastructure exists but has no accumulated data

These are roadmapped (see §11) but not present in v0.2.

---

## 11. Discussion and limitations (~2 pages)

### 11.1 What we believe is contributed

Restate the contributions in §1.3 with the benefit of the technical sections having been read. The argument is now: the four orthogonal lifecycle axes, the no-self-promotion rule, the trust ladder, the replay-grade event log, and the integrative claim that these belong together as a *governance architecture* — none of which is fully present in existing tools.

### 11.2 What we explicitly do not claim

- That Lodestar is the only viable design
- That the four axes are the only correct decomposition
- That the trust ladder values L0–L5 are universal (they encode an opinion about what "blast radius" means)
- That the architecture defends against attacks beyond the threat model in §8

### 11.3 Limitations of the design

- Schema-bound extractors don't scale to all observation types; LLM-driven extractors will be needed and will introduce new failure modes
- The Memory Firewall adds latency to every belief adoption; the cost-benefit at high agent throughput needs measurement
- The trust ladder assumes a global policy; multi-tenant deployments will need scoped policies
- The replay-grade log assumes single-actor sequencing per partition; distributed agents need additional protocol

### 11.4 Limitations of the evaluation

- v0.2 evaluation is by adversarial probes against the architecture, not by deployment metrics
- The MemoryGraft defense is demonstrated against synthetic attacks, not against real attack research against deployed Lodestar instances
- Calibration is designed but not yet measured

### 11.5 Future work

Map to the roadmap in `docs/roadmap.md`:
- Batch 3: full Harness infrastructure
- Batch 4: MCP proxy mode for wrapping existing agents
- Batch 5: end-to-end thesis demo with a real coding agent
- Beyond: hosted operation, multi-tenant deployments, signed skill manifests, formal threat model verification

---

## 12. Conclusion (~1 page)

Restate the gap. Restate the contribution. Argue that epistemic governance is a missing architectural category whose absence is increasingly difficult to defend as agents take on consequential roles. Invite the community to challenge the architecture, fork the implementation, and extend the probe pack.

---

## Appendices

### A. Full schema definitions

The Zod schemas in `@qmilab/lodestar-core` reproduced with comments. ~3 pages.

### B. The transition tables in full

The complete per-axis transition tables. ~1 page.

### C. The probe pack format specification

The structure of `lodestar.probe-pack.json`. ~1 page.

### D. Reproducing the results

Step-by-step instructions to reproduce both probes and the Telenotes example on a clean checkout. ~1 page.

---

## Writing notes

Some things to do well when drafting:

**Voice**: rigorous, evidentiary, slightly understated. Closer to a CHERI paper than a NeurIPS submission. No oversold claims; lots of honest qualifications.

**Citations**: aim for ~40–60 references. Cover MINJA / MemoryGraft / AgentPoison / sleeper attacks for empirical motivation. Cover LangSmith / Langfuse / Phoenix / mem0 / Letta / Zep for related work positioning. Cover CHERI / PROV-O / Sigstore / Certificate Transparency for design lineage. Cover ECE / Brier / SMARTCAL for calibration background.

**Diagrams**: probably 5–7 diagrams.
1. The epistemic chain (Observation → Claim → ... → Revision)
2. The four orthogonal lifecycle axes
3. The Memory Firewall as gate between Claim and Belief
4. The Action Kernel two-phase execution
5. The Trust Ladder L0–L5 with examples
6. The Harness layout (probes / sentinels / calibrators)
7. The full architecture: Action Kernel + Cognitive Core + Memory Firewall + Harness

**What NOT to claim**: novel calibration algorithm, novel attack defense beyond what the architecture mechanically demonstrates, generality beyond what the v0.2 implementation supports. Save bigger claims for later versions backed by deployment evidence.

**When to write**: after Batch 2 lands (the package surfaces should be stable before the paper commits to the surfaces it describes). Could start outline expansion now in parallel with Batch 2 implementation.

**Co-authors**: solo for v0.2 draft. As collaborators join QMI Lab and Lodestar's user base grows, they earn co-author slots through specific technical contributions (a new probe pack, a substantial adapter, a deployment study).
