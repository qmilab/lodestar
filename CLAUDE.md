# CLAUDE.md — Lodestar monorepo

Codename `Lodestar`. Open epistemic governance framework for AI agents.
External voice: **trust layer for AI agents**.

**Status**: v0.1.5 published to npm (13 packages via CI trusted
publishing), v0.2 architecture locked. Fourteen probes pass under
strict TypeScript: six firewall probes, three guard / contract
probes, the three pre-Batch-3 fixes (contradiction routing, kernel
context propagation, event-log single-writer), and two new Batch 3
MCP probes (`mcp-proxy-roundtrip`, `mcp-proxy-injection-defense`).
Batches 1, 2, and 3 are complete; `@qmilab/lodestar-guard-mcp` lives
in this repo and will publish to npm in a follow-up mini-marathon.
Subsequent batches are tracked in `docs/roadmap.md`.

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
  memory-firewall/     # (exists) lifecycle axes, retrieval gates, promotion, subject-related contradiction routing
    adapters/
      mem0/            # (exists) mem0 import adapter
      letta/           # (exists) Letta blocks import adapter
      zep/             # (exists) Zep facts import adapter
  cognitive-core/      # (exists) claim extraction, belief adoption, planner, reflection
  cli/                 # (exists) `lodestar` CLI — report, guard wrap, action, trace, probe
  guard/               # (exists) meta-package + guard.wrap() helper
  trace/               # (exists) read side + `lodestar report` CLI
  guard-mcp/           # (exists, Batch 3) MCP proxy mode — `lodestar guard mcp-proxy`
  harness/             # (Batch 4) probes, sentinels, calibrators, replay-lite
  policy-kernel/       # (Batch 4+) trust ladder, action contracts, approvals — stubbed in action-kernel for now
  otel-exporter/       # (Batch 5+) OTel GenAI semantic conventions bridge
  adapters/
    git/               # (exists)
    filesystem/        # (exists)
    github/            # (later)
    shell/             # (later)
    nostr/             # (later)

examples/
  telenotes-governed-dev/    # (exists) reference demonstration; full pipeline
  doc-insight/               # (exists) firewall auto_observation gate demo
  coding-agent-greenfield/   # (exists) guard.wrap() demo on a homegrown agent
  claude-code-wrapped/       # (exists, Batch 3) MCP proxy wrapping a stand-in agent

docs/
  architecture/        # design memos, schema decisions, v0.2 delta with Round 5
  positioning.md       # external voice, four developer entry points
  roadmap.md           # five-batch sequence to v1
  threat-model/        # memory poisoning analysis
  whitepaper/          # outline + drafts
  pitch-deck/          # 12-slide structure
  review/              # adversarial review history (ChatGPT rounds 1-5)

research/
  probes/              # fourteen passing probes (memory-poisoning-basic,
                       #   epistemic-chain-smoke, external-document-not-normal,
                       #   quarantined-not-retrievable, sensitivity-ceiling,
                       #   auto-observation-gate, guard-import-no-self-promote,
                       #   guard-precondition-revalidation,
                       #   guard-contract-invariants, context-policy-
                       #   contradiction-routing, kernel-context-propagation,
                       #   event-log-single-writer, mcp-proxy-roundtrip,
                       #   mcp-proxy-injection-defense)
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
4. Add a probe in `research/probes/` that exercises the new behavior under adversarial conditions.
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
- **Public voice**: "trust layer for AI agents." Internal/research voice: "epistemic governance framework." Do not mix audiences.
- **TypeScript stays the implementation language through v0–v1.** Rust evaluation is post-v1.
- **`@qmilab/lodestar-*` workspace aliases stay for the duration of Batch 2.** The decision about the published npm scope (e.g., `@qmilab/lodestar-*`) is deferred and is mechanical when made.
- **Fourteen probes pass and must keep passing.** Probes are spec, not test scaffolding. Do not edit them to match changed code.

## Quick references

- Architecture: `docs/architecture/v02-delta.md` (read the Round 5 addendum and the naming-history section at the bottom)
- Roadmap: `docs/roadmap.md`
- Positioning: `docs/positioning.md`
- Threat model: `docs/threat-model/memory-poisoning.md`
- Examples: `examples/telenotes-governed-dev/` (full pipeline), `examples/doc-insight/` (firewall gate focus)
- Adversarial review history: `docs/review/` (ChatGPT rounds 1–5)
