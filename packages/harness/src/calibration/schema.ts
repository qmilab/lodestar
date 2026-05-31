import { z } from "zod"

/**
 * Calibration wire/return types. These live in the harness, not in
 * `@qmilab/lodestar-core`: the calibrator is a return-value surface in
 * v0, not an event payload. When the Policy Kernel needs to *consume*
 * calibration verdicts (downweight an overconfident class), a
 * `calibration.computed@1` core wire format graduates then — the same
 * staged path the sentinel `arbitrate` hook follows. See
 * `docs/architecture/calibrator.md`.
 *
 * Everything here is validated at the calibrator boundary, the same
 * discipline the probe-run observation and sentinel-alert builders hold.
 */

/**
 * Which signal in the event log produced a sample.
 * - `action_outcome`: a belief → decision → action chain where the
 *   action's realised result (terminal phase or an explicit Outcome) is
 *   the label.
 * - `truth_status`: the firewall transitioned the belief's `truth_status`
 *   to `supported` / `contradicted` — the world adjudicating the belief.
 */
export const SampleSourceSchema = z.enum(["action_outcome", "truth_status"])
export type SampleSource = z.infer<typeof SampleSourceSchema>

/**
 * One prediction/outcome pair: the agent stated `confidence` for a belief
 * in `calibration_class`; the world later revealed it `correct` or not.
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

/** The scored metrics for a set of samples (one class, or the pool). */
export const CalibrationMetricsSchema = z.object({
  n: z.number().int().nonnegative(),
  /** mean of stated confidence */
  mean_confidence: z.number().min(0).max(1),
  /** realised positive rate, mean(correct) */
  empirical_accuracy: z.number().min(0).max(1),
  /** mean((p - y)^2); 0 is perfect, lower is better */
  brier_score: z.number().min(0).max(1),
  /** expected calibration error over equal-width confidence bins */
  ece: z.number().min(0).max(1),
  /** signed mean_confidence - empirical_accuracy; > 0 is overconfident */
  calibration_gap: z.number().min(-1).max(1),
  overconfident: z.boolean(),
})
export type CalibrationMetrics = z.infer<typeof CalibrationMetricsSchema>

/** One non-empty bin of a reliability diagram. */
export const ReliabilityBinSchema = z.object({
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
  n: z.number().int().positive(),
  mean_confidence: z.number().min(0).max(1),
  empirical_accuracy: z.number().min(0).max(1),
})
export type ReliabilityBin = z.infer<typeof ReliabilityBinSchema>

/** Per-class result: metrics, the reliability bins, and the verdict. */
export const CalibrationClassResultSchema = z.object({
  calibration_class: z.string(),
  metrics: CalibrationMetricsSchema,
  /** non-empty bins only, ascending by `lower` */
  reliability_bins: z.array(ReliabilityBinSchema),
  flagged: z.boolean(),
  /** human-legible reason when flagged; `null` when not */
  flag_reason: z.string().nullable(),
})
export type CalibrationClassResult = z.infer<typeof CalibrationClassResultSchema>

/** The thresholds and toggles actually applied, echoed for reproducibility. */
export const ResolvedCalibratorConfigSchema = z.object({
  bins: z.number().int().positive(),
  min_samples: z.number().int().positive(),
  ece_threshold: z.number().min(0).max(1),
  gap_threshold: z.number().min(0).max(1),
  outcome_sources: z.array(SampleSourceSchema).min(1),
  include_synthetic_authority: z.boolean(),
})
export type ResolvedCalibratorConfig = z.infer<typeof ResolvedCalibratorConfigSchema>

/**
 * The calibrator's output: per-class tables, a pooled `overall` block,
 * the flagged class names, and the config that produced it. A pure
 * function of `(events, config)` — no clock, no scope inference — so it
 * is deterministic and testable.
 */
export const CalibrationReportSchema = z.object({
  /** total samples resolved and included (after exclusions) */
  sample_count: z.number().int().nonnegative(),
  classes: z.array(CalibrationClassResultSchema),
  overall: CalibrationMetricsSchema,
  flagged_classes: z.array(z.string()),
  config: ResolvedCalibratorConfigSchema,
})
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>

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
