# ADR-0002: P1 host sequencing — guard.wrap() first, MCP proxy via synthesized decisions

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Nandan, Claude
- **Related:** ADR-0001, `docs/architecture/policy-kernel.md`, `packages/guard-mcp/src/proxy.ts`

## Context

ADR-0001 establishes one reusable `SentinelArbiter`. What differs between hosts is
the *source of the `decision.made` link* — and the load-bearing sentinels cannot
fire without it:

- **`guard.wrap()` (in-process / greenfield).** The agent runs in-process and can
  **declare** its decision (`belief_dependencies`) through the existing
  `ctx.emit`. The link is agent-truth: precise, no inference.
- **MCP proxy.** The wrapped agent (Claude Code, Cursor, raw MCP clients) speaks
  MCP `tools/call` only — it is **opaque**. It cannot tell the proxy which beliefs
  back the next action. The proxy *does* form the beliefs (it runs the Cognitive
  Core over tool results), but it does not know the agent's dependency edges.

This is a structural limitation of the proxy, not a missing feature: there is no
honest channel for an arbitrary MCP client to declare `belief_dependencies`. The
proxy also supports overlapping calls (capture keyed by action id) and is a
1440-line, concurrency-sensitive file.

A solution for the proxy exists and is not a hack: the proxy can **synthesize** a
`decision.made` linking each action to the beliefs adopted **since the previous
action** — a causal-recency window ("the agent just read these things, then
acted"). It errs toward *over*-linking → over-gating → the safe direction, which is
the correct posture for the adversarial proxy setting (untrusted downstream,
poisoned-document threat model). But the window semantics and the concurrency
interaction are real design questions that deserve their own focused review and
probe — not a footnote inside the guard change.

## Decision

Sequence P1 as two focused PRs behind the one shared bridge:

- **P1a (now) — `guard.wrap()`.** `SentinelArbiter` + guard wiring, where the agent
  **declares** decisions via `ctx.emit("decision.made", …)`. One probe drives the
  **real** `SuspiciousMemoryOriginSentinel` through the **real guard host**: a
  poisoned (`external_document`) file → belief → a declared decision depending on it
  → the next action is held at `pending_approval`; a control action approves; with
  no arbiter, nothing gates.
- **P1b (immediate follow-up) — MCP proxy.** Proxy wiring where the proxy
  **synthesizes** decisions from the causal-recency window, plus its own probe and
  the CLI path that compiles `ProxyConfig.policy` *with* arbitration. The
  `SentinelArbiter` is unchanged between P1a and P1b; only the decision source
  differs. The recency-window synthesis may live in the arbiter as a reusable
  "decision from recent beliefs" helper, so guard can use *declared-when-present,
  else synthesized* and the proxy uses *synthesized*.

## Consequences

- Two clean, independently reviewable PRs. The bridge is built and proven once
  (P1a); the proxy's heuristic is reviewed on its own merits (P1b).
- Sentinel→action gating is **not** in the proxy / Telenotes flow until P1b merges.
  Accepted as a short, explicit gap — P1b is the immediate next step, not "someday".
- The proxy gets a *real* mechanism (synthesized decisions), not a partial
  tool_sequence-only story.
- P1b carries its own open questions (window size, concurrency, how synthesized
  decisions render in `lodestar report`) — to be settled there, with a probe.

## Alternatives considered

- **Both hosts in one PR.** Rejected: mixes two decision-source mechanisms and
  touches the concurrency-sensitive proxy in the same change that introduces the
  bridge — a larger, harder review for no sequencing benefit.
- **Proxy gates on `tool_sequence` alerts only (no synthesis).** Rejected: a
  confusingly partial story (belief-scoped alerts silently never gate in the
  proxy), and `suspicious-memory-origin` still would not fire without
  `decision.made`.
- **Defer the proxy indefinitely.** Rejected: the proxy is the primary proving
  ground (Telenotes), so the proxy path is where the headline safety story has to
  land. P1b is committed as the immediate follow-up, not left open.
