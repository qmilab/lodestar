/**
 * The calibration sub-surface of the Lodestar Harness.
 *
 * The Calibrator reads a slice of the event log and scores how well
 * stated belief confidence matched realised outcome, per
 * `calibration_class`, returning per-class ECE / Brier / calibration-gap
 * tables and flagging classes that are materially miscalibrated. It
 * measures; it does not enforce. Design lock:
 * `docs/architecture/calibrator.md`.
 */

export { Calibrator, calibrate } from "./calibrator.js"
export {
  brierScore,
  computeMetrics,
  expectedCalibrationError,
  reliabilityBins,
  type ScoredPoint,
} from "./metrics.js"
export { resolveSamples } from "./samples.js"
export { formatCalibrationReport, type FormatCalibrationOptions } from "./format.js"
export {
  buildCalibrationComputedPayload,
  calibrationCursor,
  DEFAULT_CALIBRATOR_ACTOR,
  eventLogCalibrationSink,
  type BuildCalibrationComputedInput,
  type CalibrationComputedEvent,
  type CalibrationEventSink,
  type EventLogCalibrationSinkConfig,
} from "./event.js"
export {
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
} from "./schema.js"
