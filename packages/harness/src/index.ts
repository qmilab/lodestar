/**
 * @qmilab/lodestar-harness
 *
 * The Lodestar Harness: probe packs, sentinels, and calibrators that
 * exercise and audit the epistemic chain. This is the developer entry
 * point that turns the probe scripts (the first-party pack
 * `packs/lodestar-core/`) into an installable, packageable surface
 * external authors can plug into.
 *
 * Surfaces shipped so far:
 * - Probe-pack loader (`loadProbePack`) — validates a
 *   `lodestar.probe-pack.json` manifest (schema in `@qmilab/lodestar-core`)
 *   and resolves its probe files. Validation only; never executes.
 * - Probe authoring surface (`Probe`, `runProbeAsScript`) — the contract
 *   new probes declare themselves against. The 17 first-party probes
 *   predate it and are intentionally left as-is (probes are spec).
 * - Pack runner (`runPack`, `runProbe`) — a subprocess driver that runs a
 *   loaded pack and reports the aggregate result. Drives
 *   `lodestar harness run`.
 * - Event-log recorder (`eventLogRecorder`) — records each probe run as a
 *   synthetic `observation.recorded` event so runs are themselves auditable.
 *
 * Still to come (do not pre-build): the Sentinel base class + sentinels,
 * and the Calibrator. See `docs/roadmap.md` (Batch 4).
 */

export {
  loadProbePack,
  ProbePackError,
  type LoadedProbe,
  type LoadedProbePack,
} from "./pack/loader.js"

export {
  Probe,
  type ProbeResult,
  type ProbeSpec,
  formatProbeReport,
  runProbeAsScript,
} from "./probe.js"

export {
  runPack,
  runProbe,
  type PackRunResult,
  type ProbeRunOutcome,
  type ProbeRunRecorder,
  type RunPackOptions,
} from "./runner.js"

export { eventLogRecorder, type EventLogRecorderConfig } from "./recorder.js"

export {
  buildProbeRunObservation,
  PROBE_RUN_OBSERVATION_SCHEMA_KEY,
  ProbeRunObservationPayloadSchema,
  type ProbeRunObservationInput,
  type ProbeRunObservationPayload,
} from "./observation.js"
