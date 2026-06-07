# ADR-0011: Durable `calibration.computed@1` — calibration drift becomes auditable and replayable

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Nandan, Claude
- **Related:** ADR-0010 (the staged "graduate the wire format when its consumer
  lands, sign when it becomes a forgery boundary" pattern this follows),
  ADR-0001/0002/0003 (the same measure→record→enforce staging the sentinels use),
  `docs/architecture/calibrator.md`, `docs/architecture/policy-kernel.md`,
  `packages/core/src/schemas/calibration.ts`,
  `packages/harness/src/calibration/event.ts`,
  `packages/cli/src/commands/harness.ts`,
  `packs/lodestar-core/probes/calibration-event-is-durable.ts`

## Context

P3, second (and final) slice of the post-P2 security/hardening track. The
`Calibrator` reads the event log and scores stated belief `confidence` against
realised outcome per `calibration_class`, returning a `CalibrationReport`
(per-class ECE / Brier / calibration-gap, the reliability bins, the flagged
classes). The Policy Kernel's arbitrate hook *consumes* that verdict — a backing
belief in a flagged class escalates its action to `pending_approval` — by reading
a structural `CalibrationSnapshot.flagged_classes` the host passes into
`ArbitrationContext`. That snapshot is an **in-process** `CalibrationReport`, held
in the `SentinelArbiter` and handed to the gate synchronously.

The gap: the verdict is ephemeral. It is computed at runtime, injected into one
arbitration, and never recorded. So calibration drift is neither auditable nor
replayable — you cannot ask "what did the calibrator say over this session, and
can I recompute it to verify?" The other two harness surfaces already close this:
a probe run writes a synthetic `observation.recorded`, a sentinel finding writes
a `sentinel.alerted@1`. `calibrator.md` deferred the consistent end-state — a
`calibration.computed@1` governance event — explicitly *"until the Policy Kernel
consumes it… committing a core wire format before its consumer exists is exactly
the premature lock-in the kickoff warns against."* That consumer landed with the
arbitrate hook (P1). The deferral condition is met; this ADR graduates the wire
format.

## Decision

**Record a calibration pass as a durable `calibration.computed@1` event — without
the Calibrator ever growing a write path.** Measure stays separate from record,
exactly as it is for the sentinels.

1. **The report wire format graduates to `@qmilab/lodestar-core`.** The pure
   report schemas (`CalibrationMetrics`, `ReliabilityBin`, `CalibrationClassResult`,
   `ResolvedCalibratorConfig`, `SampleSource`, `CalibrationReport`) move from the
   harness to `core/src/schemas/calibration.ts`; the harness re-exports them
   unchanged, so every existing harness consumer is untouched. They *must* live in
   core because the event payload embeds the report and core is the dependency
   root — it cannot import the harness. Duplicating the schema in core was rejected:
   two sources of truth for ECE/Brier semantics drift.

2. **`calibration.computed@1` = verdict + replay cursor + provenance.** The payload
   is `{ computation_id, triggered_by, cursor: {from_seq, to_seq}, report,
   computed_at }`. The `cursor` is the load-bearing addition: `calibrate` is a pure
   function of `(events, config)`, so re-running it over the same events in
   `(from_seq, to_seq]` (within the event's session slice — `seq` is per-project,
   and a v0 pass reads one session) reproduces the embedded `report`. That is what
   makes drift **replayable** — two events with overlapping windows can be diffed,
   and either can be recomputed from the log to verify it was not tampered with.

3. **Emission is a separate publish step; the Calibrator stays measure-only.**
   `calibrate()` returns a report and never writes (harness invariant 11 stands).
   A host that wants the verdict durable hands the report to
   `buildCalibrationComputedPayload` (pure; the clock is injected) and appends it
   through `eventLogCalibrationSink` — an injected sink that mirrors
   `eventLogAlertSink` byte-for-byte in shape, so event-log I/O lives in one place
   and the calibrator/runner cores stay I/O-free. The trigger is a new
   `lodestar harness calibrate --session <id>` (prints the markdown report, then
   records the event unless `--no-emit`). This is the same measure→record split the
   sentinels use: a `Sentinel` returns findings; a sink writes them.

4. **Not signed in v0 — deliberately, and not the same boundary as ADR-0010.** The
   event inherits the log's canonical-hash tamper-evidence (the
   `calibration-event-is-durable` probe pins `payload_hash == canonicalHash(payload)`
   across the round-trip). It is **not** signed because nothing un-parks a held
   action on the strength of a calibration *event*: the gate reads the in-process
   snapshot, and a calibration flag only ever *escalates* (allow → pending_approval),
   the conservative direction. The forgery surface ADR-0010 closed was the opposite
   — a forged grant that *removes* a hold. If a future slice makes the gate consume
   *persisted* calibration events as an authority, the dangerous forgery would be an
   event that *suppresses* a flag, and signing graduates then — the same staged path
   approvals followed. Recorded here so that decision is made on purpose, not by
   omission.

## Consequences

- Calibration is now auditable and replayable the way a probe run or a sentinel
  finding already is. The `calibration-event-is-durable` probe pins all four
  invariants: measure ≠ write (running `calibrate()` writes zero events; the count
  goes 0→1 only on the explicit sink call), durable + schema-valid, tamper-evident
  hash, and replayable-from-cursor. `lodestar-core` grows to **43** probes (47
  total).
- **The enforcement path is unchanged.** The gate still reads the in-process
  `CalibrationSnapshot`; this slice is purely additive (a new event type, a new CLI
  verb, a graduated schema). No existing probe changed — the move is transparent
  behind the harness re-export, and `confidence-drift` / `calibration-flag-escalates-action`
  pass untouched.
- `calibrator.md`'s "what's not wired" list shrinks: the `calibration.computed@1`
  wire format and the `lodestar harness calibrate` CLI both land. Still deferred:
  the Policy-Kernel loop that *downweights* a flagged class's confidence, and the
  temporal drift view.
- The event reads cleanly through `projectChain` (unknown types fall through to
  `raw_events`), so `lodestar report` / the viewer tolerate it with no renderer
  change. A richer render is an additive follow-up, not a blocker.

## Alternatives considered

- **Duplicate the report schema in core, map harness→core at emit.** Rejected — two
  copies of the metrics schema drift. Moving the canonical definition to core and
  re-exporting keeps one source of truth.
- **Emit from inside `calibrate()` when a sink is configured.** Rejected — it
  collapses the measure/enforce boundary invariant 11 protects. The sentinels prove
  the separate-sink shape works; calibration follows it.
- **Sign the event now (mirror ADR-0010).** Rejected for v0 — it is not a forgery
  boundary yet (the gate reads the in-process snapshot, and a flag only escalates).
  Signing pre-emptively adds key-management ceremony with no threat to answer.
  Staged, like every other crypto decision in this repo.
- **Embed every observed event id (mirror `reflection.completed`'s
  `observed_event_ids`).** Rejected — a calibration window is often a whole session;
  listing every id bloats the payload. The cursor plus the calibrator's determinism
  is a sufficient, compact replay key.
