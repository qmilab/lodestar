# @qmilab/lodestar-cli — CLAUDE.md

The `orrery` binary. Dispatches to `@qmilab/lodestar-trace` for the report and
to `@qmilab/lodestar-guard` for guarded runs; the package itself owns the
command shape and the help text.

## File layout

```
src/
├── index.ts                  # main dispatcher
└── commands/
    ├── help.ts               # help text
    ├── report.ts             # `orrery report`
    ├── guard.ts              # `orrery guard wrap`
    ├── action.ts             # `orrery action list/describe`
    ├── trace.ts              # `orrery trace inspect`
    └── probe.ts              # `orrery probe <name>`
```

## Invariants

1. **`orrery report` is the headline surface.** It must produce output
   someone is willing to paste into a GitHub issue or a Slack message.
   When in doubt, polish there before polishing anywhere else.
2. **Other commands have explicit prefixes.** No bare top-level
   commands besides `report`. `orrery trace` is for debug; the
   user-facing read path is always `orrery report`.
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
- Probe execution. `orrery probe <name>` shells out to `bun run
  research/probes/<name>.ts` — the probes are the source of truth.
