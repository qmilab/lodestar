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

## Exit codes

- `0` — success
- `1` — operational failure (loop threw, event-log write failed, …)
- `2` — usage error
- `3` — resource not found (no events for session, no event with id, …)
