# @qmilab/lodestar-trace — CLAUDE.md

The read side of the event log. The package consumes an existing log and
projects it into the epistemic chain, then renders markdown.

## What lives here

- `src/chain.ts` — `projectChain()` projects a flat event stream into
  the epistemic chain primitives (Observations, Claims, Beliefs,
  Actions, firewall transitions). Pure function. No I/O.
- `src/approvals.ts` — `pendingApprovals(events)` derives the open-hold
  queue (every `approval.requested@1` with no terminal resolution in the
  log) and the `PendingApproval` type. Pure projection in the same family
  as `projectChain` — no I/O, read-only. Graduated here from
  `@qmilab/lodestar-viewer` (issue #138), which re-exports it unchanged so
  a consumer that only wants open holds need not pull in the viewer's HTTP
  server.
- `src/report.ts` — `renderReport()` turns a projection into markdown.
- `src/load.ts` — convenience wrappers around `EventLogReader` for the
  CLI; finds project directories and the default log root.
- `src/inspect.ts` — `describeEvent()` / `findEventById()` for the
  `lodestar trace inspect` debug surface.
- `src/cli.ts` — `lodestar-report` bin. The unified CLI dispatches into
  this.

## Invariants

1. **Read-only.** This package never writes to the event log. Every
   path is `readFile` and pure projection.
2. **Tolerant projection.** Unrecognised events do not throw. They are
   counted but kept in `raw_events` for the optional event-log section.
   This lets the report degrade gracefully when the underlying log is
   ahead of `@qmilab/lodestar-trace`'s known event types.
3. **No schema invention.** When an event payload is structurally
   incompatible with a chain primitive (e.g. `firewall.claim.accepted`
   only carries IDs), the projection records the transition but does
   not attempt to fill in fields it doesn't have. The rendered report
   shows what is actually in the log.
4. **`lodestar report` is the headline surface.** Polish it. Other
   exports (`describeEvent`, `findEventById`, `loadSessionEvents`) can
   be sharper-edged.

## What does not live here

- Live event streaming or subscription — Batch 3 / harness territory.
- OTel export — see the `@qmilab/lodestar-otel-exporter` package, which
  reuses this package's `projectChain()` to project a session into OTel
  GenAI spans (`lodestar otel export`).
- Snapshot reconstruction (replay-grade re-derivation of belief stores
  from events) — out of scope until snapshots ship.

## When adding a new chain primitive

1. Add the primitive in `@qmilab/lodestar-core` first.
2. Update `projectChain()` to recognise the corresponding event type.
3. Add a renderer in `renderReport()` so the new primitive shows up
   in the markdown.
4. If the primitive is something a user actually needs to see, add a
   section header to the report — keep the report scannable, not
   comprehensive.
