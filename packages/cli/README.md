# @qmilab/lodestar-cli

The `lodestar` command-line interface.

## Commands

### `lodestar report <session-id>` — headline command

Render a markdown trust report for a session. Resolves the project
directory under the log root automatically; pass `--project` to
disambiguate when multiple projects share a session id.

```sh
lodestar report session-1779551238212
lodestar report session-1779551238212 --out trust.md
lodestar report session-1779551238212 --raw-events 25
```

### `lodestar otel export <session-id>` — OpenTelemetry bridge

Project a session's event log into OpenTelemetry GenAI spans and emit them
as OTLP/HTTP JSON, so the epistemic chain shows up in Langfuse, Phoenix,
Jaeger, or Tempo. With `--endpoint`, the trace is POSTed to a collector;
with `--out`, it is written to a file; with neither (or `--stdout`), it is
printed to stdout — a dry run that needs no collector. Content above
`--sensitivity-ceiling` (default `internal`) is withheld: the span ships
with structural metadata and the payload hash only.

```sh
lodestar otel export session-1779551238212 --stdout
lodestar otel export session-1779551238212 --endpoint http://localhost:4318
lodestar otel export session-1779551238212 \
  --sensitivity-ceiling confidential \
  --header "authorization=Bearer $TOKEN" --out trace.json
```

### `lodestar guard wrap --target <module>` — programmatic surface

Import a TS module that default-exports an `AgentLoop` and run it
under a guarded session. The CLI prints the session id so you can
immediately render the report.

```sh
lodestar guard wrap --target ./my-agent.ts --actor alice
lodestar report <session-id>
```

The target module must `export default` an `async (ctx) => Promise<T>`
function. It is responsible for registering any tools it needs.

### `lodestar action list` / `lodestar action describe <action-id>`

Introspect the registered tool catalogue. `fs.read` and `git.status`
are registered automatically against the current working directory so
the catalogue is non-empty without launching a session.

```sh
lodestar action list
lodestar action describe fs.read
```

### `lodestar trace inspect <event-id>` — debug

Look up a single event envelope by id. Debug-grade output (raw JSON);
prefer `lodestar report` for anything user-facing.

```sh
lodestar trace inspect <event-id>
lodestar trace inspect <event-id> --session session-... --project my-proj
```

### `lodestar probe <name>`

Run one of the probes in `packs/lodestar-core/probes/`. Probes are spec,
not test scaffolding — when they fail, the change is wrong, not the
probe.

```sh
lodestar probe poison
lodestar probe guard-import
```

### `lodestar harness run` / `lodestar harness list`

Drive a whole probe pack instead of a single probe. `run` executes every
probe in the pack and prints an aggregate summary (a failing probe does
not abort the run); `list` inspects the pack's manifest without executing
anything. By default `run` records each probe run as a synthetic
observation in the event log so the run is itself auditable via
`lodestar report`.

```sh
lodestar harness run                       # the first-party lodestar-core pack
lodestar harness run --pack ./packs/mine   # a local pack directory
lodestar harness run --no-record           # skip event-log recording (CI)
lodestar harness run --pack ./packs/mine --allow-unsigned   # load an unsigned local pack
lodestar harness list
```

`run` exits non-zero if any probe fails, so it works as a CI gate.

A pack manifest is verified on load (ADR-0017): a bare-name first-party pack
(e.g. `lodestar-core`) ships unsigned and loads automatically, but a `--pack
<path>` pack must either carry a valid Ed25519 author signature or be loaded with
`--allow-unsigned` (the explicit opt-out — no silent default). A signed pack is
always verified, and a content-digest mismatch (swapped probe bytes under a valid
signature) is rejected.

### `lodestar harness calibrate <session-id>`

Score a session's stated belief confidence against realised outcome per
`calibration_class` (ECE / Brier / calibration-gap, flagged classes), print
the markdown report, and — unless `--no-emit` — record the verdict as a
durable `calibration.computed@1` governed event so calibration drift is
auditable and replayable. The calibrator only measures; emitting the event is
this separate publish step (ADR-0011). The recorded `cursor` is a replay key:
re-running over the same window reproduces the verdict.

```sh
lodestar harness calibrate session-1779551238212               # print + record
lodestar harness calibrate session-… --no-emit                 # preview only
lodestar harness calibrate session-… --out calibration.md      # also write md
```

## Exit codes

- `0` — success
- `1` — operational failure (loop threw, event-log write failed, …)
- `2` — usage error
- `3` — resource not found (no events for session, no event with id, …)
