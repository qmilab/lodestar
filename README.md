# Lodestar

**The trust layer for AI agents.**

Know what your agent believed, why it acted, and whether it was right.

---

Agents are becoming powerful enough to change code, call APIs, deploy systems, and publish content. But when something goes wrong, teams cannot answer basic questions:

- What did the agent believe?
- Where did that belief come from?
- Which action depended on it?
- Was the belief verified?
- Did the agent learn the right lesson afterward?

Lodestar gives agents a trust layer: claims, evidence, decisions, approvals, memory governance, and outcome tracking. Every action the agent takes leaves an audit trail that can be replayed, explained, and graded.

Lodestar is a research project of [QMI Lab](https://qmilab.com). Commercial offerings will follow from [Machinise](https://machinise.com).

---

## What it does

Lodestar wraps an agent so that:

1. **Tool calls are mediated.** Every action the agent attempts passes through a typed contract, a policy check, and (if needed) an approval step before it executes.
2. **Observations become claims.** When a tool returns, its output is extracted into structured claims — propositions the agent might come to believe.
3. **Claims need evidence.** A claim becomes a belief only after the firewall has weighed the evidence behind it, including evidence from prior beliefs.
4. **Memory is governed.** Beliefs move through four orthogonal lifecycle axes (truth, retrieval, security, freshness) under explicit transition rules. No belief silently promotes itself just because the agent succeeded once.
5. **Everything is auditable.** A complete, replay-grade event log records every claim, belief, decision, action, and revision — with payload hashes and monotonic sequence numbers.
6. **Why-did-it-do-this reports.** Given a session, Lodestar produces a human-readable trace that explains what the agent believed, what evidence it had, and which beliefs informed which actions.

---

## Where it fits among existing tools

| You use… | Lodestar's role |
| --- | --- |
| **Claude Code, Cursor, OpenClaw, Hermes, LangGraph, CrewAI** for agent runtime | Lodestar wraps and governs their actions |
| **mem0, Letta, Zep, vector DBs** for memory | Lodestar governs what is safe to remember and retrieve |
| **LangSmith, Langfuse, Phoenix, Braintrust** for observability | Lodestar exports traces and adds epistemic semantics on top |
| **MS Agent Governance Toolkit, MCP gateways** for policy | Lodestar extends governance to beliefs, memory, skills, and confidence |
| **Claude Skills, MCP servers, plugin marketplaces** for capabilities | Lodestar verifies, signs, scores, and policy-wraps them |

Use LangSmith to see traces. Use Lodestar to see which claims became beliefs, which beliefs drove actions, and whether policy allowed those actions.

Use mem0 for memory. Use Lodestar to govern memory promotion and retrieval.

Use Claude Code or OpenClaw to run the agent. Use Lodestar to make its actions and memories trustworthy.

**Lodestar does not replace your agent runtime, your memory store, or your observability platform.** It adds a governance layer over the epistemic chain that those systems do not model directly.

---

## The four developer entry points

Lodestar is one architecture, exposed through four developer-facing packages:

### `@qmilab/lodestar-guard`
The **write side**. Wraps agent tool calls, captures observations, gates risky actions, records the epistemic chain. This is the first thing most developers adopt.

```ts
import { guard } from "@qmilab/lodestar-guard"
const agent = guard.wrap({
  tools,
  memory,
  policy: "./lodestar.policy.ts",
  traceTo: "langfuse",
})
```

Or as a CLI wrapping any coding agent:

```
lodestar init
lodestar guard run -- claude code "fix the failing test"
```

### `@qmilab/lodestar-trace`
The **read side**. Consumes the event log and produces "why did the agent do this?" reports. Markdown, HTML, or piped exports to LangSmith / Langfuse / Phoenix. The package is `@qmilab/lodestar-trace`; the user-facing CLI command is `lodestar report`.

```
lodestar report <session-id>
```

### `@qmilab/lodestar-memory-firewall`
The **memory governance entry point**. Works alongside [mem0](https://github.com/mem0ai/mem0), [Letta](https://github.com/letta-ai/letta), [Zep](https://github.com/getzep/zep), or custom memory layers. Decides what beliefs to adopt, retrieve, quarantine, or block — with audited transitions on four lifecycle axes (truth, retrieval, security, freshness).

```ts
import { MemoryFirewall } from "@qmilab/lodestar-memory-firewall"
import { mem0Adapter } from "@qmilab/lodestar-memory-firewall/adapters/mem0"
const firewall = new MemoryFirewall({ adapter: mem0Adapter(mem0Client) })
```

### `@qmilab/lodestar-harness`
**Probes, sentinels, and calibrators.** Safety tests, runtime monitors, and confidence-vs-outcome measurement. The natural surface for community-shared trust packs.

```
lodestar harness run --pack memory-poisoning
```

---

## Open-source strategy

The four packages above and their dependencies are licensed under **Apache 2.0**:

- `@qmilab/lodestar-core` (schemas)
- `@qmilab/lodestar-event-log`
- `@qmilab/lodestar-action-kernel`
- `@qmilab/lodestar-memory-firewall`
- `@qmilab/lodestar-cognitive-core`
- `@qmilab/lodestar-guard`
- `@qmilab/lodestar-trace`
- `@qmilab/lodestar-harness`
- All built-in adapters (Git, GitHub, filesystem, shell, Langfuse, Phoenix, OTel)
- Example probe packs and research benchmarks
- Policy language and basic replay

Future commercial offerings from Machinise will include hosted dashboard, team approval workflows, compliance exports, advanced replay UI, enterprise policy packs, and a managed registry. These do not gate any developer-adoption workflow.

---

## Status

**Pre-v0.1 implementation, v0.2 architecture. Batches 1 and 2 complete.**

What ships today:

- ✅ Full schema layer for the epistemic chain (Observation, Claim, Evidence, Belief, Decision, Action, Outcome, Revision, Explanation)
- ✅ Append-only NDJSON event log with monotonic sequence numbers and payload hashes
- ✅ Two-phase action execution with precondition revalidation
- ✅ Memory firewall with four orthogonal lifecycle axes and per-axis transition tables
- ✅ Cognitive core: claim extractors, evidence linker, world model, ingestion orchestrator
- ✅ `@qmilab/lodestar-guard` — `wrap()` helper that drives an agent loop through the full trust layer
- ✅ `@qmilab/lodestar-trace` — `lodestar report <session-id>` renders a markdown trust report from any event log
- ✅ Stub adapters for mem0, Letta, and Zep under `packages/memory-firewall/adapters/` — design contracts plus one working `importMemories` method each
- ✅ Reorganised CLI: `lodestar report`, `lodestar guard wrap`, `lodestar action list/describe`, `lodestar trace inspect`, `lodestar probe <name>`
- ✅ Seven passing probes (six pre-existing plus a new `guard-import-no-self-promote` probe enforcing that adapter imports cannot self-promote)
- ✅ End-to-end examples:
  - `examples/telenotes-governed-dev/` — full pipeline producing an 11-event audit trail
  - `examples/doc-insight/` — auto-observation gate demo
  - `examples/coding-agent-greenfield/` — `guard.wrap()` applied to a homegrown coding-agent loop

What's coming in the next three batches:

- **Batch 3** — Thin MCP proxy: wrap an existing coding agent (e.g., Claude Code) and route its tool calls through the Action Kernel
- **Batch 4** — Harness infrastructure (sentinel base, calibrator, probe pack format)
- **Batch 5** — Week-8 thesis demo: a coding agent governed end-to-end, with a second proving ground using a documentation-update task

See [`docs/roadmap.md`](./docs/roadmap.md) for the full plan, [`docs/positioning.md`](./docs/positioning.md) for the strategic framing, and [`docs/architecture/`](./docs/architecture/) for the design memos.

---

## Try the scaffold

```sh
# Install Bun if needed: https://bun.sh
bun install
bun run example:telenotes   # full end-to-end demo
bun run probes:all          # memory poisoning + epistemic chain probes
```

All six probes will pass. The Telenotes example produces an 11-event audit trail with full causality, payload hashes, and a printed trace of the epistemic chain.

---

## Research arc

Lodestar's deeper architecture is described in academic voice in [`docs/architecture/`](./docs/architecture/). The framing there is "epistemic governance for agentic systems" — that phrase belongs in the whitepaper and citations, not on the homepage.

Planned research outputs:

- Memory-poisoning threat taxonomy and empirical probe results
- Calibration framework: confidence-vs-outcome measurement for agent beliefs
- Evaluation methodology for trust-aware agent systems
- Position paper: epistemic governance as an architectural primitive

---

## License

Apache 2.0 for all open-source packages. See [LICENSE](./LICENSE).

## Acknowledgements

The architecture has been refined across multiple adversarial review rounds with collaborators including ChatGPT, with the underlying design crystallized through several iterations of memo, probe, and counter-example. See [`docs/architecture/v02-delta.md`](./docs/architecture/v02-delta.md) for the review history.
