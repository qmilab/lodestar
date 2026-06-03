---
title: "CLI reference"
description: "Every lodestar command — report, guard, action, trace, probe, harness, reflect — with its arguments, flags, and exit codes."
---

# CLI reference

`lodestar` is the command-line surface. The headline command is
`lodestar report <session-id>`; everything else lives under an area prefix so the
help output stays scannable. From a clone, invoke it through the root script:

```sh
bun run lodestar <command> [args]
```

Run `lodestar help` (or `--help` / `-h`) for the built-in usage summary.

```
lodestar report <session-id> [--project <id>] [--log-root <path>] [--out <file>]
lodestar guard wrap --target <module> [--project <id>] [--actor <id>]
lodestar guard mcp-proxy --config <path>
lodestar action list
lodestar action describe <action-id>
lodestar trace inspect <event-id> [--project <id>] [--session <id>]
lodestar probe <name>
lodestar harness run [--pack <name|path>] [--log-root <path>] [--no-record]
lodestar harness list [--pack <name|path>]
lodestar reflect <session-id> [--since-seq <n>] [--trigger <name>] [--json]
lodestar help
```

---

## `report` — the trust report

Render a markdown [trust report](../guides/get-started.md#read-the-trust-report)
for a session from its event log. This is the headline command — the output is
meant to be pasted into a GitHub issue or a Slack message.

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--project <id>` | `-p` | Project partition to read from |
| `--log-root <path>` | `-l` | Event-log root directory |
| `--out <file>` | `-o` | Write the report to a file instead of stdout |
| `--raw-events <n>` | | Append the last *n* raw event envelopes for debugging |

```sh
lodestar report session-1779551238212
```

## `guard` — wrap an agent run

Two modes.

**`guard wrap`** — programmatic. Loads a JS/TS module that drives an agent loop and
runs it through the full trust layer.

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--target <module>` | `-t` | The loop module to load (required) |
| `--project <id>` | `-p` | Project id |
| `--actor <id>` | `-a` | Actor id for the run |
| `--log-root <path>` | `-l` | Event-log root directory |
| `--auto-approve-up-to <0..4>` | | Auto-approve [trust-ladder](../concepts/trust-ladder.md) rung; above it, deny |

**`guard mcp-proxy`** — stdio MCP proxy. Wraps any MCP-speaking agent (Claude Code,
Cursor, Aider) without code changes; see
[architecture](architecture.md#two-adoption-shapes).

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--config <path>` | `-c` | Proxy config (downstream servers, tool defaults, ceiling) |

```sh
lodestar guard mcp-proxy --config ./lodestar-mcp-proxy.config.json
```

## `action` — introspect the tool catalogue

`action list` prints the registered tools; `action describe <action-id>` prints one
tool's [action contract](../concepts/trust-ladder.md). The CLI pre-registers
`fs.read` and `git.status`, so these are useful out of the box.

```sh
lodestar action list
lodestar action describe git.status
```

## `trace` — debug-grade log inspection

`trace inspect <event-id>` dumps a single raw event envelope. This is **debug-grade**
— for the user-facing read path, prefer `lodestar report`.

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--project <id>` | `-p` | Project partition |
| `--session <id>` | `-s` | Session to search |
| `--log-root <path>` | `-l` | Event-log root directory |

## `probe` — run one probe

Run a single [probe](probe-packs.md) by name. Accepts a short alias *or* the full
probe file basename; it shells out to the probe in `packs/lodestar-core/probes/`.

| Alias | Probe |
| --- | --- |
| `poison` | `memory-poisoning-basic` |
| `chain` | `epistemic-chain-smoke` |
| `external` | `external-document-not-normal` |
| `quarantine` | `quarantined-not-retrievable` |
| `sensitivity` | `sensitivity-ceiling` |
| `autoobs` | `auto-observation-gate` |
| `guard-import` | `guard-import-no-self-promote` |
| `guard-precond` | `guard-precondition-revalidation` |
| `guard-contract` | `guard-contract-invariants` |
| `reflection-retrieval` | `reflection-cannot-promote-to-normal-alone` |
| `reflection-cascade` | `contradicted-belief-flags-dependent-decisions` |
| `canonical-hash` | `event-log-canonical-hash` |

```sh
lodestar probe chain
```

## `harness` — drive a whole pack

`harness run` runs every probe in a [pack](probe-packs.md), recording each run as a
synthetic observation so the run is itself auditable. `harness list` inspects a
pack's manifest without executing anything.

| Flag | Meaning |
| --- | --- |
| `--pack <name\|path>` | Pack to load — `lodestar-core`, `coding-agent-safety`, or a path |
| `--log-root <path>` | Event-log root directory |
| `--project <id>` / `--session <id>` / `--actor <id>` | Context for recorded runs |
| `--no-record` | Run without recording observations |

```sh
lodestar harness run --pack lodestar-core
lodestar harness list --pack coding-agent-safety
```

## `reflect` — dry-run a reflection pass

Print the typed proposals a [reflection](../concepts/sentinels-and-calibration.md)
pass would produce over a session's log. It only *prints* — applying proposals is
the host's job (Guard and the MCP proxy own the live firewall).

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--since-seq <n>` | | Reflect only over events after sequence *n* |
| `--trigger <name>` | | Name the reflection trigger |
| `--json` | | Emit proposals as JSON |
| `--project <id>` | `-p` | Project partition |
| `--log-root <path>` | `-l` | Event-log root directory |

```sh
lodestar reflect session-1779551238212
```

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — including a real-but-empty result (returned with a note) |
| `2` | Usage error — unknown command or missing required argument |
| `3` | Resource not found — the session or event doesn't exist (so scripts can branch on it) |

## Related

- [Get started](../guides/get-started.md) — the commands in context.
- [Probe-pack reference](probe-packs.md) — what `probe` and `harness` run.
- [Architecture](architecture.md) — the packages behind each command.
