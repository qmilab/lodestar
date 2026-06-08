---
title: "CLI reference"
description: "Every lodestar command — report, view, otel export, guard, approve, action, trace, probe, harness, reflect — with its arguments, flags, and exit codes."
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
lodestar view [session-id] [--log-root <path>] [--port <n>] [--open]
lodestar otel export <session-id> [--endpoint <url>] [--sensitivity-ceiling <level>]
lodestar guard wrap --target <module> [--project <id>] [--actor <id>]
lodestar guard mcp-proxy --config <path>
lodestar approve list --project <id> [--log-root <path>]
lodestar approve grant <request-id> --approver <id> --project <id>
lodestar approve deny  <request-id> --approver <id> --project <id>
lodestar action list
lodestar action describe <action-id>
lodestar trace inspect <event-id> [--project <id>] [--session <id>]
lodestar probe <name>
lodestar harness run [--pack <name|path>] [--log-root <path>] [--no-record]
lodestar harness list [--pack <name|path>]
lodestar harness calibrate <session-id> [--project <id>] [--no-emit] [--out <file>]
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

## `view` — the read-side Governing UI

Serve a local, **strictly read-only** web viewer over the event log: the session
list, the interactive chain drill-down, the markdown report, an event-type filter,
a live tail over Server-Sent Events, and a read-only view of pending approvals. It
binds to loopback by default (the log can carry `secret`-sensitivity beliefs) and
exposes **no** mutation route. The live, interactive sibling of `report`.

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--log-root <path>` | `-l` | Event-log root directory |
| `--port <n>` | | Port to bind (default 4319; `0` for an ephemeral port) |
| `--open` | | Open the viewer in your browser |

```sh
lodestar view
```

## `otel export` — OpenTelemetry GenAI spans

Project a session into OpenTelemetry GenAI spans and emit them as **OTLP/HTTP
JSON** — POST to a collector, or `--out` / `--stdout` for a collector-free dry run.
Action-centric: the session is the root `invoke_agent` span, each governed Action an
`execute_tool` child carrying the policy verdict, trust level, and outcome. Honours
the export **sensitivity ceiling** — content above it ships as structural metadata +
a payload hash only.

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--endpoint <url>` | | OTLP/HTTP collector endpoint to POST spans to |
| `--sensitivity-ceiling <level>` | | Withhold content above this level (default `internal`) |
| `--out <file>` | `-o` | Write the OTLP payload to a file |
| `--stdout` | | Print the OTLP payload to stdout (collector-free dry run) |
| `--project <id>` | `-p` | Project partition |
| `--log-root <path>` | `-l` | Event-log root directory |

```sh
lodestar otel export session-1779551238212 --stdout
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
| `--auto-approve-up-to <0..3>` | | Auto-approve up to this [trust-ladder](../concepts/trust-ladder.md) rung. L4 always **holds** for approval, L5 is denied — neither is an auto-approve ceiling |

**`guard mcp-proxy`** — stdio MCP proxy. Wraps any MCP-speaking agent (Claude Code,
Cursor, Aider) without code changes; see
[architecture](architecture.md#two-adoption-shapes).

| Flag | Alias | Meaning |
| --- | --- | --- |
| `--config <path>` | `-c` | Proxy config (downstream servers, tool defaults, ceiling) |

```sh
lodestar guard mcp-proxy --config ./lodestar-mcp-proxy.config.json
```

## `approve` — resolve a held approval out of band

When an L4 action is **held** at `pending_approval`, a separate-process approver
resolves it. `approve list` shows the pending queue; `approve grant` / `approve deny`
write a **signed** resolution that the proxy verifies against operator-pinned
approver keys before promoting — a forged, unsigned, or tampered grant cannot
un-park the hold. The proxy stays the sole event-log writer.

| Subcommand | Flags | Meaning |
| --- | --- | --- |
| `approve list` | `--project <id>`, `--log-root <path>` | List requests awaiting approval |
| `approve grant <request-id>` | `--approver <id>`, `--project <id>`, `--key <path>` | Grant, signed with the approver's key |
| `approve deny <request-id>` | `--approver <id>`, `--project <id>`, `--key <path>` | Deny the request |
| `approve keygen` | `--approver <id>`, `--out <path>` | Generate an Ed25519 approver keypair |

The signing key is read from `--key` or `LODESTAR_APPROVER_KEY` — never from argv.

```sh
lodestar approve list --project my-project
lodestar approve grant req-abc123 --approver alice --project my-project
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
pack's manifest without executing anything. `harness calibrate <session-id>` scores
the session's confidence-vs-outcome and records a durable `calibration.computed@1`
event (`--no-emit` previews without writing; `--out <file>` writes the report).

| Flag | Meaning |
| --- | --- |
| `--pack <name\|path>` | Pack to load — `lodestar-core`, `coding-agent-safety`, or a path |
| `--log-root <path>` | Event-log root directory |
| `--project <id>` / `--session <id>` / `--actor <id>` | Context for recorded runs |
| `--no-record` | Run without recording observations |

```sh
lodestar harness run --pack lodestar-core
lodestar harness list --pack coding-agent-safety
lodestar harness calibrate session-1779551238212
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
