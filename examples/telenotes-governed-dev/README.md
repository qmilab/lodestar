# Telenotes governed development — reference demonstration

The Batch 5 primary proving ground. A coding agent, wrapped via the Lodestar
MCP proxy, is asked to add a feature to **Telenotes** (a tiny Nostr
note-publishing module). Every tool call it makes flows through the Action
Kernel and lands in the epistemic chain, and `lodestar report` renders the
whole thing as a trust report.

This is a *reference demonstration*, not a core package — nothing here is
imported by `@qmilab/lodestar-*`.

## What the scripted run shows

`scripted-run/index.ts` drives the proxy through a real feature task: add an
optional `clientTag` field to `Note` and stamp it on publish. The agent is
deterministic (an in-process driver, not a live LLM) so the run is
reproducible, but the architecture under test is real — the proxy owns two live
downstream MCP servers:

- `@modelcontextprotocol/server-filesystem` — read + `write_file` (the agent's
  reads and edits)
- the first-party `dev-tools-mcp/` server — `shell_test`, `git_commit`,
  `git_push` (see its CLAUDE.md)

The sequence and what the trust report captures:

1. **Observe** — list the workspace, read `README.md`, `note.ts`, `publish.ts`.
   Each read produces a `tool_result` envelope claim (→ belief `supported`) and
   an `external_document` content claim (→ belief `unverified`: read, not
   verified).
2. **Decide** — the agent commits to the `clientTag` plan, citing the
   (unverified) belief about `Note`'s shape that reading `note.ts` produced.
3. **Edit** — two governed `write_file` actions (L3, auto-approved).
4. **Test** — `shell_test` runs the fixture's `bun test` suite (L3); the run
   records a `success` outcome.
5. **Commit** — `git_commit` (L3, auto-approved) — a real commit in a throwaway
   working tree.
6. **Push → blocked** — `git_push` is L4 (irreversible, external blast radius),
   above the L3 auto-approve ceiling. The policy gate **denies** it; the agent
   records the block and revises its plan to "defer to human approval".

The headline: trust comes from the operator's config, not the wire. File
contents stay `external_document`/`unverified`, and the one L4 action is the one
the gate stops.

## Run

```sh
bun run example:telenotes:scripted        # prints the trust report to stdout
```

A captured snapshot lives at [`reports/scripted-run.report.md`](./reports/scripted-run.report.md).
Regenerate it (event ids/timestamps differ per run; the snapshot is intentional)
with:

```sh
bun run examples/telenotes-governed-dev/scripted-run/index.ts \
  > examples/telenotes-governed-dev/reports/scripted-run.report.md
```

## Layout

```
telenotes-governed-dev/
├── fixture/telenotes/     # the codebase the agent edits (copied per run)
├── dev-tools-mcp/         # first-party MCP server: shell_test, git_commit, git_push
├── scripted-run/
│   ├── index.ts           # the deterministic agent driver
│   └── feature/           # the agent's proposed file versions (written via write_file)
├── reports/               # committed trust-report snapshots
├── index.ts               # legacy week-1 stub (read-only, in-process)
└── policy.lodestar.ts     # the aspirational trust table the proxy config realizes
```

## Still to come in this batch

- A second run with a **poisoned file** in the workspace, demonstrating the
  Memory Firewall keeping injected content out of the agent's trusted beliefs
  and decisions — plus a `coding-agent-safety` probe locking that invariant.
- A `real-claude-code/` recipe driving the same proxy with a real Claude Code
  session, with the resulting report captured as evidence.

## What this is NOT

- Not a Telenotes feature shipped to users — Telenotes is a fixture here.
- Not part of the Lodestar core architecture.
- Not calibration / sentinel coverage. The Calibrator only *measures* and
  sentinels are non-blocking by design (acting on their signals is deferred
  Policy-Kernel work), so this demo does not claim "the sentinel halted the
  action." Those overlays are a clean follow-up once the run exists.
