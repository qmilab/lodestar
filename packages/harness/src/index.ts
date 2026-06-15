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
 * - Sentinel surface (`Sentinel`, `SentinelRunner`, the three first-party
 *   sentinels, the `FIRST_PARTY_SENTINELS` registry a pack manifest
 *   resolves its sentinel ids against, `eventLogAlertSink`) — an async
 *   tail of the event stream that emits `sentinel.alerted@1` events.
 *   Non-blocking by design; see `docs/architecture/sentinels.md`.
 * - Calibrator surface (`Calibrator`, `calibrate`, the metrics, and
 *   `formatCalibrationReport`) — an offline read over the event log that
 *   scores stated confidence against realised outcome per
 *   `calibration_class` and flags miscalibration. Measures, never
 *   enforces, never emits; see `docs/architecture/calibrator.md`. The
 *   separate publish step (`buildCalibrationComputedPayload` +
 *   `eventLogCalibrationSink`) records a report as a durable
 *   `calibration.computed@1` event (ADR-0011).
 */

export {
  loadProbePack,
  loadProbePackFromSource,
  ProbePackError,
  type LoadProbePackOptions,
  type LoadedProbe,
  type LoadedProbePack,
  type LoadedSentinel,
} from "./pack/loader.js"

export {
  resolvePackSource,
  type ResolvedPackSource,
  type ResolvePackSourceOptions,
} from "./pack/source.js"

export { resolveNpmSource, type ResolveNpmOptions } from "./pack/npm-source.js"
export { resolveGitSource, type ResolveGitOptions } from "./pack/git-source.js"

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
  DEFAULT_SENTINEL_ACTOR,
  DEFAULT_SESSION_END_EVENTS,
  Sentinel,
  SentinelRunner,
  type SentinelAlert,
  type SentinelAlertSink,
  type SentinelFinding,
  type SentinelRunnerOptions,
  asActionView,
  asBeliefView,
  asDecisionView,
  asEvidenceSetView,
} from "./sentinel.js"

export {
  LowConfidenceActionSentinel,
  SuspiciousMemoryOriginSentinel,
  AnomalousToolSequenceSentinel,
  DEFAULT_SUSPICIOUS_SEQUENCES,
  FIRST_PARTY_SENTINELS,
  type SentinelFactory,
  type SuspiciousSequence,
  type ToolStepMatcher,
} from "./sentinels/index.js"

export { eventLogAlertSink, type EventLogAlertSinkConfig } from "./sentinel-recorder.js"

export {
  Calibrator,
  calibrate,
  brierScore,
  computeMetrics,
  expectedCalibrationError,
  reliabilityBins,
  type ScoredPoint,
  resolveSamples,
  formatCalibrationReport,
  type FormatCalibrationOptions,
  type CalibrationClassResult,
  type CalibrationMetrics,
  type CalibrationReport,
  CalibrationReportSchema,
  type CalibrationSample,
  CalibrationSampleSchema,
  type CalibratorOptions,
  DEFAULT_CALIBRATOR_CONFIG,
  type ReliabilityBin,
  type ResolvedCalibratorConfig,
  resolveConfig,
  type SampleSource,
  buildCalibrationComputedPayload,
  calibrationCursor,
  DEFAULT_CALIBRATOR_ACTOR,
  eventLogCalibrationSink,
  type BuildCalibrationComputedInput,
  type CalibrationComputedEvent,
  type CalibrationEventSink,
  type EventLogCalibrationSinkConfig,
} from "./calibration/index.js"

export {
  buildProbeRunObservation,
  PROBE_RUN_OBSERVATION_SCHEMA_KEY,
  ProbeRunObservationPayloadSchema,
  type ProbeRunObservationInput,
  type ProbeRunObservationPayload,
} from "./observation.js"
