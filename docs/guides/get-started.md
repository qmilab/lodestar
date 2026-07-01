---
title: "Get started"
description: "Clone Lodestar, run two governed coding-agent demos, and read the trust report they produce — in about five minutes."
---

# Get started

This page gets you from a clone to a **trust report** in about five minutes.
You'll run a coding agent through Lodestar twice — once on an ordinary feature
task, once with a poisoned file in the repo — and read what the run recorded.

If you want the narrative version first, read the
[walkthrough](walkthrough.md); this page is the hands-on shortcut.

## Prerequisites

- **[Bun](https://bun.sh)** — Lodestar's runtime and package manager. Not Node,
  not pnpm.
- **Git** — the demos drive a coding agent that reads, edits, tests, and commits
  against a small fixture repo.
- That's it for the core path. One probe
  (`tool-poisoning-cross-session`) additionally needs a Postgres database; it
  skips cleanly when you don't have one (see [below](#run-the-safety-probes)).

## Clone and install

```sh
git clone https://github.com/qmilab/lodestar
cd lodestar
bun install
```

Everything below runs locally. There is no hosted service to sign up for, no API
key to set. Lodestar is Apache-2.0 end to end.

## Run the headline demo: wrap a coding agent

The Telenotes governed-dev example drives a deterministic in-process coding agent
through the [MCP proxy](../reference/architecture.md) on a real feature task:
observe → decide → edit → test → commit, then a **blocked** `git_push`.

```sh
bun run example:telenotes:scripted
```

What you'll see: the agent reads a Nostr-note fixture, decides on an edit, writes
it, runs the tests, and auto-approves the commit — every step recorded as a link
in the [epistemic chain](../concepts/epistemic-chain.md). The final `git_push` is
an **external, irreversible** action, so it stops at the
[policy gate](../concepts/trust-ladder.md) instead of running. The run renders a
full trust report and commits it under
`examples/telenotes-governed-dev/reports/`.

## Run the poison demo: watch the firewall hold

The same run, but now a hostile `DEVELOPMENT.md` is sitting in the repo. It reads
like an authority and tries to steer the agent into hardcoding a secret and
pushing it to `main`:

```sh
bun run example:telenotes:poison
```

The agent reads the malicious file. It even records *what the file said* — but
only as an **unverified** belief, never promoted to a trusted fact (this is the
[reading-isn't-believing](../concepts/reading-isnt-believing.md) gate). The
feature plan it actually carries out never depends on the poison, and the
`git_push` the file was steering toward stays blocked at the gate. The run
self-checks and prints its own verdict:

```
────────────────────────────────────────────────────────────────────────
[firewall verdict] HELD ✓
  ✓ poison content stayed 'unverified' (never 'supported')
  ✓ no supported belief carries the injection marker
  ✓ feature decision cites the legitimate note.ts belief; the poison is not a dependency
────────────────────────────────────────────────────────────────────────
```

This invariant is locked in CI by the
`poisoned-file-cannot-hijack-feature-work` probe — it is spec, not a one-off.

## Read the trust report

Each governed run writes an append-only NDJSON event log. Turn any session into a
human-readable report with the headline CLI command:

```sh
bun run lodestar report <session-id>
```

The report answers the questions a transcript and a diff can't: what the agent
**observed**, what it came to **believe**, which beliefs each **decision**
depended on, what **policy** allowed, and what actually **happened**. The scripted
and poison runs both commit their rendered reports under
`examples/telenotes-governed-dev/reports/`, so you can read one without running
anything.

> `lodestar` is exposed through the root `lodestar` script in this repo, so
> `bun run lodestar <args>` works from a clone. See the
> [CLI reference](../reference/cli.md) for the full command surface.

## Run the safety probes

Probes are Lodestar's executable spec — adversarial checks that pin each
invariant. Run the whole suite across both packs:

```sh
bun run probes:ci
```

All 79 probes pass under strict TypeScript. A few need extra infrastructure and
**skip with a loud banner** when it is unavailable, so this stays green on a bare
checkout: three (`tool-poisoning-cross-session`, `sql-adapter-enforces-invariants`,
`vector-adapter-enforces-invariants`) need Postgres via `LODESTAR_TEST_DATABASE_URL`,
one needs an OS sandbox mechanism, and one each needs a Python + LangGraph / CrewAI /
AutoGen runtime. CI provides all of them. To run just one pack:

```sh
bun run lodestar harness run --pack lodestar-core      # the 75 core probes
bun run lodestar harness run --pack coding-agent-safety # the 4 safety probes + 3 sentinels
```

See the [probe-pack reference](../reference/probe-packs.md) for the pack format
and the full probe list.

## Where to go next

- **[Walkthrough](walkthrough.md)** — the same two demos told as a story, with
  diagrams and the full reasoning.
- **[Concepts](../concepts/epistemic-chain.md)** — the epistemic chain, the
  memory firewall, the trust ladder, and why reading isn't believing.
- **[Use cases](../use-cases.md)** — where Lodestar fits, beyond the demo.
- **[Reference](../reference/architecture.md)** — architecture, CLI, and pack
  format.
