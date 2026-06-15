# @qmilab/lodestar-harness — CLAUDE.md

The Harness developer surface. Probe packs, sentinels, and calibrators
that exercise and audit the epistemic chain. Built incrementally across
Batch 4; see `docs/roadmap.md` (Batch 4).

## What lives here

- `src/pack/loader.ts` — `loadProbePack(target, options?)`. Reads a
  `lodestar.probe-pack.json` manifest (schema in
  `@qmilab/lodestar-core`), validates it, resolves probe files to
  absolute paths, and resolves each declared sentinel id against the
  first-party registry (`LoadedSentinel { id, create }`). Returns a
  `LoadedProbePack`. Raises `ProbePackError` on any failure. Filesystem
  I/O lives here, not in core.
  **Verify-on-load (#88, ADR-0017):** the loader verifies the manifest's
  Ed25519 signature (core's `verifyProbePackManifestSignature`) against
  `options.authorizedAuthorKeys` (operator-pinned author keys), and — for a
  signed pack — recomputes the `content_digest` over the resolved probe files
  and rejects a mismatch, so a swapped probe byte is caught even under a valid
  signature (the re-pointed-ref / re-published-artifact hole). An *unsigned* pack
  is rejected unless `options.allowUnsigned: true` (no silent default — the
  first-party in-repo packs and the `lodestar harness` CLI's bare-name shortcuts
  pass it explicitly; signing the first-party packs is deferred to the publish
  CLI, #90). A *signed* pack is always fully verified regardless of the flag. The
  content-digest computation (fs) lives here; the canonical hash + signature
  check (pure) live in core — the same core-owns-format / harness-owns-resolution
  split. Reject set: signature absent (unless `allowUnsigned`), tampered manifest
  (`payload_hash` mismatch), signer ≠ declared `author_id`, signer not pinned,
  non-ed25519, bad signature bytes, on-disk content-digest mismatch.
  **Source resolution (#86, ADR-0018):** `loadProbePackFromSource(ref, opts)` (and
  the lower-level `resolvePackSource`) fetch a pinned `PackSourceRef` to a confined
  directory before loading — `pack/source.ts` (dispatcher), `npm-source.ts`
  (registry-metadata read + dual integrity check + `tar` extract), `git-source.ts`
  (clone + checkout at a full SHA, hooks off), `tar.ts` (system-`tar` extract +
  confinement), `run.ts` (the one scoped-env subprocess runner). Non-executing and
  no new dependency; see invariant 5.
  **Shared resolution (#90, ADR-0019):** `pack/resolve.ts` factors the loader's
  probe-file resolution (the escape + symlink-realpath containment checks),
  `computePackContentDigest`, and the manifest read/locate out of the loader, so
  the loader (verify path) and the publisher (sign path) compute the digest over
  *the same bytes the same way* — a publish that digested differently than the
  loader verifies would be a latent forgery hole.
- `src/pack/publish.ts` — `publishProbePack(opts)`, the author side (#90,
  ADR-0019). Freeze files → `content_digest` → set `author_id` → sign the canonical
  manifest → write in place → **self-verify** by re-loading through `loadProbePack`
  (author pinned, `allowUnsigned` off). Signs *after* freezing (ADR-0016 §2): tooling
  cannot sign a manifest then mutate its files. Returns the signed manifest, its
  hash, and the author's derived SPKI public key (the consumer pin).
- `src/pack/add.ts` — `addProbePack(opts)`, the consumer side (#90, ADR-0019):
  resolve → verify → install → record. Resolves via `loadProbePackFromSource` (the
  non-executing fetch + #88 verify-on-load, so **no pack code runs before
  verification**), then copies the verified bytes into `<installRoot>/<name>` and
  re-loads + re-verifies the installed copy (a TOCTOU closure), then records the
  immutable pin + canonical manifest hash in the lockfile. Fail closed.
- `src/pack/trust-config.ts` / `src/pack/lockfile.ts` — the consumer's
  `pack-trust.json` (pinned author keys, mirroring the proxy's
  `approvals.authorized_keys`) and `packs.lock.json` (recorded pins) IO. The
  formats are core schemas (`schemas/pack-registry.ts`); these are the fs readers/
  writers (atomic temp+rename for the lockfile). Driven by `lodestar pack`.
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
- `src/sentinel.ts` — the `Sentinel` base class, the `SentinelRunner`
  (push `observe` / batch `sweep`), and the tolerant event-payload
  projections (`asActionView` etc.). A sentinel is a stateful watcher: it
  is fed events one at a time and returns `SentinelFinding`s; the runner
  turns those into `sentinel.alerted@1` events. Design lock:
  `docs/architecture/sentinels.md`.
- `src/sentinels/` — the three first-party sentinels:
  `low-confidence-action`, `suspicious-memory-origin`,
  `anomalous-tool-sequence`, plus `registry.ts` — the
  `FIRST_PARTY_SENTINELS` map (`id → factory`) a pack manifest's
  `sentinels` ids resolve against. Each key equals the constructed
  sentinel's `name`.
- `src/sentinel-recorder.ts` — `eventLogAlertSink()`. The injected sink
  that appends each alert as a `sentinel.alerted@1` event. Mirrors the
  probe-run `eventLogRecorder`; the runner core stays I/O-free.
- `src/calibration/` — the `Calibrator`. An offline read over the event
  log that scores stated belief `confidence` against realised outcome per
  `calibration_class` and returns a `CalibrationReport` (per-class ECE /
  Brier / calibration-gap tables, the reliability bins, and the flagged
  classes). `metrics.ts` is the pure, unit-tested math; `samples.ts`
  resolves `(confidence, correct)` pairs from the log through tolerant
  views (both an action's terminal phase / `Outcome` events and
  `truth_status` transitions); `calibrator.ts` aggregates and flags;
  `format.ts` renders the markdown table a calibration-paper draft pastes;
  `event.ts` is the separate publish step (`buildCalibrationComputedPayload`
  + `eventLogCalibrationSink`) that records a report as a durable
  `calibration.computed@1` event (ADR-0011). The report wire format itself
  graduated to `@qmilab/lodestar-core` (`schemas/calibration.ts`) so the event
  payload can embed it; `schema.ts` re-exports it unchanged. It measures, never
  enforces, never emits — the host emits. Design lock:
  `docs/architecture/calibrator.md`.

The three sentinels are now folded into the `coding-agent-safety` pack:
its manifest declares them under `sentinels` (by id), the loader resolves
them against `FIRST_PARTY_SENTINELS`, and `lodestar harness list` prints
them. This was the last Batch 4 deliverable.

Coming in later Batch 4+ steps (do not pre-build):

- The `arbitrate` hook that *consumes* sentinel alerts (lands with the
  Policy Kernel; see `docs/architecture/sentinels.md` "What's wired").
- Cross-session persistence for sentinels (Postgres stores, step 7).
- Per-pack sentinel construction-option overrides and third-party
  (file-referenced) sentinels — a later refinement on the registry
  resolution; v0 resolves first-party ids with default options.

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
5. **Source resolution is upstream of loading; verification is unchanged
   (#86, ADR-0018).** `loadProbePack(path)` loads bytes already on disk and
   no longer gates on `source_type` — once the bytes are present every
   source type loads identically. `loadProbePackFromSource(ref, opts)`
   resolves a pinned `PackSourceRef` (`local` / `npm` / `git`) to a confined
   directory via a **non-executing fetch**, then delegates to `loadProbePack`
   so #88's verify-on-load applies to the *fetched* bytes. The pins are
   immutable (npm: exact version + SRI integrity, checked against both the
   registry's advertised hash and the downloaded bytes; git: a full 40-hex
   commit SHA — a branch/tag is rejected). Resolution runs **no** pack-authored
   code (no `npm install` lifecycle scripts, no git hooks): npm extraction
   shells to system `tar` with self-enforced confinement (reject symlinks /
   escapes), git clones with hooks disabled (`core.hooksPath=/dev/null`, scoped
   env mirroring `adapter-git`'s `baseGitEnv`) and removes `.git`. This is a
   TS/process-level boundary that delivers *authentic, inert bytes*; making
   those bytes **safe to run** is the orthogonal runner-side gap (#114).
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
8. **Sentinels alert; they never block.** A sentinel emits a
   `sentinel.alerted@1` event and stops there. It does not call back into
   the Action Kernel and cannot stop an action mid-flight (Q7 of the
   reflection design doc). The consuming `arbitrate` hook now exists, but it
   lives in `@qmilab/lodestar-policy-kernel` (it *reads* landed alerts and
   escalates the next dependent action) — the harness boundary did not move.
   Do not add a blocking path from a sentinel here.
9. **Sentinels read the stream defensively.** Event payloads are
   `z.unknown()` and hosts emit varying completeness. Sentinels project
   through loose views (`asActionView` etc.), never the strict core
   schemas, and skip a payload that lacks the minimum rather than throwing.
10. **`sentinel.alerted@1` is a governance event, not an Observation.**
    Like `reflection.completed@1`, its payload is the event payload
    directly and is NOT in the observation registry. Recording is injected
    (`eventLogAlertSink`), same discipline as the probe recorder.
11. **The Calibrator measures; it never enforces, and it never emits.**
    `calibrate()` reads the log and returns a `CalibrationReport`. It does not
    write a revision, transition a belief, or emit an event. Acting on a flag
    (downweighting an overconfident class) is the Policy Kernel's job — its
    arbitrate hook now consumes `CalibrationReport.flagged_classes` to escalate
    a backing action, the same way it reads sentinel alerts. The calibrator
    stays return-value-only; do not add a write path from it. **Recording a
    returned report as a durable `calibration.computed@1` event is a *separate*
    publish step** (`buildCalibrationComputedPayload` + the injected
    `eventLogCalibrationSink`, driven by `lodestar harness calibrate`; ADR-0011)
    — exactly the measure→record split the sentinels use (a `Sentinel` returns
    findings; `eventLogAlertSink` writes them). The wire format lives in
    `@qmilab/lodestar-core` (`schemas/calibration.ts`) and is re-exported here;
    the event is not signed in v0 (audit/replay, not a forgery boundary — the
    gate reads an in-process snapshot, not the event).
12. **Synthetic beliefs are excluded from calibration by default.** A
    belief with `authority: "synthetic"` is a probe artefact and must not
    pollute a real `calibration_class` — the same isolation the firewall
    enforces ("synthetic-probe evidence cannot adopt a real belief").
    `includeSyntheticAuthority` opts in; do not flip the default.
13. **The calibrator reads the stream defensively, same as sentinels.**
    Its sample resolver projects through loose `.passthrough()` views and
    skips a payload that lacks the minimum. `calibrate()` is a pure,
    deterministic function of `(events, config)` — no clock, no scope
    inference — so a report is reproducible and the math is testable in
    isolation (`metrics.test.ts`).

## When extending the pack format

1. Add or change the field in `ProbePackManifestSchema` in
   `@qmilab/lodestar-core` first.
2. An additive optional field is free. Removing or re-typing a field is
   a `PROBE_PACK_SPEC_VERSION` bump, and the loader must reject manifests
   whose `spec_version` it does not understand.
3. Update the loader to resolve the new field, then this doc and the
   README.
