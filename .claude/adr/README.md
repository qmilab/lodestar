# Architecture Decision Records (`.claude/adr/`)

Short, durable records of **agent-facing** decisions: how a piece of work is
being approached, what was deliberately deferred, and why. These complement —
they do not replace — the contributor-facing design locks in
`docs/architecture/` (v0.2 delta, policy-kernel, sentinels, …). Rule of thumb:

- **`docs/architecture/`** — the *what* of the system: schemas, invariants, the
  locked design a contributor reads to understand the code.
- **`.claude/adr/`** — the *how/when/why-this-order* of the work: sequencing,
  rollout splits, host-by-host mechanism choices, and the trade-offs behind
  them. The kind of decision that would otherwise live only in a chat transcript.

## Convention

- One decision per file, numbered `NNNN-kebab-title.md` (zero-padded, monotonic).
- Status is one of `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`.
- Never rewrite history: to change a decision, add a new ADR that supersedes the
  old one and flip the old one's status. The record of *why we changed our mind*
  is the point.
- Keep them tight. An ADR is a paragraph of context, the decision, and the
  consequences — not a design doc.

## Template

```markdown
# ADR-NNNN: <title>

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Deciders:** <names>
- **Related:** ADR-NNNN, docs/architecture/<file>, PR #NN

## Context
What forces are in play? What constraint or gap prompted a choice?

## Decision
What we are doing, stated in the active voice.

## Consequences
What becomes easier, what becomes harder, what we accept as a result.

## Alternatives considered
The options we rejected, each with a one-line reason.
```

## Index

- [ADR-0001](0001-sentinel-action-arbitration-bridge.md) — Sentinel→action
  wiring via a stream-driven, host-side `SentinelArbiter` bridge.
- [ADR-0002](0002-p1-host-sequencing-and-proxy-decision-synthesis.md) — P1
  host sequencing: guard.wrap() first (agent-declared decisions), MCP proxy as
  an immediate follow-up (synthesized decisions).
- [ADR-0003](0003-proxy-decision-synthesis-window.md) — MCP-proxy decision
  synthesis: the conservative belief-dependency set (cumulative, never reduced by
  execution — so an opaque agent can't drain its obligations) and honest
  synthesized-decision attribution.
- [ADR-0004](0004-native-shell-adapter-ts-level-sandbox.md) — Native shell adapter
  (P2 slice 1) is a TS-level governance boundary, not an OS sandbox; exposed as a
  config-driven tool factory (per-command trust). git commit/push deferred to the
  github adapter.
