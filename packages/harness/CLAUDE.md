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

Coming in later Batch 4 steps (do not pre-build):

- `Probe` base class + runner. Each probe run is recorded as a
  `synthetic_probe`-quality observation in the event log so probe runs
  are themselves auditable.
- `lodestar harness run --pack <name>` — registered under the existing
  `lodestar` binary in `@qmilab/lodestar-cli`, **not** a new bin.
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

## When extending the pack format

1. Add or change the field in `ProbePackManifestSchema` in
   `@qmilab/lodestar-core` first.
2. An additive optional field is free. Removing or re-typing a field is
   a `PROBE_PACK_SPEC_VERSION` bump, and the loader must reject manifests
   whose `spec_version` it does not understand.
3. Update the loader to resolve the new field, then this doc and the
   README.
