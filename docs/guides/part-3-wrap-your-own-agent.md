<!--
PLACEHOLDER — not yet written. Part 3 of the Lodestar walkthrough series.
Draft against docs/internal/walkthrough/BRIEF.md (voice + accuracy guardrails)
and review through docs/internal/review/personas/dana-reyes.md plus the
"integrating developer" lens noted there. Every snippet must run as written.
-->
---
title: "Wrap your own agent: guard.wrap(), the MCP proxy, policies, and probes"
description: "Part 3 — a hands-on guide to putting Lodestar around your own coding agent: the library path, the proxy path, writing a policy, and locking an invariant with a probe."
date: TBD
draft: true
canonical_url: "https://qmilab.com/lodestar/docs/guides/part-3-wrap-your-own-agent/"
tags: [ai, llm, security, opensource, ai-agents, mcp]
series: "Lodestar: the trust layer for AI agents"
series_part: 3
---

# Wrap your own agent: guard.wrap(), the MCP proxy, policies, and probes

> **Status: planned (placeholder).** This is part 3 of the series that opens with
> [Wrap your coding agent, get a trust report](./walkthrough.md). It hasn't been
> written yet — the outline below is the plan.

**Target reader:** a developer who wants to put Lodestar around *their* agent
today. Every snippet must run as written.

## Planned outline

1. **Two ways in** — `guard.wrap()` for an agent loop you own vs.
   `lodestar guard mcp-proxy` for an agent you don't (Claude Code, Cursor,
   Aider). When to pick which.
2. **The greenfield path** — wrapping a loop with `guard.wrap()`, the
   `cognitive.evidenceLinkerFactory` seam, and reading the resulting report.
3. **The proxy path** — pointing an existing agent's MCP config at the proxy,
   the two-downstream-server pattern, and the built-in-tools-bypass caveat
   (deny native file/exec tools so the proxy is the only path).
4. **Writing a policy** — the trust ladder, `tool_defaults`, and an
   auto-approve-up-to-N gate with an approval step for L4.
5. **Locking an invariant with a probe** — write a probe that fails if your
   guarantee regresses; wire it into a pack and `lodestar harness run`.

## Builds on

- Part 1 — [the walkthrough](./walkthrough.md) (both adoption shapes in action).
- Examples: `examples/documentation-agent/` (greenfield `guard.wrap()`),
  `examples/telenotes-governed-dev/` (the MCP proxy end to end).
- Reference: the probe-pack format and `lodestar harness run`.

_When drafting, hold the accuracy guardrails in
[`../internal/walkthrough/BRIEF.md`](../internal/walkthrough/BRIEF.md) and publish
via [`../internal/walkthrough/PUBLISHING.md`](../internal/walkthrough/PUBLISHING.md)._
