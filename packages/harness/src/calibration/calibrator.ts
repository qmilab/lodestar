import type { EventEnvelope } from "@qmilab/lodestar-core"
import { type ScoredPoint, computeMetrics, reliabilityBins } from "./metrics.js"
import { resolveSamples } from "./samples.js"
import {
  type CalibrationClassResult,
  type CalibrationReport,
  CalibrationReportSchema,
  type CalibrationSample,
  type CalibratorOptions,
  type ResolvedCalibratorConfig,
  resolveConfig,
} from "./schema.js"

/**
 * The Calibrator: an offline read over the event log that scores how well
 * stated belief confidence matched realised outcome, per
 * `calibration_class`. It does not block, alert, or mutate beliefs — it
 * measures and returns a {@link CalibrationReport}. Acting on a flag
 * (downweighting an overconfident class) is the Policy Kernel's job,
 * deferred like the sentinels' consuming `arbitrate` hook.
 *
 * Design lock: `docs/architecture/calibrator.md`.
 *
 * Stateless and deterministic: `calibrate(events)` is a pure function of
 * its events and config. Construct once with options and reuse, or call
 * the standalone {@link calibrate} helper.
 */
export class Calibrator {
  readonly config: ResolvedCalibratorConfig

  constructor(options: CalibratorOptions = {}) {
    this.config = resolveConfig(options)
  }

  /** Resolve and score; returns a validated report. */
  calibrate(events: EventEnvelope[]): CalibrationReport {
    return buildReport(resolveSamples(events, this.config), this.config)
  }

  /**
   * The samples the calibrator would score, without aggregating — useful
   * for tests and for a report that wants to break a pooled class down by
   * `source`.
   */
  samples(events: EventEnvelope[]): CalibrationSample[] {
    return resolveSamples(events, this.config)
  }
}

/** One-shot convenience: `calibrate(events, { minSamples: 3 })`. */
export function calibrate(
  events: EventEnvelope[],
  options: CalibratorOptions = {},
): CalibrationReport {
  return new Calibrator(options).calibrate(events)
}

const toPoint = (s: CalibrationSample): ScoredPoint => ({
  confidence: s.confidence,
  correct: s.correct,
})

function buildReport(
  samples: CalibrationSample[],
  config: ResolvedCalibratorConfig,
): CalibrationReport {
  const byClass = new Map<string, CalibrationSample[]>()
  for (const s of samples) {
    const bucket = byClass.get(s.calibration_class)
    if (bucket) bucket.push(s)
    else byClass.set(s.calibration_class, [s])
  }

  const classes: CalibrationClassResult[] = []
  for (const [calibration_class, classSamples] of byClass) {
    const points = classSamples.map(toPoint)
    const metrics = computeMetrics(points, config.bins)
    const { flagged, reason } = flag(metrics, config)
    classes.push({
      calibration_class,
      metrics,
      reliability_bins: reliabilityBins(points, config.bins),
      flagged,
      flag_reason: reason,
    })
  }
  // Deterministic order regardless of event-stream order.
  classes.sort((a, b) => a.calibration_class.localeCompare(b.calibration_class))

  const overall = computeMetrics(samples.map(toPoint), config.bins)
  const flagged_classes = classes.filter((c) => c.flagged).map((c) => c.calibration_class)

  const report: CalibrationReport = {
    sample_count: samples.length,
    classes,
    overall,
    flagged_classes,
    config,
  }
  // Validate at the boundary — a malformed report (NaN metric, bad shape)
  // is a calibrator bug; fail loudly rather than handing back garbage.
  return CalibrationReportSchema.parse(report)
}

/**
 * The flagging policy. A class is flagged only with enough data *and* a
 * material miscalibration — the `min_samples` guard prevents a false
 * "you're miscalibrated" on thin data, which is its own miscalibration.
 * ECE and the gap are separate triggers because they catch different
 * shapes (see the design doc).
 */
function flag(
  metrics: {
    n: number
    ece: number
    calibration_gap: number
    overconfident: boolean
    mean_confidence: number
    empirical_accuracy: number
  },
  config: ResolvedCalibratorConfig,
): { flagged: boolean; reason: string | null } {
  if (metrics.n < config.min_samples) return { flagged: false, reason: null }
  const eceHit = metrics.ece >= config.ece_threshold
  const gapHit = Math.abs(metrics.calibration_gap) >= config.gap_threshold
  if (!eceHit && !gapHit) return { flagged: false, reason: null }

  // Three-way: a class flagged on ECE alone can have a near-zero aggregate
  // gap (per-bin over- and under-confidence cancelling out). Calling that
  // "underconfident" just because `overconfident` (gap > 0) is false would
  // misdescribe correct metrics, so name the neutral/mixed case explicitly.
  const direction =
    metrics.calibration_gap > 1e-9
      ? "overconfident"
      : metrics.calibration_gap < -1e-9
        ? "underconfident"
        : "miscalibrated (mixed)"
  const triggers: string[] = []
  if (gapHit) triggers.push(`gap ${metrics.calibration_gap.toFixed(3)}`)
  if (eceHit) triggers.push(`ECE ${metrics.ece.toFixed(3)}`)
  const reason =
    `${direction}: mean confidence ${metrics.mean_confidence.toFixed(3)} vs ` +
    `accuracy ${metrics.empirical_accuracy.toFixed(3)} ` +
    `(${triggers.join(", ")}) over ${metrics.n} samples`
  return { flagged: true, reason }
}
