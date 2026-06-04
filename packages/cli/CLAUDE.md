# @qmilab/lodestar-cli — CLAUDE.md

The `lodestar` binary. Dispatches to `@qmilab/lodestar-trace` for the report and
to `@qmilab/lodestar-guard` for guarded runs; the package itself owns the
command shape and the help text.

## File layout

```
src/
├── index.ts                  # main dispatcher
└── commands/
    ├── help.ts               # help text
    ├── report.ts             # `lodestar report`
    ├── guard.ts              # `lodestar guard wrap`
    ├── guard-mcp.ts          # `lodestar guard mcp-proxy`
    ├── approve.ts            # `lodestar approve list/grant/deny`
    ├── action.ts             # `lodestar action list/describe`
    ├── trace.ts              # `lodestar trace inspect`
    ├── probe.ts              # `lodestar probe <name>`
    ├── reflect.ts            # `lodestar reflect <session-id>`
    └── harness.ts            # `lodestar harness run/list`
```

The `approve` command is the reference approval resolver: it writes a
resolution to the MCP proxy's side-channel
(`@qmilab/lodestar-guard-mcp`'s `approvals-channel`), which the running
proxy promotes into its own event log. The CLI never writes the event
log directly — that keeps the proxy the sole writer (the event-log
writer's seq counters are process-local). `approve list` reads the log
read-only to show pending `approval.requested@1` events.

## Invariants

1. **`lodestar report` is the headline surface.** It must produce output
   someone is willing to paste into a GitHub issue or a Slack message.
   When in doubt, polish there before polishing anywhere else.
2. **Other commands have explicit prefixes.** No bare top-level
   commands besides `report`. `lodestar trace` is for debug; the
   user-facing read path is always `lodestar report`.
3. **The CLI registers `fs.read` and `git.status` at startup.** This
   keeps `action list` useful out of the box. Adapters that need
   host-side configuration (network egress, secret-signing) must
   register themselves explicitly from a guarded loop.
4. **Exit code 3 means "resource not found."** This separates
   real-but-empty results (return 0 with a note) from missing
   sessions/events (return 3). Scripts can branch on this.

## When you add a new command

- Add a `src/commands/<name>.ts` exporting a single async function
  that returns `Promise<number>` (the exit code).
- Wire it up in `index.ts`'s `dispatch` switch.
- Update `commands/help.ts` and `README.md`.
- If the command is debug-grade, put it under `trace` or a similar
  area prefix; do not expose it as a top-level command.

## What does not live here

- Any business logic. Commands are thin shells that parse args and
  hand off to the relevant package.
- Probe execution. `lodestar probe <name>` shells out to `bun run
  packs/lodestar-core/probes/<name>.ts` — the probes are the source of
  truth. `lodestar harness run` is a thin shell over
  `@qmilab/lodestar-harness`'s `loadProbePack` + `runPack`; the subprocess
  driving, exit-code interpretation, and event-log recording all live in
  the harness package, not here.
