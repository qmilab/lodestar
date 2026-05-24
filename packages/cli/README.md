# @orrery/cli

The `orrery` command-line interface.

## Commands

### `orrery report <session-id>` — headline command

Render a markdown trust report for a session. Resolves the project
directory under the log root automatically; pass `--project` to
disambiguate when multiple projects share a session id.

```sh
orrery report session-1779551238212
orrery report session-1779551238212 --out trust.md
orrery report session-1779551238212 --raw-events 25
```

### `orrery guard wrap --target <module>` — programmatic surface

Import a TS module that default-exports an `AgentLoop` and run it
under a guarded session. The CLI prints the session id so you can
immediately render the report.

```sh
orrery guard wrap --target ./my-agent.ts --actor alice
orrery report <session-id>
```

The target module must `export default` an `async (ctx) => Promise<T>`
function. It is responsible for registering any tools it needs.

### `orrery action list` / `orrery action describe <action-id>`

Introspect the registered tool catalogue. `fs.read` and `git.status`
are registered automatically against the current working directory so
the catalogue is non-empty without launching a session.

```sh
orrery action list
orrery action describe fs.read
```

### `orrery trace inspect <event-id>` — debug

Look up a single event envelope by id. Debug-grade output (raw JSON);
prefer `orrery report` for anything user-facing.

```sh
orrery trace inspect <event-id>
orrery trace inspect <event-id> --session session-... --project my-proj
```

### `orrery probe <name>`

Run one of the research probes in `research/probes/`. Probes are spec,
not test scaffolding — when they fail, the change is wrong, not the
probe.

```sh
orrery probe poison
orrery probe guard-import
```

## Exit codes

- `0` — success
- `1` — operational failure (loop threw, event-log write failed, …)
- `2` — usage error
- `3` — resource not found (no events for session, no event with id, …)
