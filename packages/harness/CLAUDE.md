# @qmilab/lodestar-harness — CLAUDE.md

The Harness developer surface. Probe packs, sentinels, and calibrators
that exercise and audit the epistemic chain. Built incrementally across
Batch 4; see `docs/roadmap.md` (Batch 4) and the kickoff/sequencing in
`docs/architecture/batch-4-kickoff.md`.

## What lives here

- `src/pack/loader.ts` — `loadProbePack()`. Reads a
  `lodestar.probe-pack.json` manifest (schema in
  `@qmilab/lodestar-core`), validates it, and resolves probe files to
  absolute paths. Returns a `LoadedProbePack`. Raises `ProbePackError`
  on any failure. Filesystem I/O lives here, not in core.
- `src/probe.ts` — the `Probe` authoring surface (`Probe` base class,
  `ProbeSpec`, `ProbeResult`, `runProbeAsScript`, `formatProbeReport`).
  The contract *new* probes declare themselves against. The 17
  first-party probes predate it and are deliberately left as standalone
  scripts (probes are spec — see invariant 4). The runner never imports
  a `Probe`; it drives files by exit code, so a probe authored through
  this surface is indistinguishable from a hand-rolled one.
- `src/runner.ts` — `runPack()` / `runProbe()`. A **subprocess driver**:
  each probe is run as `bun run <file>` and its exit code is the verdict
  (0 passes, anything else fails). Runs every probe (a failure does not
  abort the run) and returns a `PackRunResult`. The runner core depends
  on nothing but `node:child_process`; recording is injected.
- `src/recorder.ts` — `eventLogRecorder()`. Builds the injected
  `ProbeRunRecorder` that writes each run as a synthetic
  `observation.recorded` event. This is where the event-log dependency
  lives, keeping the runner core I/O-free.
- `src/observation.ts` — the `harness.probe_run@1` observation schema and
  `buildProbeRunObservation()`. Registered on import (adapter precedent).

Coming in later Batch 4 steps (do not pre-build):

- `Sentinel` base class + the three sentinels.
- `Calibrator`.

## Invariants

1. **Core owns the wire format; the harness owns resolution.** The
   manifest schema (`ProbePackManifestSchema`) lives in
   `@qmilab/lodestar-core` and does no I/O. Anything that touches the
   filesystem, spawns a process, or reads the event log lives here.
2. **The loader validates; it does not execute.** Loading a pack must
   never run a probe. Keep resolution and execution separate so a pack
   can be inspected (`lodestar harness list`) without side effects.
3. **A pack manifest is potentially third-party.** Probe `file` paths
   are resolved relative to the pack root and rejected if they escape it.
   Treat manifests as untrusted input.
4. **Probes are spec, not scaffolding.** When probes move into packs
   (kickoff step 4) they are repackaged, not rewritten. Do not edit a
   probe to match changed code; new behaviour gets a new probe.
5. **v0 resolves `local` packs only.** `source_type: "npm"` is valid in
   the schema but the loader rejects it with a clear error until npm
   resolution ships.
6. **The runner drives files, not classes.** Execution is a subprocess
   spawn (`bun run <file>`) keyed on exit code. This is what keeps the 17
   first-party probes (invariant 4) unchanged and lets external/future
   probes be authored in any way that ends in a `bun run`-able script.
   Do not switch the runner to in-process import — that would force every
   probe to export a `Probe`, i.e. rewrite the spec.
7. **A probe run is itself auditable.** When recording is enabled the
   runner writes one `trust: "synthetic"` observation per run. Synthetic
   is non-negotiable: a probe run must never be able to promote a real
   belief. Recording is injected (`ProbeRunRecorder`) so the runner core
   stays I/O-free and testable with a capturing sink.

## When extending the pack format

1. Add or change the field in `ProbePackManifestSchema` in
   `@qmilab/lodestar-core` first.
2. An additive optional field is free. Removing or re-typing a field is
   a `PROBE_PACK_SPEC_VERSION` bump, and the loader must reject manifests
   whose `spec_version` it does not understand.
3. Update the loader to resolve the new field, then this doc and the
   README.
