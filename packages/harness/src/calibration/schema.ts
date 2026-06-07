import {
  type CalibrationClassResult,
  CalibrationClassResultSchema,
  type CalibrationMetrics,
  CalibrationMetricsSchema,
  type CalibrationReport,
  CalibrationReportSchema,
  type ReliabilityBin,
  ReliabilityBinSchema,
  type ResolvedCalibratorConfig,
  ResolvedCalibratorConfigSchema,
  type SampleSource,
  SampleSourceSchema,
} from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * Calibration return types.
 *
 * The report wire format (metrics, bins, per-class result, config, and the
 * `CalibrationReport` itself) **graduated to `@qmilab/lodestar-core`** when
 * the durable `calibration.computed@1` event landed (ADR-0011) — the event
 * payload embeds the report, and core is the dependency root. They are
 * re-exported here unchanged so harness consumers keep importing calibration
 * types from the harness surface.
 *
 * What stays harness-local: `CalibrationSample` (the resolver's internal
 * prediction/outcome pair — samples are not part of the report wire format),
 * the caller-facing `CalibratorOptions`, and `resolveConfig`. These are
 * runtime concerns of the offline read, not wire format.
 *
 * The calibrator remains measure-only: `calibrate()` returns a
 * `CalibrationReport` and never writes. See `docs/architecture/calibrator.md`.
 */

export {
  type CalibrationClassResult,
  CalibrationClassResultSchema,
  type CalibrationMetrics,
  CalibrationMetricsSchema,
  type CalibrationReport,
  CalibrationReportSchema,
  type ReliabilityBin,
  ReliabilityBinSchema,
  type ResolvedCalibratorConfig,
  ResolvedCalibratorConfigSchema,
  type SampleSource,
  SampleSourceSchema,
}

/**
 * One prediction/outcome pair: the agent stated `confidence` for a belief
 * in `calibration_class`; the world later revealed it `correct` or not.
 * Resolver-internal — the report aggregates these away, so it stays in the
 * harness rather than the core wire format.
 */
export const CalibrationSampleSchema = z.object({
  calibration_class: z.string(),
  confidence: z.number().min(0).max(1),
  correct: z.boolean(),
  belief_id: z.string(),
  source: SampleSourceSchema,
  /** The event subject that produced the label (an action id, or a
   *  `belief_id:to_value`), for audit traceability back to the log. */
  outcome_ref: z.string(),
})
export type CalibrationSample = z.infer<typeof CalibrationSampleSchema>

/** Caller-facing options; every field defaults (see {@link resolveConfig}). */
export interface CalibratorOptions {
  /** equal-width confidence bins for ECE / reliability (default 10) */
  bins?: number
  /** minimum samples before a class can be flagged (default 5) */
  minSamples?: number
  /** ECE at/above which a class is flagged (default 0.1) */
  eceThreshold?: number
  /** |calibration_gap| at/above which a class is flagged (default 0.1) */
  gapThreshold?: number
  /** which signals to resolve samples from (default both) */
  outcomeSources?: SampleSource[]
  /** include `authority: "synthetic"` beliefs (default false — they are
   *  probe artefacts and must not pollute real calibration classes) */
  includeSyntheticAuthority?: boolean
}

export const DEFAULT_CALIBRATOR_CONFIG: ResolvedCalibratorConfig = {
  bins: 10,
  min_samples: 5,
  ece_threshold: 0.1,
  gap_threshold: 0.1,
  outcome_sources: ["action_outcome", "truth_status"],
  include_synthetic_authority: false,
}

/** Fold caller options onto the conservative defaults. */
export function resolveConfig(options: CalibratorOptions = {}): ResolvedCalibratorConfig {
  const config: ResolvedCalibratorConfig = {
    bins: options.bins ?? DEFAULT_CALIBRATOR_CONFIG.bins,
    min_samples: options.minSamples ?? DEFAULT_CALIBRATOR_CONFIG.min_samples,
    ece_threshold: options.eceThreshold ?? DEFAULT_CALIBRATOR_CONFIG.ece_threshold,
    gap_threshold: options.gapThreshold ?? DEFAULT_CALIBRATOR_CONFIG.gap_threshold,
    outcome_sources: options.outcomeSources ?? [...DEFAULT_CALIBRATOR_CONFIG.outcome_sources],
    include_synthetic_authority:
      options.includeSyntheticAuthority ?? DEFAULT_CALIBRATOR_CONFIG.include_synthetic_authority,
  }
  // Validate the resolved config so a nonsensical override (bins: 0,
  // outcome_sources: []) fails loudly here rather than producing NaN
  // metrics or an empty resolution downstream.
  return ResolvedCalibratorConfigSchema.parse(config)
}
