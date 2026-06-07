# CLAUDE.md — Lodestar monorepo

Codename `Lodestar`. Open epistemic governance framework for AI agents.

**Status**: v0.1.5 published to npm (13 packages via CI trusted
publishing), v0.2 architecture locked. Forty-five probes pass under
strict TypeScript (one needs a Postgres test database — see
below). Forty-one live in the first-party pack
`packs/lodestar-core/`: six firewall probes, three guard / contract
probes, the three pre-Batch-3 fixes (contradiction routing, kernel
context propagation, event-log single-writer), two Batch 3 MCP probes
(`mcp-proxy-roundtrip`, `mcp-proxy-injection-defense`), three
Batch 4 probes (`reflection-cannot-promote-to-normal-alone`,
`contradicted-belief-flags-dependent-decisions`,
`event-log-canonical-hash`), one Batch 5 probe
(`documentation-evidence-provenance`), and thirteen Policy Kernel probes —
the three-valued gate, the trust-ladder floor, the approval lifecycle,
signature verification, the arbitrate hook, and the host wiring — the
`guard.wrap()` approval-resolver seam, the MCP-proxy deadline/timeout
hold path, the separate-process `lodestar approve` side-channel
resolver, and the proxy compiling a declarative `CompiledPolicy` (from a
signed `ProxyConfig.policy` document) so a matched `require_approval`
rule's `required_authority` (`min_trust_baseline` / `scope`) reaches its
holds
(`l4-action-requires-approval`, `l4-floor-preserves-stricter-rule`,
`pending-approval-cannot-execute`, `ladder-floor-overrides-allow-rule`,
`unmatched-action-defaults-to-deny`, `policy-version-signature-required`,
`granted-approval-still-revalidates-preconditions`,
`sentinel-alert-gates-dependent-action`,
`calibration-flag-escalates-action`,
`guard-hold-resolves-via-resolver`, `approval-timeout-denies`,
`approval-via-side-channel`, `proxy-hold-carries-rule-authority`), one
Governing-UI read-side probe (`viewer-is-read-only` — the read-side
viewer surfaces the chain + pending approvals but exposes no mutation
route and never writes the log), two OTel-exporter probes
(`otel-export-respects-sensitivity-ceiling`,
`otel-export-projects-action-spans`), and the two host-side sentinel→action
wiring probes — `guard-arbiter-gates-dependent-action` (a real
`suspicious-memory-origin` alert, run by the `guard.wrap()`
`SentinelArbiter` over the session's own event stream, holds the
dependent action at `pending_approval` through the host; ADR-0001) and
`mcp-proxy-arbiter-gates-dependent-action` (the **MCP-proxy** analogue —
the opaque agent cannot declare decisions, so the proxy *synthesizes* a
`decision.made` from the arbiter's conservative observed-belief set, and a
poisoned downstream read then holds the dependent `tools/call`; ADR-0002 / ADR-0003),
one shell-adapter probe (`shell-adapter-enforces-sandbox-invariants` — the
native `@qmilab/lodestar-adapter-shell` holds its TS-level invariants through the
kernel: no host-env passthrough, allowlist + argv-only no-injection, wall-clock
timeout, and bounded output capture; ADR-0004), and one git-adapter egress probe
(`git-adapter-enforces-egress-invariants` — the native forge-agnostic git transport
in `@qmilab/lodestar-adapter-git` holds its egress invariants through the kernel: a
push proposed at L4 stays at `pending_approval` until approved then lands in the
**operator-pinned** remote despite a poisoned `.git/config`, the configured credential
never surfaces in inputs/observation, a non-allowlisted clone source and an escaping
destination both fail, and host author-env does not leak; ADR-0006), and one
nostr-adapter transport probe (`nostr-adapter-enforces-egress-invariants` — the
native `@qmilab/lodestar-adapter-nostr` holds its invariants through the kernel:
`nostr.publish` proposed at L4 stays at `pending_approval` until approved then lands
a BIP-340-verifiable note at the **operator-pinned** relay, the signing key never
surfaces in inputs/observation, a non-pinned relay and a non-allowlisted event kind
both fail, NIP-42 AUTH is handled with the same key, and `nostr.fetch` flags forged
signatures + pins reads against SSRF; ADR-0007), and one http-adapter transport
probe (`http-adapter-enforces-egress-invariants` — the native
`@qmilab/lodestar-adapter-http` holds its invariants through the kernel:
`http.request` proposed at L4 stays at `pending_approval` until approved then
delivers its body to the **operator-pinned** host, an approved request to a
non-pinned host fails and the decoy gets nothing, a pinned host that redirects to a
non-pinned host (`localhost` — the SSRF escape) is not followed, a `file://` fetch
fails the scheme allowlist, the operator credential reaches the server but never
surfaces in inputs/observation, and an oversized untrusted body is captured to the
cap and flagged truncated; the first adapter to hit injection + egress + untrusted
content at once; ADR-0008), and one messaging-adapter egress probe
(`messaging-adapter-enforces-egress-invariants` — the native
`@qmilab/lodestar-adapter-messaging` holds its invariants through the kernel:
`slack.post` proposed at L4 stays at `pending_approval` until approved then
delivers to the **operator-pinned** channel, an approved post to a non-pinned
channel and an approved `email.send` to a non-allowlisted recipient both fail with
the provider untouched while an allowlisted-by-domain recipient lands carrying the
**operator-fixed** From, the operator bot token reaches the provider but never
surfaces in inputs/observation even when echoed back, a Slack `ok:false` ends
`failed` rather than a silent completed, and an oversized provider response is
captured to the cap; the fourth native egress and the purest human-approval demo —
egress-only this slice; ADR-0009).
The other four live in the first non-core
pack `packs/coding-agent-safety/`: `prompt-injection-cross-tool`,
`tool-poisoning-cross-session`, `confidence-drift`, and the Batch 5
`poisoned-file-cannot-hijack-feature-work` (the governed-dev no-hijack
invariant). The
`tool-poisoning-cross-session` probe exercises the proxy's
Postgres backend across two sessions, so it needs a real database: it
reads `LODESTAR_TEST_DATABASE_URL` and skips with a loud banner when
that is unset; CI runs it against a `postgres:16` service.
All load through the `@qmilab/lodestar-harness` pack loader; `lodestar
harness run --pack <name>` drives a pack, `probes:all` points at
`lodestar-core` and `probes:safety` at `coding-agent-safety`. Batches 1–4
are complete (reflection pass, probe-pack format,
probe repackaging, the `Probe` base class + pack runner + `lodestar
harness run` CLI, the `Sentinel` base class + the three sentinels
— `low-confidence-action`, `suspicious-memory-origin`,
`anomalous-tool-sequence` —, the first `coding-agent-safety` probe
`prompt-injection-cross-tool`, the Postgres-backed belief/claim/evidence
stores, `tool-poisoning-cross-session` together with the
proxy/`guard.wrap()` Postgres wiring it rides on, and now the
`Calibrator` (per-class ECE / Brier / calibration-gap tables) together
with the `confidence-drift` probe it gates, and finally the three
sentinels folded into the `coding-agent-safety` pack — the manifest
declares them under a `sentinels` field and the loader resolves each id
against the first-party `FIRST_PARTY_SENTINELS` registry — have all
landed). `@qmilab/lodestar-guard-mcp` and the post-v1 read-side
`@qmilab/lodestar-viewer` (the Governing UI, `lodestar view`) live in this
repo and will publish to npm in a follow-up mini-marathon.
Batch 5 (week-8 thesis demo) has landed — all of Batches 1–5 are complete. The secondary
documentation-agent proving ground has landed
(`examples/documentation-agent/`) — it exercises the claim/evidence chain
on documentation content via a `DocumentationExtractor` +
`DocAwareEvidenceLinker` in `@qmilab/lodestar-cognitive-core`, the
`doc.read` tool in `@qmilab/lodestar-adapter-filesystem`, and a new
`GuardConfig.cognitive.evidenceLinkerFactory` seam on `guard.wrap()`. The
**Telenotes primary proving ground has also landed**
(`examples/telenotes-governed-dev/`): a deterministic in-process agent drives
the Batch-3 MCP proxy through a real feature task on a small Nostr-note fixture
— observe → decide → edit → test → commit → blocked-L4-push → revise — over two
live downstream MCP servers (the official filesystem server for read/write and
a first-party `dev-tools-mcp/` server for `shell_test`/`git_commit`/`git_push`),
with `lodestar report` rendering the full epistemic chain (committed under
`reports/`). A second `poison-run/` plants a hostile `DEVELOPMENT.md` and
self-verifies the firewall holds (poison stays `external_document`/`unverified`,
never enters trusted context, the L4 push stays blocked), locked in CI by the
`poisoned-file-cannot-hijack-feature-work` probe. A `real-claude-code/` recipe
+ proxy configs drive the same proxy with a live Claude Code session (the
built-in-tools-bypass caveat handled by denying Edit/Write/Bash); its captured
evidence has been recorded (committed under `real-claude-code/captured/`). The
Batch 5 blog/video walkthrough has also shipped — the reader guide is
`docs/guides/walkthrough.md`, published to the docs site at qmilab.com/lodestar/docs.
Post-v1 work is tracked in `docs/roadmap.md`.

This file is the entry point for any agent working in this repository. Read this first, then `docs/architecture/v02-delta.md` for current schema (note the Round 5 addendum and the naming-history section at the bottom), then the relevant package's `CLAUDE.md` for implementation details.

## What this project is

Lodestar is a TypeScript library and reference framework for governed agentic cognition. It sits above agent runtimes (OpenClaw, Hermes, Claude Code, raw LLMs with tools) and tracks the epistemic chain:

```
Observation → Claim → EvidenceSet → Belief → Decision → Action → Outcome → Revision
```

Each link is a first-class type. Governance components (Action Kernel, Policy Kernel, Memory Firewall, Harness) exist to protect and instrument the chain.

## What this project is not

- Not an agent runtime. Use OpenClaw, Hermes, Claude Code, or raw LLMs underneath.
- Not an observability platform. Exports OTel-compatible traces; pair with Langfuse or Phoenix.
- Not a workflow builder, chat UI, or canvas.

## The thesis

An agent cannot safely act unless Lodestar can show:
- what it observed,
- what it claimed,
- what it believed,
- why it decided,
- what policy allowed,
- what happened,
- and how the system revised itself afterward.

Everything in this repo serves that thesis. Code that does not serve it does not belong here.

## Repository layout

Packages marked **(exists)** are implemented and present. Packages marked
**(Batch 2)** are scheduled for the current work cycle. Packages marked
**(later)** are downstream batches.

```
packages/
  core/                # (exists) types, schemas, epistemic chain primitives
  event-log/           # (exists) envelope, NDJSON writer/reader, snapshots
  action-kernel/       # (exists) tool registry, two-phase execution, sandbox
  memory-firewall/     # (exists) lifecycle axes, retrieval gates, promotion, subject-related contradiction routing; in-memory + Postgres (Bun.SQL) store backends
    adapters/
      mem0/            # (exists) mem0 import adapter
      letta/           # (exists) Letta blocks import adapter
      zep/             # (exists) Zep facts import adapter
  cognitive-core/      # (exists) claim extraction, belief adoption, planner, reflection
  cli/                 # (exists) `lodestar` CLI — report, guard wrap, action, trace, probe
  guard/               # (exists) meta-package + guard.wrap() helper; in-process ApprovalResolver seam for held actions; re-exports the graduated autoApprovePolicy from policy-kernel; SentinelArbiter + compileWithSentinels wire the harness sentinels into the gate's arbitrate hook (sentinel→action, ADR-0001); arbiter also exposes observedBeliefIds() — the conservative observed-belief set guard-mcp reads to synthesize decisions for its opaque agent (cumulative, never reduced by execution; ADR-0003)
  trace/               # (exists) read side + `lodestar report` CLI
  viewer/              # (exists, post-v1) read-side Governing UI — `lodestar view`; Elysia + no-build vanilla SPA over the log; strictly read-only (no mutation route, never writes the log); surfaces pending approvals for visibility only
  guard-mcp/           # (exists, Batch 3) MCP proxy mode — `lodestar guard mcp-proxy`; held L4 actions wait up to `approval_timeout_ms` polling for an out-of-band `approval.granted@1`, else synthetic `approval_timeout`; optionally wires a SentinelArbiter (config.sentinels) and synthesizes a decision.made per action from the recency window so a belief-scoped alert holds the dependent tools/call — opaque-agent decision source (ADR-0003)
  harness/             # (exists, Batch 4) probe-pack loader (probes + sentinel-id resolution) + Probe base class + pack runner (lodestar harness run) + Sentinel base class + three sentinels + FIRST_PARTY_SENTINELS registry + Calibrator (per-class ECE/Brier)
  policy-kernel/       # (exists) compile(policy)→PolicyGate: trust-ladder floor, three-valued gate (allow/deny/hold), approval lifecycle, arbitrate hook (host-injected sentinel-alert + calibration-flag + synchronous low-confidence escalation; strengthens only). host wiring landed for all three paths: the in-process (guard.wrap() resolver seam), MCP-proxy (deadline/timeout out-of-band hold path), and the separate-process `lodestar approve` CLI (writes a side-channel the proxy promotes; proxy stays sole event-log writer)
  otel-exporter/       # (exists, post-v1) OTel GenAI semantic conventions bridge — `lodestar otel export`; read-side batch projection of a session into OTLP/HTTP-JSON spans (action-centric: invoke_agent root + execute_tool spans), hand-rolled wire format (no OTel SDK dep), with the sensitivity-ceiling export gate (content above the ceiling ships as metadata + payload hash only)
  adapters/
    git/               # (exists, P2) read-only git.status + forge-agnostic transport (git.commit/push/clone); push is the first native egress (L4); remote pinning + scoped credentials (askpass, no argv); TS-level boundary, not an OS sandbox; ADR-0006
    filesystem/        # (exists)
    shell/             # (exists, P2) governed shell commands; config-driven tool factory (defineShellTool), TS-level sandbox (argv-only, allowlist, scoped env, timeout) — not an OS sandbox; ADR-0004
    github/            # (later) forge-API ONLY (PRs/issues/releases) behind a ForgeProvider seam — git transport lives in adapters/git/ (ADR-0006)
    nostr/             # (exists, P2) governed Nostr transport: nostr.publish (L4, second native egress — signing key IS the credential, in-process BIP-340) + nostr.fetch (L1, untrusted inbound); relay pinning, kind allowlist, NIP-42 AUTH, fetch SSRF guard; controlled-network sandbox; TS-level boundary, not network containment; ADR-0007
    http/              # (exists, P2) governed HTTP transport: http.request (L4, third native egress — host-bound auth header credential) + http.fetch (L1, untrusted inbound, the injection vector); hostname pinning + scheme allowlist + per-hop redirect re-validation (the SSRF escape) + bounded capture; reuses controlled-network; TS-level boundary, not network containment; ADR-0008
    messaging/         # (exists, P2) governed messaging transport: slack.post + email.send (both L4, fourth native egress — the purest human-approval demo); destination pinning (channel allowlist / recipient address+domain allowlist — the exfil guard), operator-fixed endpoint+sender (no agent host → no SSRF; no From spoofing), scoped header credential, no redirect following, send delivery semantics (non-2xx / Slack ok:false → failed); egress-only this slice; reuses controlled-network; TS-level boundary, not network containment; ADR-0009

examples/
  telenotes-governed-dev/    # (exists) reference demonstration; full pipeline
  doc-insight/               # (exists) firewall auto_observation gate demo
  coding-agent-greenfield/   # (exists) guard.wrap() demo on a homegrown agent
  claude-code-wrapped/       # (exists, Batch 3) MCP proxy wrapping a stand-in agent
  documentation-agent/       # (exists, Batch 5) doc-agent; claim/evidence over docs,
                             #   DocAwareEvidenceLinker via the guard cognitive seam

packs/
  lodestar-core/             # (exists, Batch 4) first-party probe pack: 40 probes +
                             #   lodestar.probe-pack.json manifest; loads via @qmilab/lodestar-harness
  coding-agent-safety/       # (exists, Batch 4) first non-core pack; ships
                             #   prompt-injection-cross-tool, tool-poisoning-cross-session,
                             #   and confidence-drift, plus all three sentinels declared
                             #   under the manifest's `sentinels` field (resolved by id)

docs/
  guides/              # reader-facing guides (the walkthrough + series)
  concepts/            # evergreen explainers (e.g. threat model)
  architecture/        # design memos, schema decisions, v0.2 delta with Round 5
  roadmap.md           # batch sequence to v1
  internal/            # planning & production, not for the docs site:
                       #   review/, whitepaper/, pitch-deck/, and walkthrough/
                       #   (BRIEF, video script, dev.to syndication copy)

research/
                       # probes/ moved to packs/lodestar-core/probes/ in Batch 4 —
                       #   the probes now ship as a loadable pack, not loose files
  benchmarks/          # (later) reproducible evaluation
  datasets/            # (later) logged event traces for analysis
```

## Stack invariants

- **Runtime and package manager:** Bun. Not Node, not pnpm.
- **Language:** TypeScript, strict mode.
- **Schema validation:** Zod. Every public API takes Zod-validated input and returns Zod-validated output.
- **Persistence:** PostgreSQL for structured state, NDJSON for the event log, optional pgvector for memory embeddings.
- **HTTP:** Elysia where HTTP is needed.
- **Tracing:** OpenTelemetry GenAI semantic conventions.
- **License:** Apache 2.0 throughout the public repo.

## Coding norms

- Every public type lives in `packages/core` and is exported through `@qmilab/lodestar-core`.
- Every package has its own `CLAUDE.md`, `README.md`, `package.json`, and `tsconfig.json` extending the root `tsconfig.base.json`.
- No package imports from another package via relative path. All cross-package imports use the `@qmilab/lodestar-*` workspace alias.
- No Telenotes-specific code in `packages/`. Telenotes-aware code lives only in `examples/telenotes-governed-dev/`.
- No silent defaults for security-relevant settings. Sandbox profile, sensitivity ceiling, trust level are explicit in every action contract.
- No `console.log` in production code paths. Use the event log for observability.

## How to work in this repo

When implementing a feature:

1. Check the v0.2 delta (`docs/architecture/v02-delta.md`) for the authoritative schema.
2. Define or update the Zod schema in `packages/core` first.
3. Implement the runtime behavior in the relevant package.
4. Add a probe in `packs/lodestar-core/probes/` that exercises the new behavior under adversarial conditions, and declare it in `packs/lodestar-core/lodestar.probe-pack.json`.
5. Update the package's `CLAUDE.md` if behavior changed.

When refactoring:

- Do not collapse the orthogonal memory lifecycle axes back into one enum. Truth, retrieval, security, and freshness are deliberately separate.
- Do not allow agent-written memories to self-promote. The Memory Firewall promotion gate is not a suggestion.
- Do not bypass the Action Kernel's two-phase execution. Tools that need to do work before approval are bugs.
- Do not pass host environment variables through to shell sandboxes. Use scoped, declared variables only.

## Slash commands

`.claude/commands/` defines reusable agent commands:

- `/lodestar-report <session_id>` — produce the full epistemic chain report for a session (wraps `lodestar report` CLI).
- `/lodestar-probe <probe_name>` — run a specific harness probe.
- `/lodestar-calibrate <calibration_class>` — produce a calibration table (Batch 4+).
- `/lodestar-explain <event_id>` — generate a human-audience Explanation for any governed event.

## Locked decisions (do not relitigate)

These are settled. If a session starts to question them, redirect it.

- **Architecture is locked at v0.2 + Round 5 fixes.** Schema in `packages/core/` is not open for change without a separate architectural session.
- **Four orthogonal memory lifecycle axes**: truth, retrieval, security, freshness. Do not collapse.
- **Auto-observation gate**: `external_document` and `model_inference` evidence cannot promote a claim to `truth_status: supported` automatically. Round 5 invariant.
- **CLI naming**: `lodestar report <session-id>` is the headline command. Not `lodestar trace report`.
- **TypeScript stays the implementation language through v0–v1.** Rust evaluation is post-v1.
- **`@qmilab/lodestar-*` workspace aliases stay for the duration of Batch 2.** The decision about the published npm scope (e.g., `@qmilab/lodestar-*`) is deferred and is mechanical when made.
- **Forty-two probes pass and must keep passing.** Probes are spec, not test scaffolding. Do not edit them to match changed code. (One, `tool-poisoning-cross-session`, needs a Postgres test database via `LODESTAR_TEST_DATABASE_URL`; it skips cleanly — exit 0 with a loud banner — when that is unset, and runs for real in CI.)

## Quick references

- Architecture: `docs/architecture/v02-delta.md` (read the Round 5 addendum and the naming-history section at the bottom)
- Roadmap: `docs/roadmap.md`
- Threat model: `docs/concepts/threat-model/memory-poisoning.md`
- Examples: `examples/telenotes-governed-dev/` (full pipeline), `examples/doc-insight/` (firewall gate focus)
- Walkthrough (reader guide): `docs/guides/walkthrough.md`
