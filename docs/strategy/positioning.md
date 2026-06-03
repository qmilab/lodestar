# Lodestar — Positioning

This document captures the strategic framing decisions for Lodestar: what it is, who it's for, where it sits among existing tools, and how the open-source/commercial boundary is drawn. It complements but does not replace the architecture memos in `docs/architecture/`.

Last updated: v0.2 (post-strategy review with ChatGPT).

---

## 1. Two-layer positioning

Lodestar has two distinct audiences, and the words we use to describe it must differ for each.

### External (developers, adopters, enterprises)

> **Lodestar is the trust layer for AI agents.** (The project was
> developed under the codename Orrery; see
> `docs/architecture/v02-delta.md` for the naming history.)
>
> Know what your agent believed, why it acted, and whether it was right.

This is the homepage voice. It uses concrete words that map to existing developer pain. It does not require the reader to already understand "epistemic governance" or any related research terminology.

Slightly longer for landing pages:

> Lodestar wraps your agent so every tool call leaves an audit trail of what the agent observed, what it came to believe, and which beliefs informed which actions. Risky actions go through policy. Memory is governed. Outcomes are tracked.

### Internal (research, whitepapers, academic citations)

> **Lodestar is an epistemic governance framework for agentic systems.**

This phrase is accurate and load-bearing in the research arc. It captures the architecture's actual claim: governance applies not only to actions, but to the epistemic state — claims, evidence, beliefs, decisions, revisions — that produces those actions. It belongs in the whitepaper, citations, and conversations with people who already think in this vocabulary.

### Why both?

A category-defining product needs an outside voice that is easy to adopt and an inside voice that is rigorous enough to defend. Stripe is "payments for developers" externally and "PCI-compliant payment orchestration platform" internally. LangSmith is "debug and monitor LLM apps" externally and a "control plane for LLM application development" internally. The two voices reinforce each other; they do not conflict.

---

## 2. The category

Lodestar is in a category that is being assembled in real time. It overlaps with — but is not — observability, memory management, agent runtime, or governance tooling. The cleanest framing is **trust infrastructure for agent systems**: the layer that makes the other layers' behavior accountable.

| Category | Examples (early 2026) | Their value | Lodestar's relationship |
| --- | --- | --- | --- |
| **Agent runtime** | OpenClaw, Hermes, CrewAI, LangGraph, Claude Code, Mastra | Agents act and use tools | Lodestar wraps and governs their actions |
| **Memory** | mem0 (~48K stars), Letta/MemGPT, Zep, Cognee | Agents remember | Lodestar governs what is safe to remember and retrieve |
| **Observability** | LangSmith, Langfuse, Phoenix, Braintrust, Datadog | Teams debug and evaluate agents | Lodestar exports traces and adds epistemic semantics |
| **Governance / security** | MS Agent Governance Toolkit, MCP gateways, scanning tools | Gate tools and enforce policy | Lodestar extends governance to beliefs, memory, skills, confidence |
| **Skills / plugins** | Claude Skills, MCP servers, plugin marketplaces | Reusable capabilities | Lodestar verifies, signs, scores, and policy-wraps them |

The market positioning is **complementary**, not replacement:

- *Use LangSmith to see traces. Use Lodestar to know whether the agent was allowed to believe and do what it did.*
- *Use mem0 for memory. Use Lodestar to govern memory promotion and retrieval.*
- *Use Claude Code or OpenClaw to run the agent. Use Lodestar to make its actions and memories trustworthy.*

This framing matters because attempting to displace LangSmith, mem0, or any major agent runtime would be a losing battle in 2026. The space is consolidating around proven leaders in each category. Lodestar's leverage is the *missing* category — trust — and the integrations that connect it to the existing ones.

---

## 3. The four developer entry points

The architecture exposes itself through four developer-facing packages. Each can be adopted independently; together they form the full stack.

### Lodestar Guard — the write side

Wraps agent tool calls. Captures observations. Records claims/beliefs/decisions. Gates risky actions. This is the first thing most developers will adopt because it solves a visible pain (debug-by-staring-at-logs) without requiring a rewrite of the agent runtime.

**Two adoption shapes:**

- **Greenfield (library)**: `guard.wrap()` in `@qmilab/lodestar-guard`. Best for new agents the developer owns end-to-end. Drop the wrap call around the agent loop; every tool invocation flows through the Action Kernel.
- **Existing MCP agent (proxy)**: `lodestar guard mcp-proxy --config <path>` from `@qmilab/lodestar-guard-mcp`. Best for wrapping an agent the developer doesn't own: Claude Code, Cursor, Aider, anything that speaks MCP. The proxy sits between the agent and its downstream MCP servers; the agent talks to it as if it were the tool surface. No code changes to the agent — just point its MCP server list at the proxy.

The Batch 3 MCP proxy ships with the auto-observation gate from Round 5 wired in: text content inside an MCP tool result is recorded as `external_document` evidence and cannot auto-promote to `truth_status: supported`, defending against prompt-injection content surfaced through tool calls.

### Lodestar Trace — the read side

Consumes the event log and produces "why did the agent do this?" reports. Markdown, HTML, or piped exports to LangSmith / Langfuse / Phoenix. Same data as Guard; different command. The package name is `@qmilab/lodestar-trace`; the user-facing CLI command is `lodestar report` (explanation-focused, not tracing-tool-collision).

**Adoption shape**: CLI command (`lodestar report`), web viewer, OTel exporter.

### Lodestar Memory Firewall — the memory governance entry point

A horizontal package that governs which beliefs are adopted, retrieved, quarantined, or blocked. Plugs into existing memory layers (mem0, Letta, Zep) without replacing them. Persistent memory layers improve continuity, but they do not by themselves answer the separate governance question: which memories should be trusted, retrieved, quarantined, or blocked. The Memory Firewall fills that gap.

**Adoption shape**: library integration with adapter for each memory backend. Can be adopted standalone by teams who keep their existing memory layer but want a firewall in front.

### Lodestar Harness — the test side

Probes, sentinels, and calibrators. Safety tests, runtime monitors, and confidence-vs-outcome measurement. Designed to be the marketplace entry point (see §5).

**Adoption shape**: CLI test runner, pack format, scheduled sentinel runtime.

---

## 4. Open-source strategy (Model A: Langfuse-style)

There are three viable open-source patterns in the agent/LLMOps space. Lodestar follows **Model A** (Langfuse).

### Model A — Open core with hosted product (Langfuse)
Open-source primary, self-hostable, with hosted/team/compliance features as commercial offerings. Open source drives adoption and trust; hosted features monetize. **Best fit for Lodestar** because trust products require inspectability, and the research arc requires legitimacy.

### Model B — Mostly hosted / commercial control plane (LangSmith)
Platform-first with self-hosted as a secondary option. Requires existing category pull. Not the right starting point for a new category like trust.

### Model C — Open-source infra + managed service (mem0)
Open code, hosted convenience. Similar to Model A but with less emphasis on inspectability of the local runtime.

### What is Apache 2.0
- All schemas (`@qmilab/lodestar-core`)
- Append-only event log (`@qmilab/lodestar-event-log`)
- Action kernel and policy language (`@qmilab/lodestar-action-kernel`)
- Memory firewall, including all four lifecycle axes (`@qmilab/lodestar-memory-firewall`)
- Cognitive core (`@qmilab/lodestar-cognitive-core`)
- Guard, Trace, Harness packages
- All first-party adapters (Git, GitHub, filesystem, shell, MCP, mem0, Letta, Zep, Langfuse, Phoenix, OTel)
- Basic replay capability — replaying events from the NDJSON log
- Example policy packs, probe packs, and research benchmarks

### What is reserved for future commercial offering
- Hosted dashboard with team views
- Approval workflows for L4+ actions across a team
- Compliance exports (SOC 2, GDPR data subject requests)
- Advanced replay UI (multi-session diff, counterfactual replay, lineage graphs)
- Enterprise policy packs (HIPAA, GDPR, SOX-aligned packs)
- Managed marketplace registry and verification
- Org-wide knowledge governance dashboards
- Multi-project control plane

**Critical constraint**: nothing in the commercial layer gates the developer-adoption workflow. A solo developer using Lodestar's open-source surfaces gets a complete, working trust layer. The commercial layer adds team operations and compliance reporting on top.

---

## 5. Marketplace strategy: trust packs, not skill packs

A skill marketplace would put Lodestar into a crowded and risky category (Claude Skills, Cursor rules, GPT actions, MCP plugin registries). Worse, skill marketplaces inherit supply-chain risk — every skill is executable capability with unknown effects. The compromised state of various plugin registries (most prominently the ClawHub supply-chain incident) is a cautionary precedent.

Lodestar's marketplace is **trust artifacts**, not capability artifacts.

### Marketplace categories

1. **Policy packs** — reusable governance policies (e.g., "GitHub PR safe mode", "production deployment policy", "never expose secrets")
2. **Probe packs** — safety tests (e.g., "memory poisoning probe suite", "MCP tool-poisoning probes", "prompt-injection probes")
3. **Sentinel packs** — runtime monitors (e.g., "secret leakage sentinel", "low-confidence action sentinel", "anomalous tool sequence sentinel")
4. **Adapter packs** — connectors with signed manifests (e.g., "Claude Code adapter", "LangGraph adapter", "Slack adapter")
5. **Signed/verified skill manifests** — *not skills themselves*. Manifests carrying declarations of permissions, known effects, required trust level, probe results, security scan status

### Marketplace sequencing

| Phase | Marketplace object |
| --- | --- |
| v0 (current) | Local examples in this repo only |
| v0.2 | Curated policy/probe packs in this repo |
| v1 | Public registry for policies, probes, adapters |
| v1.5 | Signed manifests and verification badges |
| v2 | Paid enterprise policy/probe packs (commercial) |

**Do not build the marketplace before v1.** A public registry requires signing infrastructure, verification process, and a community trust model. Shipping it early invites supply-chain failures.

---

## 6. First-user persona and headline use case

The first wide use case Lodestar solves is **coding-agent safety**.

> Use Lodestar Guard with your coding agent (Claude Code, Cursor, Aider, OpenClaw, Codex) to know what it believed, why it acted, and whether it was right.

Why coding agents:
- The pain is visible and immediate (agents writing wrong code, dropping commits, breaking CI, deploying to wrong environment)
- The audience is technical and reachable through GitHub / dev.to / HN
- The artifacts (PRs, diffs, test results) are easy to grade
- Memory-poisoning attacks on coding agents are an active research area
- Existing coding agents do not have a trust layer — there is a gap to fill

Telenotes — a Nostr publishing platform — is the first non-trivial proving ground for Lodestar. The headline framing is "wrap a coding agent"; the concrete demo *is* a coding agent building Telenotes. Same demo, told to the right audience.

---

## 7. Organizational home

**QMI Lab is the primary home** for Lodestar. The repo lives at `github.com/qmilab/lodestar`. The whitepaper lives at `qmilab.com/lodestar`. Academic publications carry the QMI Lab byline.

Rationale:
- Lodestar's architecture is research-driven (epistemic governance, calibration, threat modeling, replay-grade audit). The voice matches QMI Lab's existing pillars.
- The research arc produces publishable artifacts (memory poisoning paper, calibration paper, evaluation methodology paper). QMI Lab is built for this.
- Research lab branding builds initial credibility in a trust-heavy category. Enterprise commercial branding muddies the message in 2026.

**Commercial extensions** will come later in the arc. Specifically:
- Hosted Lodestar (dashboard, team approvals, compliance)
- Enterprise policy/probe packs
- SOC 2-ready managed deployments
- Integration with Machinova as an internal governance layer for collaborative AI workspaces

This is the Hugging Face / Allen AI shape: research lab anchors credibility, commercial entity productizes once the research arc has earned legitimacy.

---

## 8. What this means for the next four batches

These positioning decisions shape the implementation roadmap (`docs/roadmap.md`):

- **Batch 1** (done): positioning, README, roadmap. No code changes.
- **Batch 2** (done): repackaged existing code into the four developer-facing surfaces (Guard meta-package, Trace CLI, Memory Firewall adapters for mem0/Letta/Zep). Re-exports and adapters.
- **Batch 3** (done): MCP proxy mode for wrapping existing agents like Claude Code. `lodestar guard mcp-proxy --config <path>` ships; `examples/claude-code-wrapped/` exercises the proxy end-to-end and produces a useful trust report; two new probes (`mcp-proxy-roundtrip`, `mcp-proxy-injection-defense`) brought the probe count to fourteen at the time. This is the point at which Lodestar becomes legible outside this design conversation.
- **Batch 4** (done): the Harness infrastructure that makes the marketplace possible. Probe-pack format + loader, the `Probe` base class + pack runner + `lodestar harness run` CLI, the `Sentinel` base class + three sentinels, reflection in the cognitive core, the Postgres-backed stores, the proxy/`guard.wrap()` Postgres wiring, the first non-core pack `packs/coding-agent-safety/` (shipping `prompt-injection-cross-tool`, `tool-poisoning-cross-session`, and `confidence-drift`), the `Calibrator` (per-class ECE / Brier / calibration-gap tables), and finally the three sentinels folded into the `coding-agent-safety` pack (declared by id under the manifest's `sentinels` field, resolved against the harness's first-party registry) have all landed — twenty probes across two packs at the close of Batch 4.
- **Batch 5** (done): the week-8 thesis demo. Both proving grounds landed — the secondary documentation-agent (`examples/documentation-agent/` — claim/evidence over documentation content via the `DocAwareEvidenceLinker` cognitive seam) and the primary Telenotes governed-dev demo (a coding agent governed end-to-end through the MCP proxy, with a clean run, a self-verifying poison run, and a captured real-Claude-Code run), plus the published blog/video walkthrough. Twenty-two probes now pass across two packs.

The architecture does not change. Only its presentation does.
