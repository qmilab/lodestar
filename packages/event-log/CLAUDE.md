# @qmilab/lodestar-event-log — CLAUDE.md

Append-only NDJSON event log writer and reader. The persistence substrate the entire epistemic chain emits into; everything downstream (`@qmilab/lodestar-trace`, the lodestar CLI, future replay) reads from here.

## What lives here

- **Writer** (`src/writer.ts`) — `EventLogWriter.append()`. Hydrates `seq` and `logical_clock` counters from disk on first touch; allocates new values atomically from module-level state; validates the envelope through Zod; writes one canonical JSON line per envelope.
- **Reader** (`src/reader.ts`) — `EventLogReader.readAll(projectId)` and `readSession(projectId, sessionId)`. Tolerant of malformed lines during hydration scan, strict during read (`EventEnvelopeSchema.parse`).
- **`canonicalHash()`** — sha-256 over the canonical JSON of a value, with sorted object keys. Used by the writer when the caller does not supply `payload_hash`; replay-safe.

## Invariants

1. **Append-only.** No update, no delete, no truncate. The reader is the only way to project a state out of the log; the log itself is the source of truth.

2. **Monotonic per-partition `seq`.** Every envelope in a given `${rootDir, project_id}` partition has a strictly increasing seq. The reader sorts on this; gaps or duplicates would silently corrupt downstream projections.

3. **Module-shared seq across writer instances.** Multiple `EventLogWriter` instances pointing at the same partition share `sharedNextSeq` via module-level state. Guard's `runGuarded`-per-session pattern relies on this: each call constructs a new writer, but the writers all allocate seq from the same counter. Replacing module state with per-instance state would break that pattern silently.

4. **One canonical line per envelope.** The writer emits `JSON.stringify(envelope) + "\n"` exactly. The reader splits on newline and parses each non-empty line. Anything that interleaves bytes between writes breaks the reader.

5. **Per-partition append serialization (Round 5, pre-Batch 3).** `sharedAppendLocks` is a module-level async mutex keyed by partition. Every `append()` chains onto the previous append for the same partition; concurrent appends (across instances or within one) serialize through one logical writer. Without this, two concurrent `appendFile` calls with payloads > PIPE_BUF (~4 KiB on Linux) can interleave on disk and produce torn writes. **Choice rationale:** the MCP proxy (Batch 3) is single-process per the roadmap, so a process-local mutex is sufficient and avoids the file-lock dependency + orphan-lockfile failure mode. If a multi-process consumer ever appears, a file-lock layer can be added on top without changing this interface.

## What does not live here

- The envelope schema itself: see `@qmilab/lodestar-core/schemas/event`.
- Cross-process write coordination (file locks): out of scope until a multi-process consumer exists.
- Querying / indexing / projection over the log: see `@qmilab/lodestar-trace`.

## When you change writer behavior

1. The reader must keep accepting any envelope the writer emits. Schema changes route through `@qmilab/lodestar-core` and require a `schema_version` bump on the envelope.
2. If you alter the module-shared state (`sharedNextSeq`, `sharedNextLogicalClock`, `sharedAppendLocks`), keep `_resetEventLogStateForTests()` in sync. Probes rely on that for isolation between scenarios.
3. The `event_log_single_writer` probe must keep passing — 100 concurrent appends, 8 KiB payloads, no duplicate seq, no torn writes. If you find yourself wanting to weaken the serialization, stop and verify the use case justifies it.
