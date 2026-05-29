# Lodestar — Roadmap

This roadmap defines the sequence from the current pre-v0.1 scaffold to a v1 release that supports the headline use case ("wrap a coding agent and get a trust report"). It complements `docs/positioning.md`.

Last updated: post-strategy review with ChatGPT.

---

## Where we are

The current scaffold passes a typecheck under strict TypeScript and runs seventeen probes end-to-end. v0.1.5 of the 13 pre-Batch-3 packages is on npm via CI trusted publishing; `@qmilab/lodestar-guard-mcp` ships with Batch 3 in this repository and will be published in a separate mini-marathon after the code stabilises. The architecture is settled — what follows is implementation work, not redesign.

Concrete state:
- Schema layer for the full epistemic chain
- Append-only NDJSON event log with monotonic sequencing, payload hashes, and per-partition append serialization
- Two-phase action execution with precondition revalidation; required `KernelContext` (no silent stub fallback)
- Memory firewall with four orthogonal lifecycle axes, per-axis transition tables, and subject-related contradiction routing
- Cognitive core: extractors, evidence linker, world model, ingestion orchestrator, Round 5 auto-observation gate
- **MCP proxy (Batch 3): `lodestar guard mcp-proxy --config <path>`** — wraps any MCP-speaking agent (Claude Code, Cursor, Aider) so its tool calls flow through the Action Kernel and its tool results through the Cognitive Core, with `mcp.tool_result@1` observations carrying separate `tool_result`-quality envelope claims and `external_document`-quality content claims
- Fourteen passing probes:
  - memory poisoning resistance
  - epistemic chain smoke test
  - external document not normal-retrievable
  - quarantined belief not retrievable
  - sensitivity ceiling blocks secret belief
  - auto-observation evidence-quality gate (Parallax principle)
  - guard import no-self-promote
  - guard precondition revalidation
  - guard contract invariants (22 sub-cases A–V)
  - context policy contradiction routing (subject-relation join, collision-free keys, gate symmetry)
  - kernel context propagation (real session/project flow through to event log)
  - event log single-writer (per-partition mutex, no torn writes under fan-out)
  - mcp-proxy-roundtrip (tool call through the proxy produces the right epistemic chain entries, with real session/project IDs)
  - mcp-proxy-injection-defense (hostile content in a tool result is recorded verbatim but does NOT promote to a supported belief — the headline Batch 3 demonstration)
- End-to-end examples: telenotes-governed-dev (full pipeline, 11-event audit), doc-insight (auto-observation gate), coding-agent-greenfield (`guard.wrap()` on a homegrown loop), claude-code-wrapped (MCP proxy wrapping a stand-in agent against a real filesystem MCP server)

---

## Five batches to v1

The work is partitioned into five batches. Each batch is scoped to land cleanly, with the next batch building on it.

### Batch 1 — Positioning

**Goal**: lock the public-facing language and roadmap before any further code is written.

**Deliverables**:
- New `README.md` in trust-layer voice (done)
- `docs/positioning.md` with the four-surface framing and open-core strategy (done)
- `docs/roadmap.md` — this document
- Update to `docs/architecture/v02-delta.md` noting the positioning shift
- ChatGPT review prompt for the strategy

**Out of scope**: any code changes.

**Status**: done.

### Batch 2 — Package boundary cleanup

**Status**: done.

**Goal**: expose the existing code through the four developer-facing surfaces (Guard, Trace, Memory Firewall adapters). Mostly re-exports and thin adapters.

**Deliverables** (all landed):
- ✅ `packages/guard/` — meta-package re-exporting action-kernel + event-log + cognitive-core + memory-firewall, with `wrap()` / `runGuarded()` helpers and minimal `autoApprovePolicy` / `alwaysHoldsChecker` presets
- ✅ `packages/trace/` — read side of the event log; `lodestar report <session-id>` renders a markdown trust report enriched with the full epistemic chain
- ✅ `packages/memory-firewall/adapters/mem0/` — adapter for mem0 (stub-level: `importMemories` implemented, other methods throw with TODO)
- ✅ `packages/memory-firewall/adapters/letta/` — adapter for Letta (same shape)
- ✅ `packages/memory-firewall/adapters/zep/` — adapter for Zep (same shape)
- ✅ Reorganised CLI: `lodestar report` is the headline command; niche commands under `guard`, `action`, `trace`, `probe` prefixes
- ✅ `examples/coding-agent-greenfield/` — `guard.wrap()` applied to a homegrown agent loop, producing a useful trust report
- ✅ New probe `packs/lodestar-core/probes/guard-import-no-self-promote.ts` — enforces that adapter-imported memories cannot land at `truth_status: supported`

**Out of scope**: Harness infrastructure (that's Batch 4), MCP wrapper (Batch 3), real memory-layer integrations beyond stubs (later).

**Effort**: ~1 week of focused work. Most of this was re-export and packaging.

### Batch 3 — Thin MCP proxy vertical slice

**Status**: done.

**Goal**: the headline use case. Wrap an existing coding agent (Claude Code, Cursor, Aider, any MCP client) without requiring it to be rewritten on top of Lodestar. Get to `lodestar guard mcp-proxy --config ... && claude code ... && lodestar report latest` as quickly as possible.

This batch moved *before* the full Harness because the public promise is "wrap your coding agent." Until that path works, time spent perfecting internal machinery would have left the adoption story hypothetical.

**Deliverables** (all landed):
- ✅ `packages/guard-mcp/` — MCP proxy package. Stdio transport on the upstream face; spawns downstream MCP servers as child processes via `@modelcontextprotocol/sdk`'s `StdioClientTransport`. Mirrors the union of downstream tool catalogs upstream under namespaced names `mcp.<server>.<tool>`.
- ✅ Every inbound `tools/call` from the wrapped agent becomes a Lodestar Action: `propose → arbitrate → execute`. Outputs flow through the Cognitive Core. Round 5 invariants hold — real session/project IDs, no stub fallback, per-partition append serialization.
- ✅ `lodestar guard mcp-proxy --config <path>` CLI subcommand. Zod-validated config; conservative defaults (irreversible, controlled-shell, L3 trust) for any tool the operator did not enumerate in `tool_defaults`. MCP `annotations` deliberately ignored as a trust source (per spec, they're untrusted unless from a trusted server).
- ✅ Synthetic `policy_denied` `CallToolResult` on policy block. The wrapped agent reads it as a normal tool response and can revise — far better UX than an MCP-level error that most agents treat as a fatal transport abort.
- ✅ `mcp.tool_result@1` observation schema + `MCPToolResultExtractor` + `MCPAwareEvidenceLinker`. Envelope claim ("tool X was called") gets `tool_result` evidence quality; per-text-block content claims get `external_document` quality. The auto-observation gate then keeps the content claims at `truth_status: unverified`.
- ✅ `examples/claude-code-wrapped/` — stand-in MCP agent drives the proxy in-process against a real subprocess `@modelcontextprotocol/server-filesystem` downstream. Reads three files including a deliberately prompt-injected `notes.md`. Produces a complete trust report.
- ✅ Two new probes:
  - `mcp-proxy-roundtrip` — round-trip a tool call through the proxy, assert real session/project IDs propagate end-to-end, assert the chain `proposed → approved → completed`, assert at least one envelope claim is adopted at `truth_status: supported`.
  - `mcp-proxy-injection-defense` — drive a poisoned-file CallToolResult through the proxy and assert: (a) the hostile text is preserved verbatim in the observation payload (audit), (b) the envelope claim adopts at `supported` (tool_result quality is trustworthy), (c) the content claim does NOT adopt at `supported` (`external_document` quality, gate fires), (d) the evidence set carries an `external_document` quality item so the firewall has the signal it needs.
- ✅ Threat-model documentation in `docs/architecture/v02-delta.md` ("Batch 3 — MCP proxy threat model"): what the v0 proxy covers, what's deferred, operator guidance.

**Out of scope** (and remained so): full Harness infrastructure (Batch 4), non-MCP runtimes, multi-tenant policy scoping, HTTP transport for the upstream face, OS-level sandbox enforcement, publishing `@qmilab/lodestar-guard-mcp` to npm (deferred to a mini-marathon after Batch 3 stabilises).

**Probe count after Batch 3**: 14 (was 12; up by `mcp-proxy-roundtrip` + `mcp-proxy-injection-defense`).

### Batch 4 — Harness infrastructure

**Status**: in progress (reflection pass, probe-pack format + loader, and probe repackaging have landed; runner, sentinels, calibrator, and the three new probes are still ahead).

**Goal**: turn the probe scripts into a real harness with probes, sentinels, and calibrators that can be packaged and shared. This is what the `Lodestar Harness` developer entry point needs to graduate from loose TS files in `research/probes/` to an installable surface external packs can plug into.

**Deliverables**:

*Harness package* — `packages/harness/`:
- `Probe` base class and execution runner. Each probe declares its name, threat-model description, and expected pass/fail criteria; the runner records every probe invocation as a `synthetic_probe`-quality observation in the event log so probe runs are themselves auditable.
- `Sentinel` base class with hooks into the firewall transition stream. Sentinels watch for patterns (low-confidence actions, suspicious memory-origin combinations, anomalous tool sequences) and emit `sentinel.alerted` events.
- `Calibrator` that consumes the event log and produces per-class accuracy tables (ECE, Brier score) suitable for the calibration paper drafts.
- ✅ Probe pack format (`lodestar.probe-pack.json` manifest + probe files; the manifest declares pack name, version, declared coverage areas, and which Lodestar invariants it exercises). Schema in `@qmilab/lodestar-core` (`ProbePackManifestSchema`); the v0 loader in `@qmilab/lodestar-harness` resolves `local` packs and rejects path-traversal / symlink escapes.
- `lodestar harness run --pack <name>` CLI command (registered under the existing `lodestar` binary, not a new bin).

*Probe pack repackaging*:
- ✅ Moved the 17 existing probes from `research/probes/` into a first-party pack `packs/lodestar-core/` so they ride the same loader path external packs will use. The probes themselves did not change; the `lodestar.probe-pack.json` manifest is new and loads through `@qmilab/lodestar-harness`. (Count grew 14→17 in Batch 4's reflection-pass step before the move: `reflection-cannot-promote-to-normal-alone`, `contradicted-belief-flags-dependent-decisions`, `event-log-canonical-hash`.)

*Three new probes (the threat-model gaps Batch 3 surfaced but couldn't close)*:
- `prompt-injection-cross-tool` — observation chain where injected instructions in one tool's output try to manipulate a subsequent tool's invocation. Stronger than `mcp-proxy-injection-defense` because it spans two calls.
- `tool-poisoning-cross-session` — a memory imported from a hostile source in session A is queried by session B; verify the firewall's `external_document` provenance survives the session boundary (requires a persistent belief store, see below).
- `confidence-drift` — belief confidence diverges from observed outcome over a sequence of actions; the calibrator should flag this as a per-class miscalibration.

*Two firewall invariants deferred from earlier batches* (now unblocked because reflection lands here):
- **Reflection cannot promote to `normal` retrieval alone.** The Round 5 auto-observation gate downgrades `external_document` claims to `reflection` authority; reflection itself was previously a stub. Implementing the reflection pass — and the invariant that reflection alone cannot move a belief to `normal` retrieval without another corroborating source — is part of this batch.
- **Contradicted belief flags dependent decisions.** Requires the Decision→Belief dependency pipeline to track and propagate cascading contradictions; partial in Batch 3, full here.

*Three sentinels*:
- **Low-confidence action sentinel.** Watches `action.proposed`/`action.approved`; alerts on actions whose `required_level` ≥ 3 backed by a belief at `confidence < 0.5` or `truth_status: unverified`.
- **Suspicious memory-origin sentinel.** Watches `belief.adopted`; alerts when an `external_document`-sourced belief becomes a `belief_dependency` of a Decision.
- **Anomalous tool sequence sentinel.** Pattern-matches against known suspicious sequences (e.g., `fs.read` → `network.egress` → `fs.write`) and surfaces them for review.

*Persistence (carve-out)*:
- Postgres-backed `BeliefStore` and `ClaimStore`. The harness needs this to validate sentinels across sessions; the in-memory stores are session-scoped.

*First in-repo probe pack*: `packs/coding-agent-safety/` — bundles the prompt-injection / tool-poisoning / confidence-drift probes plus the three sentinels into a single installable pack a future operator can point `lodestar harness run --pack coding-agent-safety` at.

**Out of scope**: public registry (v1+), signed manifests (v1.5+), hosted dashboard, multi-tenant control plane.

**Effort estimate**: ~1.5 weeks once the reflection pass design is locked. The reflection pass is the load-bearing piece; the rest of the deliverables hang off it.

### Batch 5 — Week-8 thesis demo + second proving ground

**Goal**: a complete worked example demonstrating that Lodestar's value proposition holds end-to-end. Telenotes is the first proving ground; a documentation-agent example is the second, lower-cost proving ground that exercises claim/evidence beyond schema-bound extractors.

**Deliverables**:

*Primary proving ground (Telenotes)*:
- A coding agent (Claude Code, wrapped via the MCP proxy from Batch 3) is asked to add a feature to Telenotes
- The agent observes the codebase, forms beliefs about the existing architecture, makes a plan, edits files, runs tests, commits
- Lodestar records the full epistemic chain
- At the end, `lodestar report` produces a structured markdown report explaining:
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
- Lodestar records claims (e.g., "this function takes parameter X") with evidence linked to the source files
- `lodestar report` shows which source supported each documentation claim
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

- ✅ **ContextPolicy contradiction routing** (landed pre-Batch 3): `MemoryFirewall.retrieveContradictions(query, policy)` returns contradicted beliefs whose claim shares the same `structured_predicate.{subject, relation}` as one of the accepted-set candidates the standard retrieval would surface under the same policy. Subject-only join would lump unrelated relations together; the (subject, relation) join is the natural one. Claims without a structured predicate are intentionally excluded — surface only what we can prove related. Probe: `packs/lodestar-core/probes/context-policy-contradiction-routing.ts`.
- ✅ **Kernel context propagation** (landed pre-Batch 3): `ActionKernel` takes a required `KernelContext` argument — either a resolver function, a static `{ session_id, project_id }` pair, or `{ useStubsForTests: true }` for test scaffolding. The old silent stub fallback no longer exists; production hosts (Guard, the MCP proxy) cannot accidentally reach it. Probe: `packs/lodestar-core/probes/kernel-context-propagation.ts` verifies real values flow through to every event-log envelope.
- ✅ **Event log single-writer enforcement** (landed pre-Batch 3): per-partition async mutex (`sharedAppendLocks`) serializes concurrent appends to the same `${rootDir, project_id}` partition within a single process. Multiple writer instances (Guard's `runGuarded`-per-session pattern) keep working — they share the queue. Cross-process safety remains deferred (the MCP proxy is single-process per this roadmap; a file-lock layer can be added on top later without breaking the interface). Probe: `packs/lodestar-core/probes/event-log-single-writer.ts` fans out 100 concurrent appends with 8 KiB payloads and verifies no duplicate seq, no torn writes, contiguous monotonic sequence.

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
- **Quantum world-model integration** — separate research arc under QMI Lab Pillar III. Not Lodestar's path.

---

## Research arc (parallel)

Independent of the implementation roadmap, the research outputs from Lodestar flow into QMI Lab's publication pipeline. Most of these are *outlines* in 2026, not papers — empirical claims need accumulated session data and failure analysis before they go to publication. The exception is the position paper, which is design contribution and can be drafted ahead of large-scale empirical work.

**Reasonable to draft now (outline + position-paper voice)**:

1. **Position paper: epistemic governance as an architectural primitive** — full draft achievable in 2026 once Batch 3 lands. This is design contribution, not empirical evaluation.
2. **Memory-poisoning threat taxonomy** — design note + structured taxonomy. Publishable as a workshop paper without large empirical claims.
3. **Probe taxonomy and methodology notes** — short methods paper describing the probe pack format and the criteria for a "good" probe.

**Premature in 2026, target 2027+**:

4. **Empirical memory-poisoning paper** — needs deployed Lodestar instances and real attack traces. Not before late 2027.
5. **Calibration framework for agent beliefs** — needs accumulated session data showing calibration before-and-after. Not before mid-2027.
6. **Evaluation methodology for trust-aware agent systems** — needs comparison baselines and benchmark workloads that don't exist yet. Not before late 2027.

Each paper draws on Lodestar's implementation but does not block it. The implementation roadmap and the research arc are coupled but independent. The right discipline: outline now, publish only when the data is there.
