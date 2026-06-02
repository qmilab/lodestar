---
title: "How Lodestar holds the line: the agent-safety threat model"
description: "Part 2 — a closer look at prompt injection and tool poisoning across tools and sessions, the external_document-vs-tool_result boundary in detail, and the trust report as audit evidence."
date: TBD
draft: true
canonical_url: "https://qmilab.com/lodestar/docs/guides/part-2-the-threat-model/"
tags: [ai, llm, security, opensource, ai-agents, mcp]
series: "Lodestar: the trust layer for AI agents"
series_part: 2
---

<!--
PLACEHOLDER — not yet written. Part 2 of the Lodestar walkthrough series.
(Front-matter must stay at the very top or MkDocs renders it as visible text.)
Draft against docs/internal/walkthrough/BRIEF.md (voice + accuracy guardrails)
and review through docs/internal/review/personas/dana-reyes.md plus the
"security evaluator" lens noted there. Keep the public/practitioner voice — the
research framing stays in the arXiv paper (docs/internal/whitepaper/).
-->

# How Lodestar holds the line: the agent-safety threat model

> **Status: planned (placeholder).** This is part 2 of the series that opens with
> [Wrap your coding agent, get a trust report](./walkthrough.md). It hasn't been
> written yet — the outline below is the plan.

**Target reader:** a team evaluating AI-agent safety/security tooling — someone
who already feels the prompt-injection risk and wants the mechanism, the threat
coverage, and the audit story to hold up to scrutiny.

## Planned outline

1. **The threat surface, concretely** — where attacker-controlled text enters a
   coding agent: repo files, code comments, dependency docs, MCP tool output,
   cross-tool and cross-session carryover.
2. **The boundary in detail** — `tool_result` (the call happened → `supported`)
   vs `external_document` (the content → `unverified`), the auto-observation
   gate, and why confidence and truth-status are separate axes.
3. **Attacks, walked** — prompt-injection-cross-tool, tool-poisoning across
   sessions, the poisoned-file hijack attempt; what each probe asserts and what
   it deliberately does *not*.
4. **The trust report as audit evidence** — reading a report to answer "did
   untrusted input ever become trusted?", and what an auditor can verify.
5. **Honest limits** — what is *not* defended (no OS sandbox for executed code;
   sentinels are non-blocking; the built-in-tools-bypass caveat) and why stating
   them is part of the trust story.

## Builds on

- Part 1 — [the walkthrough](./walkthrough.md) (the one idea + both demos).
- Probes: `prompt-injection-cross-tool`, `tool-poisoning-cross-session`,
  `poisoned-file-cannot-hijack-feature-work`, `documentation-evidence-provenance`.
- Threat model: [`../concepts/threat-model/memory-poisoning.md`](../concepts/threat-model/memory-poisoning.md).

_When drafting, hold the accuracy guardrails in
[`../internal/walkthrough/BRIEF.md`](../internal/walkthrough/BRIEF.md) and publish
via [`../internal/walkthrough/PUBLISHING.md`](../internal/walkthrough/PUBLISHING.md)._
