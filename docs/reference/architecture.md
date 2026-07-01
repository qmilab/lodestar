---
title: "Architecture overview"
description: "How Lodestar's packages fit together — the epistemic-chain core, the governance kernels, the two adoption shapes (guard.wrap and the MCP proxy), and what's built versus placeholder."
---

# Architecture overview

Lodestar is one architecture exposed through several packages. This page maps the
pieces; the [concepts](../concepts/epistemic-chain.md) pages explain *why* each
exists, and the [CLI](cli.md) and [probe-pack](probe-packs.md) references cover the
surfaces.

The whole system serves one thesis: an agent cannot safely act unless Lodestar can
show what it observed, claimed, believed, why it decided, what policy allowed, what
happened, and how it revised itself afterward — the
[epistemic chain](../concepts/epistemic-chain.md).

## The layers

```
       wrapped agent (Claude Code, Cursor, Aider, a homegrown loop, …)
                              │
        ┌─────────────────────┴─────────────────────┐
        │                  Guard                      │   write side
        │   guard.wrap()  ·  lodestar guard mcp-proxy  │
        └─────────────────────┬─────────────────────┘
                              │
   ┌──────────────┬───────────┼───────────┬──────────────────┐
   │ Action Kernel│ Cognitive  │ Memory    │ (Policy Kernel)  │  governance
   │ contracts +  │ Core       │ Firewall  │ trust ladder +   │
   │ two-phase    │ claims →   │ 4 axes +  │ approvals        │
   │ execution    │ beliefs    │ context   │ — not yet built  │
   └──────────────┴───────────┴───────────┴──────────────────┘
                              │
                   append-only NDJSON event log
                              │
        ┌─────────────────────┴─────────────────────┐
        │                  Trace                      │   read side
        │            lodestar report                  │
        └─────────────────────────────────────────────┘
```

## Core packages

Every public type lives in the core and is exported through the
`@qmilab/lodestar-*` workspace aliases.

| Package | Role |
| --- | --- |
| `@qmilab/lodestar-core` | The epistemic-chain types and Zod schemas. The dependency root — types and schemas only, no runtime behavior. |
| `@qmilab/lodestar-event-log` | Append-only NDJSON envelope, writer/reader, snapshots; payload hashes, monotonic sequence numbers, per-partition append serialization. |
| `@qmilab/lodestar-action-kernel` | Tool registry, the [action contract](../concepts/trust-ladder.md) gate, two-phase execution. |
| `@qmilab/lodestar-cognitive-core` | Claim extraction, evidence linking, belief adoption, the world model, the [auto-observation gate](../concepts/reading-isnt-believing.md), reflection. |
| `@qmilab/lodestar-memory-firewall` | The [four lifecycle axes](../concepts/memory-firewall.md), retrieval gates, promotion rules, contradiction routing; in-memory **and** Postgres backends. |

## Developer entry points

The same architecture is presented through four developer-facing packages — each
adoptable on its own.

### Guard — the write side
`@qmilab/lodestar-guard` (library) and `@qmilab/lodestar-guard-mcp` (proxy) wrap an
agent's tool calls so every action flows through the Action Kernel and every result
through the Cognitive Core. Two adoption shapes — see [below](#two-adoption-shapes).

### Trace — the read side
`@qmilab/lodestar-trace` consumes the event log and renders the
[trust report](../guides/get-started.md#read-the-trust-report). The package is
`-trace`; the user-facing command is `lodestar report` (explanation-focused, to
avoid colliding with observability "tracing").

### Memory Firewall — memory governance
`@qmilab/lodestar-memory-firewall` plus per-backend adapter packages
(`-mem0`, `-letta`, `-zep`). Plugs in front of an existing memory layer rather than
replacing it.

### Harness — the test side
`@qmilab/lodestar-harness` — the [probe-pack loader](probe-packs.md), the `Probe`
base class and pack runner behind `lodestar harness run`, the `Sentinel` base class
and the three first-party sentinels, and the
[Calibrator](../concepts/sentinels-and-calibration.md).

## Two adoption shapes

There are two ways to put Guard around an agent, and the difference matters for
which tools it can govern.

**Greenfield — `guard.wrap()`.** For an agent you own end to end. You wrap the
agent loop; tool calls run through native Action Kernel adapters (e.g.
`@qmilab/lodestar-adapter-filesystem`, `@qmilab/lodestar-adapter-git`).

**Existing MCP agent — the proxy.** `lodestar guard mcp-proxy --config <path>` sits
between an agent and its downstream MCP servers. The agent (Claude Code, Cursor,
Aider — anything that speaks MCP) talks to the proxy as if it were the tool surface;
no code changes to the agent. Every `tools/call` runs through the kernel, every
result through the cognitive core, with the
[auto-observation gate](../concepts/reading-isnt-believing.md) wired in.

!!! note "The proxy governs downstream MCP tools, not native adapters"
    A subtlety worth knowing: the MCP proxy only governs tools served by
    *downstream MCP servers* (`mcp.<server>.<tool>`). It does **not** reach
    Lodestar's native Action Kernel adapters — those are the `guard.wrap()` path.
    So proxy-governed writes/tests/commits must be downstream MCP server tools.
    That's why the Telenotes demo runs a small first-party `dev-tools-mcp` server
    (for `shell_test` / `git_commit` / `git_push`) alongside the official
    filesystem server, rather than wiring native `fs.write` / `git.commit`
    adapters into the proxy.

## What's built versus placeholder

Being precise about current state:

| Status | Packages |
| --- | --- |
| **Built & published (v0.5.0)** | 27 npm packages: `core`, `event-log`, `action-kernel`, `policy-kernel`, `cognitive-core`, `memory-firewall` (+ `mem0` / `letta` / `zep` import adapters), `guard`, `guard-mcp`, `runtime-core`, `trace`, `viewer`, `otel-exporter`, `ship`, `harness`, `cli`, and the nine native adapters `filesystem` / `git` / `shell` / `nostr` / `http` / `messaging` / `sql` / `vector` / `payments`. Plus four PyPI runtime hooks — `lodestar-runtime-client`, `lodestar-langgraph`, `lodestar-crewai`, `lodestar-autogen` |
| **Reserved (not yet built)** | adapter `github` — the forge *API* surface (PRs / issues / releases) behind a `ForgeProvider` seam; git *transport* already ships in `adapter-git` (ADR-0006) |

The **Policy Kernel** has landed: real three-valued enforcement (allow / deny /
**hold**), the trust-ladder floor, the L4 approval workflow, signed approval
resolutions, and the arbitrate hook the sentinels and calibrator plug into. The
TS-level adapter sandboxes are governance boundaries, **not** OS-level
containment — namespace / cgroup / network enforcement stays a later concern. The
`otel-exporter` ships the "pair with Langfuse/Phoenix" bridge (`lodestar otel
export`), and the read-side `viewer` (`lodestar view`) is the live, strictly
read-only Governing UI over the log.

## Stack invariants

- **Runtime & package manager:** Bun. **Language:** TypeScript, strict mode.
- **Validation:** Zod — every public API takes Zod-validated input and returns
  Zod-validated output.
- **Persistence:** PostgreSQL for structured state, NDJSON for the event log,
  optional pgvector for embeddings.
- **License:** Apache 2.0 throughout.

The authoritative schema is `docs/architecture/v02-delta.md` in the repo (read its
Round 5 addendum). This page is the map; that memo is the territory.

## Related

- [The epistemic chain](../concepts/epistemic-chain.md) — the types these packages
  move around.
- [CLI reference](cli.md) · [Probe-pack reference](probe-packs.md)
- [Get started](../guides/get-started.md) — run it end to end.
