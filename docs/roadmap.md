# Orrery — Roadmap

This roadmap defines the sequence from the current pre-v0.1 scaffold to a v1 release that supports the headline use case ("wrap a coding agent and get a trust report"). It complements `docs/positioning.md`.

Last updated: post-strategy review with ChatGPT.

---

## Where we are

The current scaffold passes a typecheck under strict TypeScript and runs six probes end-to-end. The architecture is settled — what follows is implementation work, not redesign.

Concrete state:
- Schema layer for the full epistemic chain
- Append-only NDJSON event log with monotonic sequencing and payload hashes
- Two-phase action execution with precondition revalidation
- Memory firewall with four orthogonal lifecycle axes and per-axis transition tables
- Cognitive core: extractors, evidence linker, world model, ingestion orchestrator
- Six passing probes:
  - memory poisoning resistance
  - epistemic chain smoke test
  - external document not normal-retrievable
  - quarantined belief not retrievable
  - sensitivity ceiling blocks secret belief
  - auto-observation evidence-quality gate
- End-to-end example producing an 11-event audit trail

---

## Five batches to v1

The work is partitioned into five batches. Each batch is scoped to land cleanly, with the next batch building on it.

### Batch 1 — Positioning (current)

**Goal**: lock the public-facing language and roadmap before any further code is written.

**Deliverables**:
- New `README.md` in trust-layer voice (done)
- `docs/positioning.md` with the four-surface framing and open-core strategy (done)
- `docs/roadmap.md` — this document
- Update to `docs/architecture/v02-delta.md` noting the positioning shift
- ChatGPT review prompt for the strategy

**Out of scope**: any code changes.

**Status**: in progress.

### Batch 2 — Package boundary cleanup

**Goal**: expose the existing code through the four developer-facing surfaces (Guard, Trace, Memory Firewall adapters). Mostly re-exports and thin adapters.

**Deliverables**:
- `packages/guard/` — meta-package that re-exports the developer-facing API from action-kernel + event-log + cognitive-core, with a `guard.wrap()` helper
- `packages/trace/` — package with `orrery report <session-id>` CLI command that consumes the event log and produces markdown/HTML trust reports
- `packages/memory-firewall/adapters/mem0/` — adapter for mem0 (design stub + minimal implementation)
- `packages/memory-firewall/adapters/letta/` — adapter for Letta (design stub)
- `packages/memory-firewall/adapters/zep/` — adapter for Zep (design stub)
- Reorganized CLI: `orrery report` is the headline command (consumes the event log and renders a trust report). Niche commands live under area prefixes: `orrery guard <subcommand>`, `orrery harness <subcommand>`, `orrery action <subcommand>`. The `orrery trace` namespace is deprecated; the package keeps the name `@orrery/trace` but exposes commands under `orrery report` (the primary user-facing one) and `orrery trace inspect` (for internal/debug use).
- New `examples/coding-agent-greenfield/` — minimal example showing `guard.wrap()` on a homegrown agent

**Out of scope**: Harness infrastructure (that's Batch 3), MCP wrapper (Batch 4), real memory-layer integrations beyond stubs (later).

**Effort**: ~1 week of focused work. Most of this is re-export and packaging.

### Batch 3 — Thin MCP proxy vertical slice

**Goal**: the headline use case. Wrap an existing coding agent (Claude Code, Cursor, Aider, any MCP client) without requiring it to be rewritten on top of Orrery. Get to `orrery guard mcp-proxy --target ... && claude code ... && orrery report latest` as quickly as possible.

This batch moves *before* the full Harness because the public promise is "wrap your coding agent." Until that path works, time spent perfecting internal machinery is time the project's adoption story is hypothetical.

**Deliverables**:
- `packages/guard-mcp/` package implementing an MCP proxy server
- Every tool call from the client passes through the Action Kernel; outputs go through the Cognitive Core
- The proxy advertises the same tools as the underlying MCP server but adds policy and audit
- `orrery guard mcp-proxy --target <url> --policy <policy.ts>` CLI command
- Event log single-writer enforcement (file lock or single-process invariant — must land before MCP because the proxy introduces concurrency)
- Kernel context fix: real `session_id`/`project_id` propagation from the proxy into observations (currently stubbed)
- Worked example: Claude Code talking to a filesystem MCP server proxied by Orrery, producing a trace report
- Integration guide for one MCP client (Claude Code first; Cursor/Aider follow in Batch 5 prep)

**Minimum-viable safety scaffolding (must ship with this batch)**:
- A minimal probe runner that runs the four new firewall probes (see "Memory Firewall invariants to add" below) before the proxy goes live
- Documentation noting which threat-model attack classes the v0.2 proxy covers and which it does not

**Out of scope**: full Harness infrastructure (Batch 4), non-MCP runtimes, multi-tenant policy scoping.

**Effort**: ~2 weeks. Modelling MCP's transport and tool-discovery protocol correctly is most of the work.

### Batch 4 — Harness infrastructure

**Goal**: turn the probe scripts and the minimum-viable probe runner from Batch 3 into a real harness with probes, sentinels, and calibrators that can be packaged and shared.

**Deliverables**:
- `packages/harness/` package with:
  - `Probe` base class and execution runner (formalized from Batch 3's minimum-viable runner)
  - `Sentinel` base class with hooks into the firewall transition stream
  - `Calibrator` that consumes the event log and produces per-class accuracy tables (ECE, Brier score)
  - Probe pack format (`orrery.probe-pack.json` manifest + probe files)
  - `orrery harness run --pack <name>` CLI command
- Repackage existing probes into the new format
- Three additional probes:
  - Prompt-injection probe (observation contains injected instructions)
  - Tool-poisoning probe (MCP server returns adversarial output)
  - Confidence-drift probe (belief confidence diverges from outcome over time)
- Two additional firewall invariants deferred from earlier batches:
  - **Reflection cannot promote to normal retrieval alone** (requires reflection pass to exist; lands here)
  - **Contradicted belief flags dependent decisions** (requires Decision dependency pipeline; lands here)
- Three sentinels:
  - Low-confidence action sentinel
  - Suspicious memory-origin sentinel
  - Anomalous tool sequence sentinel
- First in-repo probe pack: `packs/coding-agent-safety/`

**Out of scope**: public registry (v1+), signed manifests (v1.5+).

**Effort**: ~1.5 weeks.

### Batch 5 — Week-8 thesis demo + second proving ground

**Goal**: a complete worked example demonstrating that Orrery's value proposition holds end-to-end. Telenotes is the first proving ground; a documentation-agent example is the second, lower-cost proving ground that exercises claim/evidence beyond schema-bound extractors.

**Deliverables**:

*Primary proving ground (Telenotes)*:
- A coding agent (Claude Code, wrapped via the MCP proxy from Batch 3) is asked to add a feature to Telenotes
- The agent observes the codebase, forms beliefs about the existing architecture, makes a plan, edits files, runs tests, commits
- Orrery records the full epistemic chain
- At the end, `orrery report` produces a structured markdown report explaining:
  - What the agent observed
  - What claims it extracted from those observations
  - Which beliefs it adopted and at what confidence
  - Which beliefs informed the action plan
  - Which actions executed, with what outcomes
  - What revisions (if any) followed the outcomes
- A second run with a memory-poisoning probe active demonstrates the firewall blocking the attack

*Secondary proving ground (documentation agent)*:
- A small agent reads `README.md`, `package.json`, and existing docs
- The agent updates a docstring or README section based on what it read
- Orrery records claims (e.g., "this function takes parameter X") with evidence linked to the source files
- `orrery report` shows which source supported each documentation claim
- This validates the claim/evidence chain beyond `git.status` and code editing, with very low engineering cost

- Blog post / video walkthrough of both demos (publishable artifact)

**Out of scope**: hosted dashboard, team workflows, customer-support or data-analysis examples (deferred to v1.x).

**Effort**: ~1 week assuming Batches 2–4 land cleanly.

---

## Memory Firewall invariants to add (Batch 2 work + new probes)

ChatGPT's review of the v0.2 scaffold identified that the current memory-poisoning probe is necessary but not sufficient. The firewall enforces one critical invariant (synthetic-probe-only evidence cannot adopt a real belief). Several more must be verified before the MCP proxy goes live, because the proxy will expose the firewall to a much wider range of inputs.

**Probes to add in Batch 2** (use the current scaffold, no new infrastructure):

1. **External-document evidence cannot directly adopt at `retrieval_status: normal`.** A claim sourced from README/email/webpage enters at `restricted` or `hidden`. Verified by constructing an evidence set with `external_document` items and asserting the firewall does not allow `normal` retrieval status.

2. **Quarantined belief cannot be retrieved by the standard planner path.** Construct a belief, transition it through `quarantine`, query through `GatedRetrieval`. Verify it does not surface even if `truth_status: supported` and `freshness_status: fresh`.

3. **Sensitivity ceiling blocks `secret` beliefs from default context.** Default `ContextPolicy.sensitivity_ceiling` is `internal`. A belief tagged `sensitivity: secret` must not appear under that ceiling. Verify by storing both and querying.

4. **`auto_observation` authority cannot promote `external_document` or `model_inference` evidence.** Currently the cognitive core allows `auto_observation` based on evidence strength alone. The fix: if any of the highest-quality evidence items in a set are `external_document` or `model_inference`, downgrade the transition authority to `reflection` (which cannot silently promote to `supported`).

**Probes deferred to Batch 4** (need infrastructure that doesn't yet exist):

5. **Reflection cannot promote to `normal` retrieval alone.** Requires the reflection pass to exist (Batch 4).
6. **Contradicted belief flags dependent decisions.** Requires the Decision pipeline to track and propagate dependencies (partial in Batch 3, full in Batch 4).

**Code fixes to land alongside these probes**:

- **ContextPolicy contradiction routing**: currently `allowed_truth_statuses` defaults to `["supported"]`, so contradicted beliefs are filtered out before the `include_contradictions: true` surface can return them. Fix: add a separate `retrieveContradictions(query, policy)` method that returns beliefs with `truth_status: contradicted` related to the same subject as the standard retrieval candidates. The planner gets a "related contradictions" channel, not arbitrary contradicted beliefs in main context.
- **Kernel context propagation**: the current `ActionKernel` uses `session_id: "session-stub"` and `project_id: "project-stub"` defaults. These must accept real values from the host before the MCP proxy ships, otherwise the event log cannot reliably tie actions, observations, claims, and beliefs to the same session.
- **Event log single-writer enforcement**: the current writer is process-local. Before the MCP proxy goes live in Batch 3, add either a file lock or a single-process invariant. Two proxied tool calls can otherwise race and produce duplicate sequence numbers.

These fixes are scoped tightly. Most can land in a single focused session in Batch 2 before any of the larger Guard/Trace package work begins.

---

## Total timeline

Roughly 6 weeks of focused work from Batch 1 to Batch 5, assuming uninterrupted execution. Batches 2–5 are the natural handoff point to Claude Code for autonomous execution; Batch 1 (this document and its siblings) is the necessary human work before that handoff.

---

## What this roadmap explicitly does not include

These are real items, but they belong later than v1:

- **Public marketplace registry** — v1.5+. Requires signing infrastructure.
- **Hosted dashboard** — v2. Requires team workflow design.
- **Compliance exports** (SOC 2, GDPR DSR) — v2+. Requires legal review.
- **Non-MCP runtime adapters** (Hermes, OpenClaw, LangGraph, CrewAI) — v1.5+. Each adapter is its own work item; do not block v1.
- **Advanced replay UI** — v2.
- **Quantum world-model integration** — separate research arc under QMI Lab Pillar III. Not Orrery's path.

---

## Research arc (parallel)

Independent of the implementation roadmap, the research outputs from Orrery flow into QMI Lab's publication pipeline. Most of these are *outlines* in 2026, not papers — empirical claims need accumulated session data and failure analysis before they go to publication. The exception is the position paper, which is design contribution and can be drafted ahead of large-scale empirical work.

**Reasonable to draft now (outline + position-paper voice)**:

1. **Position paper: epistemic governance as an architectural primitive** — full draft achievable in 2026 once Batch 3 lands. This is design contribution, not empirical evaluation.
2. **Memory-poisoning threat taxonomy** — design note + structured taxonomy. Publishable as a workshop paper without large empirical claims.
3. **Probe taxonomy and methodology notes** — short methods paper describing the probe pack format and the criteria for a "good" probe.

**Premature in 2026, target 2027+**:

4. **Empirical memory-poisoning paper** — needs deployed Orrery instances and real attack traces. Not before late 2027.
5. **Calibration framework for agent beliefs** — needs accumulated session data showing calibration before-and-after. Not before mid-2027.
6. **Evaluation methodology for trust-aware agent systems** — needs comparison baselines and benchmark workloads that don't exist yet. Not before late 2027.

Each paper draws on Orrery's implementation but does not block it. The implementation roadmap and the research arc are coupled but independent. The right discipline: outline now, publish only when the data is there.
