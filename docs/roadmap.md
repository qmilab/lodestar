# Lodestar — Roadmap

This roadmap defined the sequence from the original pre-v0.1 scaffold to a v1 release that supports the headline use case ("wrap a coding agent and get a trust report"). That sequence — Batches 1–5 plus the post-v1 build track — is complete and published as **v0.3.0 on npm (24 packages)**. What remains is the publish/research track tracked under "Post-v1" below, plus the **v1.5 build track** — native adapters (#74), non-MCP runtime adapters (#75), and the public marketplace registry (#76) — tracked under the open `roadmap:v1.5` issues.

Last updated: 2026-06-13 — **v0.3.0 published to npm (all 24 packages)**: added `@qmilab/lodestar-adapter-sql` (ADR-0013) and `@qmilab/lodestar-ship` (ADR-0014).

---

## Where we are

The implementation passes a typecheck under strict TypeScript and runs fifty-one probes end-to-end across two packs (`probes:ci`) — 47 in `lodestar-core`, 4 in `coding-agent-safety`. One, `tool-poisoning-cross-session`, needs a Postgres test database (`LODESTAR_TEST_DATABASE_URL`) and skips with a loud banner when it is unset; CI runs it against a `postgres:16` service. **v0.3.0 — all 24 packages — is on npm via CI trusted publishing** (staged publishing, maintainer-approved). v0.2.0 shipped the eight net-new post-v0.1.5 packages — `policy-kernel`, `harness`, `viewer`, `otel-exporter`, and the shell/nostr/http/messaging adapters — plus the updated `guard`/`cli` that wire them in; v0.3.0 added the governed SQL/database adapter `adapter-sql` (ADR-0013) and the read-side session shipper `ship` (ADR-0014). Batches 1–5 and the post-v1 build track (sentinel→action wiring, the Policy Kernel, five native egress adapters, the read-side viewer, the OTel exporter, signed approval resolutions, and a durable calibration event) have all landed. The architecture is settled — what follows is the publish/research track.

Concrete state:
- Schema layer for the full epistemic chain
- Append-only NDJSON event log with monotonic sequencing, payload hashes, and per-partition append serialization
- Two-phase action execution with precondition revalidation; required `KernelContext` (no silent stub fallback)
- Memory firewall with four orthogonal lifecycle axes, per-axis transition tables, and subject-related contradiction routing
- Cognitive core: extractors, evidence linker, world model, ingestion orchestrator, Round 5 auto-observation gate
- **MCP proxy (Batch 3): `lodestar guard mcp-proxy --config <path>`** — wraps any MCP-speaking agent (Claude Code, Cursor, Aider) so its tool calls flow through the Action Kernel and its tool results through the Cognitive Core, with `mcp.tool_result@1` observations carrying separate `tool_result`-quality envelope claims and `external_document`-quality content claims
- **Harness (Batch 4, done): `lodestar harness run --pack <name>`** — probe-pack format + loader, the `Probe` base class + pack runner, the `Sentinel` base class + three sentinels (`low-confidence-action`, `suspicious-memory-origin`, `anomalous-tool-sequence`), reflection in the cognitive core, the Postgres-backed belief/claim/evidence stores, `tool-poisoning-cross-session` (with the proxy/`guard.wrap()` Postgres wiring it rides on), the `Calibrator` plus the `confidence-drift` probe it gates, and the three sentinels folded into the `coding-agent-safety` pack (declared by id under the manifest's `sentinels` field, resolved against the first-party registry) have all landed.
- Forty-seven passing probes — forty-three in the first-party pack `packs/lodestar-core/` (full list in [`reference/probe-packs.md`](reference/probe-packs.md); the foundational set:)
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
  - reflection-cannot-promote-to-normal-alone (reflection cannot self-promote a belief to normal retrievability)
  - contradicted-belief-flags-dependent-decisions (a contradicted belief cascades a flag to decisions that depended on it)
  - event-log-canonical-hash (canonical-hash determinism over the event log)
  - documentation-evidence-provenance (a claim extracted from a documentation file's *content* is `external_document` evidence stamped with its source file, and the belief it backs stays `unverified` — proven by contrast with the default linker, which would promote the same content to `supported`; this is the invariant the Batch 5 documentation-agent rests on)
- ...and four in the first non-core pack `packs/coding-agent-safety/`:
  - prompt-injection-cross-tool (an injection planted in one tool call's output cannot pre-authorise or launder the trust of a subsequent call's output across a shared proxy session)
  - tool-poisoning-cross-session (a poisoned memory written by one proxy session into a shared Postgres store cannot launder its trust by surviving into a second session — it stays `unverified` with `external_document` provenance, and the planner gate still keeps it out of trusted context across the boundary; needs a Postgres test database, runs in CI)
  - confidence-drift (belief confidence held high while a sequence of actions fails — the Calibrator flags the class as overconfident, leaves a calibrated control class alone, does not alarm on thin data, and excludes synthetic-authority beliefs; the flagged class's gap / Brier / ECE match a hand-computation)
  - poisoned-file-cannot-hijack-feature-work (the governed-dev framing: a poisoned doc file read during a coding agent's observation phase, alongside a legitimate source file, stays `external_document`/`unverified` and never enters the supported-belief set a planner draws on — so it cannot hijack the feature work; the Batch 5 invariant the Telenotes poison run rests on)
- End-to-end examples: telenotes-governed-dev (Batch 5 primary proving ground: a coding agent adds a feature through the MCP proxy over two live downstream servers — filesystem + a first-party dev-tools server — with a full epistemic-chain trust report, a poisoned-file run that self-verifies the firewall holds, and a real-Claude-Code recipe), doc-insight (auto-observation gate), coding-agent-greenfield (`guard.wrap()` on a homegrown loop), claude-code-wrapped (MCP proxy wrapping a stand-in agent against a real filesystem MCP server), documentation-agent (Batch 5 secondary proving ground: claim/evidence over documentation content via the `DocAwareEvidenceLinker` cognitive seam)

---

## Five batches to v1

The work is partitioned into five batches. Each batch is scoped to land cleanly, with the next batch building on it.

### Batch 1 — Positioning

**Goal**: lock the public-facing language and roadmap before any further code is written.

**Deliverables**:
- New `README.md` in trust-layer voice (done)
- Positioning doc with the four-surface framing (done)
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

**Status**: done (reflection pass, probe-pack format + loader, probe repackaging, the `Probe` base class + pack runner + `lodestar harness run` CLI, the `Sentinel` base class + the three sentinels, the first `coding-agent-safety` probe `prompt-injection-cross-tool`, the Postgres-backed stores, `tool-poisoning-cross-session` plus the proxy/`guard.wrap()` Postgres wiring, the `Calibrator` plus the `confidence-drift` probe it gates, and finally the three sentinels folded into the `coding-agent-safety` pack — manifest `sentinels` field + loader registry resolution — have all landed).

**Goal**: turn the probe scripts into a real harness with probes, sentinels, and calibrators that can be packaged and shared. This is what the `Lodestar Harness` developer entry point needs to graduate from loose TS files in `research/probes/` to an installable surface external packs can plug into.

**Deliverables**:

*Harness package* — `packages/harness/`:
- ✅ `Probe` base class and execution runner. The `Probe` authoring surface (`Probe` / `ProbeSpec` / `runProbeAsScript`) is additive — the 17 first-party probes stay as standalone scripts (probes are spec). The runner (`runPack`) is a subprocess driver: each probe is `bun run`-executed and judged by exit code, and every run is recorded as a `trust: "synthetic"` `observation.recorded` event (schema `harness.probe_run@1`) so probe runs are themselves auditable through `lodestar report`.
- ✅ `Sentinel` base class + `SentinelRunner`, an async tail over the event stream (which carries the firewall's `belief.adopted` / `belief.transitioned` transitions). Sentinels watch for patterns and emit `sentinel.alerted@1` events; they are non-blocking by design (Q7 of the reflection design doc). Wire format (`SentinelAlertPayloadSchema`) lives in `@qmilab/lodestar-core`; base class, runner, three sentinels, and the injected `eventLogAlertSink` live in `@qmilab/lodestar-harness`. Design lock: `docs/architecture/sentinels.md`. The `arbitrate` hook that *consumes* alerts is deliberately deferred to the Policy Kernel (additive; alerts are audit signal until then).
- ✅ `Calibrator` that consumes the event log and produces per-class accuracy tables (ECE, Brier score, calibration gap) suitable for the calibration paper drafts. Lives in `packages/harness/src/calibration/`; pairs belief `confidence` against realised outcome (an action's terminal phase or an explicit `Outcome` event, and `truth_status` transitions), bins by `calibration_class`, and flags a class as miscalibrated under a `min_samples` guard. Excludes `authority: "synthetic"` beliefs by default (a probe artefact must not pollute a real class). Measures only — acting on a flag (downweighting an overconfident class) is deferred to the Policy Kernel, exactly like the sentinels' consuming `arbitrate` hook. Design lock: `docs/architecture/calibrator.md`.
- ✅ Probe pack format (`lodestar.probe-pack.json` manifest + probe files; the manifest declares pack name, version, declared coverage areas, and which Lodestar invariants it exercises). Schema in `@qmilab/lodestar-core` (`ProbePackManifestSchema`); the v0 loader in `@qmilab/lodestar-harness` resolves `local` packs and rejects path-traversal / symlink escapes.
- ✅ `lodestar harness run --pack <name>` CLI command (registered under the existing `lodestar` binary, not a new bin). Plus `lodestar harness list` for side-effect-free manifest inspection. `probes:all` now drives the runner instead of a hand-chained script.

*Probe pack repackaging*:
- ✅ Moved the 17 existing probes from `research/probes/` into a first-party pack `packs/lodestar-core/` so they ride the same loader path external packs will use. The probes themselves did not change; the `lodestar.probe-pack.json` manifest is new and loads through `@qmilab/lodestar-harness`. (Count grew 14→17 in Batch 4's reflection-pass step before the move: `reflection-cannot-promote-to-normal-alone`, `contradicted-belief-flags-dependent-decisions`, `event-log-canonical-hash`.)

*Three new probes (the threat-model gaps Batch 3 surfaced but couldn't close)*:
- ✅ `prompt-injection-cross-tool` — observation chain where injected instructions in one tool's output try to manipulate a subsequent tool's invocation. Stronger than `mcp-proxy-injection-defense` because it spans two calls: an injection planted in call 1's output cannot pre-authorise or launder the trust of call 2's output. Both content claims stay `unverified` and no `supported` belief in the shared session store carries the injected text. Landed in `packs/coding-agent-safety/`.
- ✅ `tool-poisoning-cross-session` — a memory imported from a hostile source in session A is queried by session B; the firewall's `external_document` provenance and `unverified` truth status survive the session boundary, and the planner gate still keeps the poisoned memory out of trusted context in session B. Landed in `packs/coding-agent-safety/`, backed by the Postgres stores and the proxy store-injection seam (`MCPProxyOverrides.stores`). Skips when `LODESTAR_TEST_DATABASE_URL` is unset; runs in CI against `postgres:16`.
- ✅ `confidence-drift` — belief confidence diverges from observed outcome over a sequence of actions; the calibrator flags this as a per-class miscalibration. Lands in `packs/coding-agent-safety/`. Synthesises a real NDJSON session log (an overconfident class held at 0.92 while eight actions fail, a calibrated control, a thin class kept under the `min_samples` guard, and a synthetic-authority belief that must be excluded), reads it back through `EventLogReader`, and asserts the flag fires only where it should — with the flagged class's gap / Brier / ECE matched to a hand-computation.

*Two firewall invariants deferred from earlier batches* (now unblocked because reflection lands here):
- **Reflection cannot promote to `normal` retrieval alone.** The Round 5 auto-observation gate downgrades `external_document` claims to `reflection` authority; reflection itself was previously a stub. Implementing the reflection pass — and the invariant that reflection alone cannot move a belief to `normal` retrieval without another corroborating source — is part of this batch.
- **Contradicted belief flags dependent decisions.** Requires the Decision→Belief dependency pipeline to track and propagate cascading contradictions; partial in Batch 3, full here.

*Three sentinels* (all landed):
- ✅ **Low-confidence action sentinel** (`low-confidence-action`). Watches `action.proposed`/`action.approved`; alerts on actions whose `required_level` ≥ 3 backed by a belief at `confidence < 0.5` or `truth_status: unverified`. Resolves the backing via `action.decision_id → decision.belief_dependencies → belief`; dedupes per action id; thresholds configurable.
- ✅ **Suspicious memory-origin sentinel** (`suspicious-memory-origin`). Learns `external_document` origin from `evidence.assessed` + `belief.adopted`, then alerts at `decision.made` when such a belief is a `belief_dependency`. One alert per offending belief (subject `kind: belief`) so the future kernel hook can gate the next action that leans on it.
- ✅ **Anomalous tool sequence sentinel** (`anomalous-tool-sequence`). Pattern-matches executed actions per session against known suspicious sequences as an ordered subsequence that must complete at the current event; ships the `read → external-egress → write` exfiltration pattern by default (egress keyed off `blast_radius: external`). Matched steps are consumed so the pattern alerts once per genuine completion.

*Persistence (carve-out)*:
- ✅ Postgres-backed `BeliefStore`, `ClaimStore`, **and** `EvidenceStore` (`packages/memory-firewall/src/stores/postgres-*.ts`, via `createPostgresStores()`). Same interfaces as the in-memory stores, backed by Bun's native `Bun.SQL` (zero new deps); two sessions pointed at the same database see each other's state. Integration tests are gated on `LODESTAR_TEST_DATABASE_URL` and run against a `postgres:16` service in CI. ✅ Wiring landed: the MCP proxy takes injected stores via `MCPProxyOverrides.stores` (config-driven through `persistence: { backend: "postgres", connection_string_env }`, resolved and lifecycle-owned by the `lodestar guard mcp-proxy` CLI), and `guard.wrap()` takes them via `GuardConfig.stores`. The `tool-poisoning-cross-session` probe rides this seam.

*First in-repo probe pack*: `packs/coding-agent-safety/` — ✅ created, shipping `prompt-injection-cross-tool`, `tool-poisoning-cross-session`, and `confidence-drift` via `lodestar harness run --pack coding-agent-safety`, plus ✅ all three sentinels folded into the same installable pack — declared by id under the manifest's `sentinels` field and resolved against the harness's first-party `FIRST_PARTY_SENTINELS` registry.

*Probe-execution sandboxing (carve-out for when external packs land)*: ✅ **both steps done.** **Step 1 — scoped-env execution (#114, ADR-0022):** the runner spawns each probe with an explicit scoped env — a fresh empty HOME + inherited PATH, never the host `process.env` — so a hostile probe cannot read host secrets out of the environment. The operator widens it via `--allow-env <NAME>` (e.g. `LODESTAR_TEST_DATABASE_URL`); the untrusted manifest cannot. Mirrors the Action Kernel's "no host env to sandboxes" rule and the native adapters' `baseGitEnv`/`defaultScopedEnv`. Locked by `runner-denies-host-env-to-probe`. **Step 2 — the OS sandbox (#121, ADR-0023):** each probe additionally runs inside `sandbox-exec` (macOS) / `bubblewrap` (Linux), confining its **filesystem** (writes → a per-run scratch; reads → the pack dir + operator `--allow-read`, home credential stores denied) and **outbound network** (loopback + operator `--allow-host`). Opt-in at `runPack`; the CLI defaults it on for external packs, off for the bundled first-party packs; fails closed (functional detection, not just presence). Locked by `runner-sandboxes-probe-filesystem-and-network` + the reproducible `scripts/validate-linux-sandbox.sh` (real bwrap, CI-gated). An **OS-primitive boundary, not kernel-grade/namespace/cgroup containment**, with documented per-platform edges (macOS port-scoped egress; Linux all-or-nothing under `--unshare-net`). Remaining follow-ups: per-file `/etc` allowlist on Linux, sandboxing `pack attest`, a container backend.

**Out of scope**: public registry (v1+), signed manifests (v1.5+), hosted dashboard, multi-tenant control plane.

**Effort estimate**: ~1.5 weeks once the reflection pass design is locked. The reflection pass is the load-bearing piece; the rest of the deliverables hang off it.

### Batch 5 — Week-8 thesis demo + second proving ground

**Goal**: a complete worked example demonstrating that Lodestar's value proposition holds end-to-end. Telenotes is the first proving ground; a documentation-agent example is the second, lower-cost proving ground that exercises claim/evidence beyond schema-bound extractors.

**Deliverables**:

*Primary proving ground (Telenotes)* — **landed** (`examples/telenotes-governed-dev/`):
- ✅ A coding agent (a deterministic in-process driver, with a `real-claude-code/` recipe to swap in live Claude Code), wrapped via the MCP proxy from Batch 3, adds a `clientTag` feature to the Telenotes fixture (a small Nostr note-publishing module). The proxy owns two live downstream MCP servers: the official `@modelcontextprotocol/server-filesystem` for read + `write_file`, and a first-party `dev-tools-mcp/` server for `shell_test` / `git_commit` / `git_push`.
- ✅ The agent observes the codebase, decides on a plan, edits files, runs tests, commits, and attempts to push — observe → decide → edit → test → commit → blocked-push → revise.
- ✅ Lodestar records the full epistemic chain; `lodestar report` renders a structured markdown report (committed under `reports/scripted-run.report.md`) showing observations, claims (tool-result envelope vs `external_document` content), beliefs at their truth status, the feature decision and the beliefs it cited, every action with its policy verdict and outcome, and the post-block revision. The policy gate has teeth: reads/writes/test/commit auto-approve at ≤ L3; the lone L4 `git_push` is rejected.
- ✅ A second run (`poison-run/`, report under `reports/poison-run.report.md`) plants a hostile `DEVELOPMENT.md` read during observation and self-verifies the firewall holds — the injected content stays `external_document`/`unverified`, never enters the trusted-belief set the feature decision draws on, and the L4 push stays blocked regardless of the file's "pre-approved" claim. Locked in CI by the `poisoned-file-cannot-hijack-feature-work` probe (`packs/coding-agent-safety/`).
- ✅ Evidence captured from a real Claude Code session against the proxy (CC 2.1.159; committed under `real-claude-code/captured/`). The run is billed and non-deterministic, so its `captured/` artifacts are produced by hand, not CI — a point-in-time record, not a reproducible test.

*Secondary proving ground (documentation agent)* — **landed** (`examples/documentation-agent/`):
- ✅ A small agent reads its own `README.md`, `package.json`, and a sample source module via a governed `doc.read` tool
- ✅ It updates a stale docstring through a governed `doc.write` action (hard-scoped to the example's `workspace/`)
- ✅ Lodestar records content claims (e.g., "`renderWidget` takes `(props, options)`") with evidence linked to the source files. The new `DocumentationExtractor` reads *into* file content (beyond the schema-bound `git.status` / `fs.read` extractors); the new `DocAwareEvidenceLinker` tags that content `external_document` and stamps each item with its source file.
- ✅ `lodestar report` shows which source supported each documentation claim (via the evidence `independence_group`/`notes`, no renderer change). Because file content is `external_document`, the backing beliefs stay `truth_status: unverified` — the docstring fix is honestly recorded as resting on read-not-verified evidence.
- ✅ Wired through the headline `guard.wrap()` API via a new, general `GuardConfig.cognitive.evidenceLinkerFactory` seam (mirrors the existing `stores` seam) — any example or product can attach document-aware / MCP-aware / LLM-driven evidence linking the same way. Reusable pieces ship in `@qmilab/lodestar-cognitive-core`; `doc.read` + the `documentation.source@1` schema ship in `@qmilab/lodestar-adapter-filesystem`.
- ✅ Locked by the `documentation-evidence-provenance` probe (`packs/lodestar-core/`).

- ✅ Blog/video walkthrough of both demos (publishable artifact) — DONE (PR #29). Reader guide `docs/guides/walkthrough.md`. **Batch 5 is complete.**

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

## Post-v1 (in progress)

Work past the v1 line, tracked here as it lands:

- **Governing UI (a) — read-side viewer** — ✅ landed (`packages/viewer/`,
  `@qmilab/lodestar-viewer`, `lodestar view`). A local, strictly read-only
  web viewer over the event log: Elysia + a no-build vanilla SPA reusing the
  trace read side (`projectChain()` + `renderReport()`), with session list,
  interactive chain drill-down, the markdown report, an event-type filter, a
  live tail over Server-Sent Events, and a read-only view of pending
  approvals. It is the interactive sibling of `lodestar report`. No mutation
  route, never writes the log — locked by the `viewer-is-read-only` probe.
  The framework-rich **write-side** Governing UI (resolving approvals, team
  workflows, RBAC, dashboards) is a separate write-side surface and is not
  in this repo.

- **otel-exporter — the OpenTelemetry bridge** — ✅ landed
  (`packages/otel-exporter/`, `@qmilab/lodestar-otel-exporter`,
  `lodestar otel export`). The "pair with Langfuse/Phoenix" bridge: a
  read-side, batch exporter that projects a session into OTel GenAI spans and
  emits them as **OTLP/HTTP JSON** (POST to a collector, or `--out`/`--stdout`
  for a collector-free dry run). Action-centric span model — the session is the
  root `invoke_agent` span, each governed Action an `execute_tool` child span
  carrying the policy verdict, trust level, and outcome; observations, beliefs,
  decisions, and firewall transitions ride as span events. Reuses the trace
  read side (`projectChain()`); hand-rolls the OTLP wire format (no OTel SDK
  dependency — the log already holds the causal DAG). Honours the locked v0.2
  export gate: content above a configured **sensitivity ceiling** (default
  `internal`) is withheld (structural metadata + payload hash only). Locked by
  two probes — `otel-export-respects-sensitivity-ceiling` (the gate) and
  `otel-export-projects-action-spans` (the span tree). **Metrics/logs signals
  and live in-process instrumentation are out of scope for v0** (traces only).

- **Native adapters (P2) — shell (a)** — ✅ landed
  (`packages/adapters/shell/`, `@qmilab/lodestar-adapter-shell`). Graduates the
  demo-shaped `dev-tools-mcp` server into a configurable native adapter: the
  operator declares command **specs** and each becomes its own governed `Tool`
  with its own name + trust floor (`defineShellTool` / `registerShellTools`),
  plus a `bunTest` (`shell.test`) preset. A **TS-level governance boundary, not an
  OS sandbox** — fixed-binary argv-only exec (no shell string), an `argsMatcher`
  allowlist, no host-env passthrough (scoped env), a wall-clock timeout that kills
  the process, bounded output capture, and a pinned cwd; OS-level enforcement
  (namespaces/cgroups/network) stays deferred. Locked by the
  `shell-adapter-enforces-sandbox-invariants` probe. Design lock: ADR-0004.

- **Native adapters (P2) — git transport (b)** — ✅ landed
  (`packages/adapters/git/`, `@qmilab/lodestar-adapter-git`). Adds the forge-agnostic
  transport tools `git.commit` (L3) / `git.push` (**L4 — the first native egress**) /
  `git.clone` (L3) alongside the existing read-only `git.status`. The headline teeth:
  **remote pinning** (the agent names a remote; the operator pins name → URL; the push
  targets the pinned URL explicitly, bypassing a poisoned `.git/config`), **scoped
  credentials** (explicit, no default; token via `GIT_ASKPASS` → never argv, redacted
  from output; resolver seam for fetch-at-push-time), and a **clone source allowlist +
  destination pin** (inbound content is untrusted). A **TS-level governance boundary,
  not an OS sandbox** — `push`/`clone` reach the network by design. Locked by the
  `git-adapter-enforces-egress-invariants` probe. Naming/scope lock: ADR-0006 (transport
  is forge-agnostic, so it lives in `adapter-git`; `adapter-github` is reserved for the
  forge-API surface behind a provider seam).

  **Extended P2 sequence (ADR-0005).** Build an adapter when governance is
  load-bearing — a consequential action (trust ladder / L4), untrusted output
  (`external_document` → the firewall), or outward data movement (`blast_radius:
  external` → the dormant `read → egress → write` sentinel). On that basis the
  ordered native-tool sequence is now **shell ✓ → git transport ✓ (ADR-0006) →
  nostr ✓ (ADR-0007) → http ✓ (ADR-0008) → messaging ✓ (ADR-0009)** — the full
  ordered sequence is now complete — with a governance-rich backlog (SQL/database,
  vector/RAG retrieval, `fs.write`, payments, cloud/infra) pulled by demand. `http`
  hit all three governance surfaces at once (injection + egress + untrusted content)
  and lit up the egress sentinel; `messaging` closed the sequence as the purest
  human-approval demo. Memory-firewall import adapters (Pinecone/Weaviate/Chroma,
  Redis, …) continue the `mem0`/`letta`/`zep` pattern.

- **Native adapters (P2) — nostr (c)** — ✅ landed
  (`packages/adapters/nostr/`, `@qmilab/lodestar-adapter-nostr`). The **second native
  egress** after `git.push`, proving the egress model generalises beyond git: a
  different transport (a relay WebSocket) and a different credential (a signing key).
  Two tools — `nostr.publish` (**L4**, held until approved) and `nostr.fetch` (L1,
  untrusted inbound). The teeth: **relay pinning** (the agent targets only
  operator-pinned relays — no exfil to an attacker relay; also an SSRF guard on
  reads), the **signing key as the credential** (operator-supplied hex/`nsec`,
  signed **in-process** via BIP-340 Schnorr so it never reaches the wire, redacted
  from output, resolver seam), a **kind allowlist** (default kind 1; no agent-driven
  deletions/profile overwrites), **NIP-42 AUTH** (restricted relays authenticated
  with the same key), and **untrusted inbound** (fetched events carry a locally
  verified `signature_valid`; a valid signature attests authorship, not truth).
  Adds the honest **`controlled-network`** sandbox profile (network egress, no shell,
  no fs). A **TS-level governance boundary, not network containment** — `publish`/
  `fetch` reach the real relay by design. Locked by the
  `nostr-adapter-enforces-egress-invariants` probe. Design/scope lock: ADR-0007.

- **Native adapters (P2) — http (d)** — ✅ landed
  (`packages/adapters/http/`, `@qmilab/lodestar-adapter-http`). The **third native
  egress** after `git.push` and `nostr.publish`, and the first adapter to hit all
  three governance surfaces at once (ADR-0005's bar): an injection vector (untrusted
  fetched content), egress (an agent-authored body to an external host), and an
  irreversible action. Two tools — `http.request` (**L4**, held until approved) and
  `http.fetch` (L1, untrusted inbound). The teeth: **host pinning + a scheme
  allowlist** (HTTPS only unless opted out; the agent reaches only operator-pinned
  hosts — no arbitrary/internal destination), the headline **per-hop redirect
  re-validation** (a pinned host that 3xx-redirects to a non-pinned host — the
  `localhost`/metadata SSRF escape — is stopped), **host-bound credentials** (an
  operator auth header, resolver-capable, re-resolved per hop so host A's token
  never reaches host B, redacted from output), and **bounded capture** (a wall-clock
  timeout + a response-body byte cap on untrusted content). Reuses the
  `controlled-network` sandbox; needs no new core schema. A **TS-level governance
  boundary, not network containment** — `fetch`/`request` reach the real host by
  design, and DNS is not resolved to block private ranges. Locked by the
  `http-adapter-enforces-egress-invariants` probe. Design/scope lock: ADR-0008.

- **Native adapters (P2) — messaging (e)** — ✅ landed
  (`packages/adapters/messaging/`, `@qmilab/lodestar-adapter-messaging`). The
  **fourth native egress** family after `git.push` / `nostr.publish` /
  `http.request`, and the last ordered pick in the P2 sequence — the purest
  instance of one governance surface: an outward, irreversible send a human must
  approve, so the cleanest demonstration of the Policy-Kernel human-approval gate.
  Two L4 tools — `slack.post` (post to a pinned Slack channel) and `email.send`
  (send to pinned recipients via an HTTP email API, provider-agnostic payload),
  both held until approved. The teeth: **destination pinning** (the messaging exfil
  guard — a channel allowlist / a recipient allowlist by exact address *and* whole
  domain; the agent cannot message an arbitrary recipient), an **operator-fixed
  endpoint + sender** (the agent never names the host — no agent-driven SSRF — nor
  the email `from` — no spoofing), **scoped credentials** (a bot token / API key,
  resolver seam, redacted), **no redirect following** (a provider 3xx is a hard
  failure — structurally simpler than `http`, which needed per-hop re-validation),
  and **send delivery semantics** (a non-2xx, or a Slack `ok:false` at HTTP 200,
  ends the action `failed` — a rejected send is never reported as delivered).
  Reuses the `controlled-network` sandbox; needs no new core schema or deps
  (uses global `fetch`). Egress-only this slice — inbound reading (`slack.read` /
  `email.fetch`) is a deferred follow-up, since `http.fetch` already proves the
  untrusted-inbound surface. A **TS-level governance boundary, not network
  containment**; SMTP is intentionally not implemented (email rides an HTTP API,
  the common production path). Locked by the
  `messaging-adapter-enforces-egress-invariants` probe. Design/scope lock: ADR-0009.

- **Native adapters (backlog) — SQL/database** — ✅ landed
  (`packages/adapters/sql/`, `@qmilab/lodestar-adapter-sql`). The first pull from
  the governance-rich backlog after the ordered P2 sequence, and the first native
  adapter whose headline governance surface is an **injection boundary** rather than
  (only) egress. Two tools over one operator connection (Postgres via Bun's native
  `Bun.SQL`, no runtime dep): `sql.query` (**L1** read, untrusted rows) and
  `sql.execute` (**L3**, operator-raisable to **L4** — a held mutation). The teeth:
  **parameterized-only** (values are always bound as `$1..$N`, never concatenated —
  so a `'); DROP TABLE …;--` parameter is stored as a literal, never executed; no
  string-SQL path exists), the **read/mutation split with teeth** (`sql.query` runs
  inside a `READ ONLY` transaction, so even a data-modifying CTE — which the lexical
  guard waves through — is refused by the database itself), **scoped credentials**
  (the connection is operator config, never the agent's, the password redacted from
  any caught error), and **bounded capture** (a result-row cap + per-statement
  `statement_timeout`). A **TS-level governance boundary, not database
  containment** — the query reaches the real database by design; DB-side privileges
  (a least-privileged role) are the operator's defence in depth. Locked by the
  `sql-adapter-enforces-invariants` probe (DB-gated like
  `tool-poisoning-cross-session`: `LODESTAR_TEST_DATABASE_URL`, skips loudly when
  unset, runs against `postgres:16` in CI). lodestar-core 44→45 probes, **49 across
  both packs**. Design/scope lock: ADR-0013.

- **The Policy Kernel** — ✅ landed (`packages/policy-kernel/`,
  `@qmilab/lodestar-policy-kernel`). The three-valued gate (allow / deny /
  **hold**) compiled from a signed policy document, with the trust-ladder floor,
  the approval lifecycle, and the arbitrate hook the sentinel/calibration wiring
  below plugs into. The L4 hold every native egress above relies on is its work.
  Fourteen probes lock the gate, the floor, the lifecycle, and signature
  verification.

- **Sentinel → action wiring (P1)** — ✅ landed. The host-side bridge that runs
  the harness sentinels over the live event stream and feeds their alerts (and
  calibration flags) through the Policy Kernel's arbitrate hook, so a real alert
  actually **holds** the dependent action — in both `guard.wrap()` (agent-declared
  decisions) and the MCP proxy (synthesized decisions for an opaque agent that
  can't declare its own). Locked by `guard-arbiter-gates-dependent-action` and
  `mcp-proxy-arbiter-gates-dependent-action`. Design lock: ADR-0001 / 0002 / 0003.

- **Security hardening (P3) — signed approval resolutions** — ✅ landed.
  Out-of-band approvals carry an **Ed25519** signature verified against
  operator-pinned approver keys, so a forged, unsigned, or tampered grant cannot
  un-park a held L4 across a process boundary — the first real crypto forgery
  boundary (the earlier policy-signature path was an injected placeholder). The
  same gate covers both the side-channel and the sibling event log. Locked by
  `forged-approval-cannot-execute`. Design lock: ADR-0010.

- **Security hardening (P3) — durable calibration event** — ✅ landed. A
  calibration pass is recorded as a governed `calibration.computed@1` event
  (audit + replay via a cursor window), with the Calibrator staying strictly
  measure-only — the same measure→record split as the sentinels. Deliberately
  unsigned in v0 (audit/replay, not a forgery boundary). Locked by
  `calibration-event-is-durable`. Design lock: ADR-0011.

- **First npm publish — v0.2.0** — ✅ done. All 22 packages are on npm via CI
  trusted publishing — the integrated release that wires the eight net-new
  post-v0.1.5 packages (`policy-kernel`, `harness`, `viewer`, `otel-exporter`,
  and the shell/nostr/http/messaging adapters) into the updated `guard`/`cli`.
  A net-new package name needs a one-time manual bootstrap publish before
  trusted publishing can attach, then CI drives every subsequent release.

## Next — interop & contributor-hygiene track

External integrators are starting to build on the read side and the approval
surfaces, so the next tranche makes session transfer and remote approvals
first-class, and locks down contributor/licensing hygiene before
contributions widen. The execution order is fixed (each item lands as its own
PR; ADRs record the design decisions):

1. **Contributor & license hygiene** — a CLA (individual + entity, enforced
   on first PR via the cla-assistant app), a root `NOTICE` file, and a CI
   license-audit job (allowlist of permissive licenses — MIT / Apache-2.0 /
   ISC / BSD / 0BSD / CC0 / Unlicense — failing on anything copyleft).
   Standard OSS hygiene; it lands *first* because a CLA cannot be retrofitted
   onto already-merged third-party contributions.

2. **Sensitivity-gate graduation to core** — ✅ done. `SENSITIVITY_ORDER`,
   `sensitivityRank`, `isAboveCeiling`, the fail-closed unknown handling
   (`isSensitivity`), and the action `data_sensitivity` mapping
   (`contentSensitivityForAction`) moved from `@qmilab/lodestar-otel-exporter`
   into `@qmilab/lodestar-core` (`src/schemas/sensitivity.ts`; they derive from
   core's `SensitivitySchema` already); the otel-exporter keeps re-exports, so
   the move is non-breaking and the two OTel gate probes stay green.
   Prerequisite for items 3 and 5, which apply the same gate to new egress
   paths.

3. **Session shipper (ADR-0014)** — `lodestar ship <session-id> --endpoint
   <url>`: a read-side batch exporter (new package `@qmilab/lodestar-ship`,
   shaped like the otel-exporter) that delivers a session's raw envelopes to
   any compatible collector or viewer as the versioned NDJSON wire format
   `lodestar.session_ship@1`, with the locked sensitivity-ceiling redaction
   applied **client-side, before anything leaves the machine**. Redaction
   preserves the original `payload_hash`, so tamper evidence survives it; the
   envelope schema itself is never touched. Endpoint-agnostic, mirroring
   `lodestar otel export` (`--endpoint` / `--header` / `--out` / `--stdout`;
   bearer token via env, never logged). Probes:
   `ship-respects-sensitivity-ceiling`, `ship-wire-roundtrip`.

4. **`pendingApprovals` graduation to trace** — the pure pending-approvals
   projection moves from `@qmilab/lodestar-viewer` into
   `@qmilab/lodestar-trace` (projection belongs in trace per the viewer's own
   charter); the viewer keeps a re-export, so the move is non-breaking. A
   caller that only wants the approval queue no longer drags in the viewer's
   HTTP server dependency.

5. **Pluggable approval channel (ADR-0015)** — the separate-process approval
   side-channel goes behind an `ApprovalChannel` interface
   (`announce?` / `fetch` / `consume?`). The file channel stays the default
   and reproduces today's behavior byte-for-byte; an HTTP channel
   (operator-pinned endpoint, env-var bearer token) lets a signed resolution
   arrive from a remote approvals surface. The ADR-0010 forgery boundary does
   not move: every fetched resolution is still Ed25519-verified against the
   operator-pinned approver keys before promotion, so any channel can only
   *transport* a signed decision — it cannot mint one. `kind: "http"`
   requires pinned keys and rejects `allow_unsigned` outright. Probes:
   `approval-via-http-channel`, an HTTP case in
   `forged-approval-cannot-execute`, and a credential-never-in-log assertion.

6. **Public-API stability ledger** — [`reference/public-api.md`](reference/public-api.md)
   declares which exported surfaces are stable versus experimental (the
   envelope, the log reader, the chain projection, approval-signature
   verification, the OTLP IR, and the two new wire contracts above), states
   the pre-1.0 semver rule, and is pinned by a `public-api-surface` probe
   that type-asserts the declared-stable exports so a breaking drift fails
   CI.

## What this roadmap explicitly does not include

These are real items, but they belong later than v1:

- **Public marketplace registry** — v1.5+. Requires signing infrastructure.
- **Hosted dashboard** — v2. Requires team workflow design.
- **Compliance exports** (SOC 2, GDPR DSR) — v2+. Requires legal review.
- **Non-MCP runtime adapters** (Hermes, OpenClaw, LangGraph, CrewAI, Flue, Pi) — v1.5+. Each adapter is its own work item; do not block v1. (ADR-0005.) **LangGraph (#83) has landed** — the shared TS spine `@qmilab/lodestar-runtime-core` (`lodestar runtime gate`, ADR-0024/ADR-0025) + the Python `lodestar-langgraph` hook in `runtimes/langgraph/`, locked by the `runtime-gate-enforces-two-phase` (always-on) and `langgraph-tool-calls-are-governed` (runtime-gated) probes. CrewAI (#84) and AutoGen (#85) now collapse to "another thin hook on the same gate + protocol".
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
