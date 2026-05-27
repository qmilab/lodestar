# Batch 4 — Kickoff Note

This is a session-handoff doc, not a re-spec. The full Batch 4 scope lives in `docs/roadmap.md`. This note exists so the next session can pick up without re-deriving sequencing or re-litigating settled design.

Written 2026-05-27, immediately after Batch 3 stabilised through 22 rounds of Codex review.

---

## Starting state

- `feat/batch-3-mcp-proxy` is green and ready to merge. 23 commits ahead of `main`, 9.2k LOC added, 38 files touched. All 14 probes pass; strict TypeScript holds.
- `packages/guard-mcp/` ships in this repo; npm publish is deferred to a follow-up mini-marathon (intentional — let the code settle in-tree first).
- `packages/harness/` exists as an empty directory placeholder. All 14 probes still live as flat `.ts` files in `research/probes/`.
- The architecture is locked. v0.2 + Round 5 + the three pre-Batch-3 fixes (contradiction routing, kernel context propagation, event-log single-writer) are the schema. Do not relitigate.

## The load-bearing piece

Per the roadmap: **the reflection pass is load-bearing; the rest of Batch 4 hangs off it.**

Two threads converge on reflection:

1. The Round 5 auto-observation gate downgrades `external_document` and `model_inference` evidence to `reflection` authority. Reflection is currently a stub. Until it exists, the gate's "downgrade target" has no semantics, and the firewall invariant "reflection cannot promote to `normal` retrieval alone" has nothing to enforce against.
2. The Batch 4 firewall invariant ("contradicted belief flags dependent decisions") needs the same Decision→Belief dependency-tracking pass that reflection naturally produces.

Design reflection first. Implement it in `packages/cognitive-core/` (not in harness — reflection is cognitive machinery; harness only observes it). Everything else in Batch 4 lands cleanly once reflection has a shape.

## Recommended sequencing

The order below front-loads the load-bearing design and back-loads work that needs accumulated data to validate.

1. **Reflection pass design doc** — `docs/architecture/reflection-pass.md`. No code yet. Resolve the open questions below.
2. **Reflection pass implementation** in `packages/cognitive-core/`. New event type if needed; update schemas in `packages/core/` first per the standard rule.
3. **Probe pack format** — `lodestar.probe-pack.json` manifest schema, loader. Defines the contract external packs will use.
4. **Repackage existing 14 probes** into `packs/lodestar-core/` riding the new loader. Probes themselves do not change.
5. **`packages/harness/` skeleton** — `Probe` base class, runner, `lodestar harness run --pack <name>` CLI subcommand. Probe invocations recorded as `synthetic_probe`-quality observations in the event log (probes auditable from day one).
6. **`Sentinel` base class** + the three sentinels (low-confidence-action, suspicious-memory-origin, anomalous-tool-sequence). In-memory first; persist when a sentinel actually needs cross-session signal.
7. **Postgres `BeliefStore` and `ClaimStore`** — only at the point a sentinel or probe demands it. Specifically, `tool-poisoning-cross-session` will be the forcing function.
8. **Three new probes** — `prompt-injection-cross-tool`, `tool-poisoning-cross-session`, `confidence-drift`. Add to `packs/coding-agent-safety/`, the first non-core pack.
9. **`Calibrator`** — last. Needs accumulated event-log data to validate per-class ECE / Brier. Until then, calibrator code is hypothetical.

Steps 1–2 are sequential (design before code). Steps 3–4 can run in parallel with step 2. Steps 5–6 depend on 3–4. Steps 7–9 depend on 5–6.

## Open design questions — resolve in the design doc, not in code

These are the questions whose answers will shape implementation. None are settled; each deserves a paragraph in the design doc before any reflection code lands.

1. **What triggers reflection?** Event-driven (every `belief.adopted` fans into a reflection pass), scheduled (periodic sweep), on-demand (only when CLI or policy asks), or some hybrid? Trigger model affects whether reflection runs in the hot path or as a tail.
2. **What is reflection's output schema?** Does reflection emit a new `reflection.completed` event type, append a `reflection_pass` evidence quality, or update existing beliefs in place with a `reflection_revision` field? The schema decision propagates into every downstream consumer.
3. **What does reflection actually consume?** The whole event log up to now, a sliding window, a per-session subset, or only the diff since the last reflection pass?
4. **How does reflection cite?** A reflection-derived belief revision needs a citable basis — the simplest model is "reflection observed `event_id`s X, Y, Z and concluded …". That makes reflection a special kind of `EvidenceSet`. Verify this fits cleanly into the existing evidence-quality lattice before committing.
5. **What's the invariant for "reflection alone cannot promote to `normal` retrieval"?** Concretely: if the only evidence supporting a `normal`-retrieval transition is reflection-authority, the firewall must block. Define this as a transition-table rule; do not bury it in `if`-statements.
6. **Probe pack format: bun-installable, npm-installable, or both?** Current packs are plain `.ts` files. External packs eventually want to ship as published npm packages with their own dependencies; the loader needs to handle that. v0 of the format should be future-compatible.
7. **Sentinel execution model.** Synchronous in the event loop (back-pressures the kernel — risky), async tail of the event stream (eventual-consistent), or in-process worker thread? Affects whether a sentinel can *block* an action or only *alert* on one. The roadmap says sentinels emit `sentinel.alerted` events — that implies non-blocking — but confirm before building.

## Out of scope (do not let scope drift here)

- **Public registry, signed pack manifests, hosted dashboard, multi-tenant control plane.** v1+. The roadmap is explicit.
- **HTTP transport for the MCP proxy.** Stays stdio-only in v0.
- **Cross-process file-locked event log.** Single-process discipline holds for v0 — the per-partition mutex covers in-process fan-out, which is the only mode Guard and the MCP proxy use today.
- **Non-MCP runtime adapters (Hermes, OpenClaw, LangGraph, CrewAI).** v1.5+. Each is its own batch.
- **Editing the 14 existing probes.** Probes are spec, per `CLAUDE.md`. Move them, repackage them, but do not rewrite them to match changed code. New behaviour gets new probes.
- **Re-deriving v0.2 schema decisions.** Four orthogonal memory axes stay orthogonal. The auto-observation gate stays a Round 5 invariant. Do not collapse, do not soften.

## Effort estimate

Roadmap says ~1.5 weeks once the reflection pass design is locked. The reflection design itself is the unbounded piece — budget a focused session for the design doc alone before estimating the rest.

## What to read first when starting the next session

1. This file.
2. `docs/roadmap.md` — Batch 4 section.
3. `docs/architecture/v02-delta.md` — Round 5 addendum and the auto-observation gate definition.
4. `packages/cognitive-core/` — current ingestion orchestrator and evidence linker; reflection slots in next to these.
5. `research/probes/auto-observation-gate.ts` — the existing test of the gate behaviour reflection must respect.
