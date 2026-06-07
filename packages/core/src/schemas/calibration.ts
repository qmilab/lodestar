import { z } from "zod"
import { TimestampSchema } from "./common.js"

/**
 * Calibration wire format.
 *
 * These schemas describe what the harness `Calibrator` measures —
 * per-class ECE / Brier / calibration-gap tables and the flagged classes.
 * They lived in `@qmilab/lodestar-harness` while the calibrator was a
 * return-value-only surface; they **graduated to `@qmilab/lodestar-core`**
 * when the durable `calibration.computed@1` event landed (ADR-0011), so
 * the event payload can embed the report (core is the dependency root and
 * cannot import the harness). The harness re-exports them unchanged, so
 * harness consumers are unaffected.
 *
 * The Calibrator stays measure-only: it returns a {@link CalibrationReport}
 * and never writes. Recording a report as a `calibration.computed@1` event
 * is a separate publish step (`lodestar harness calibrate` / the harness
 * `eventLogCalibrationSink`), the same measure/record split the sentinels
 * follow (a `Sentinel` returns findings; `eventLogAlertSink` writes them).
 *
 * Everything here is validated at the calibrator and event-sink boundaries,
 * the same discipline the probe-run observation and sentinel-alert builders
 * hold.
 */

/**
 * Which signal in the event log produced a calibration sample.
 * - `action_outcome`: a belief → decision → action chain where the
 *   action's realised result (terminal phase or an explicit Outcome) is
 *   the label.
 * - `truth_status`: the firewall transitioned the belief's `truth_status`
 *   to `supported` / `contradicted` — the world adjudicating the belief.
 */
export const SampleSourceSchema = z.enum(["action_outcome", "truth_status"])
export type SampleSource = z.infer<typeof SampleSourceSchema>

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
 * is deterministic and testable, and re-running it over the same event
 * window reproduces the report (the property the `cursor` on
 * {@link CalibrationComputedPayloadSchema} makes auditable).
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

// ── The calibration.computed@1 governed event (ADR-0011) ─────────────────

/**
 * What invoked a calibration pass.
 *
 * `cli` — a human ran `lodestar harness calibrate --session <id>`.
 * `programmatic` — a host computed and recorded calibration from its own
 *   code (e.g. a guarded loop at a deliberate checkpoint).
 */
export const CalibrationTriggerSchema = z.enum(["cli", "programmatic"])
export type CalibrationTrigger = z.infer<typeof CalibrationTriggerSchema>

/**
 * The seq window a calibration pass measured.
 *
 * Replayability is by cursor: re-running `calibrate` over the same events
 * in this window — those with `seq` strictly greater than `from_seq` and
 * less than or equal to `to_seq`, within the event's own session slice —
 * reproduces the embedded `report` (the calibrator is a pure function of
 * `(events, config)`). This is what makes calibration drift auditable
 * across time — two `calibration.computed@1` events with overlapping
 * windows can be diffed, and either can be recomputed from the log to
 * verify it was not tampered with. (`seq` is per-project, so the session
 * slice is the natural replay scope; a v0 calibration pass reads one
 * session.)
 */
export const CalibrationCursorSchema = z
  .object({
    from_seq: z
      .number()
      .int()
      .min(-1)
      .describe(
        "Exclusive lower bound. The pass measured events with seq strictly greater than this; " +
          "-1 means from the start of the partition.",
      ),
    to_seq: z
      .number()
      .int()
      .min(-1)
      .describe(
        "Inclusive upper bound: the highest event seq included. Equal to from_seq when the " +
          "window is empty (the pass ran but observed no events).",
      ),
  })
  // An inverted window `(from_seq, to_seq]` with `to_seq < from_seq` selects
  // no events and cannot reproduce a non-empty report — it would persist a
  // `calibration.computed@1` whose replay guarantee is a lie. Reject it at the
  // boundary; the empty window `from_seq === to_seq` is the only equality case
  // (the pass ran but observed nothing), and it satisfies this.
  .refine((c) => c.to_seq >= c.from_seq, {
    message: "to_seq must be >= from_seq (an inverted cursor selects no events)",
    path: ["to_seq"],
  })
export type CalibrationCursor = z.infer<typeof CalibrationCursorSchema>

/**
 * The payload of a `calibration.computed@1` event.
 *
 * The durable record of one calibration pass: the verdict (`report`), the
 * window it measured (`cursor`, for replay), and provenance (`computed_at`,
 * `triggered_by`, `computation_id`). It does NOT enforce anything — the
 * Policy Kernel's arbitrate hook reads an in-process `CalibrationReport`
 * snapshot, not this event (see `docs/architecture/calibrator.md` and
 * ADR-0011). This event exists so calibration drift is auditable and
 * replayable, the way a probe run or a sentinel finding already is.
 *
 * Not signed in v0: the event inherits the log's canonical-hash
 * tamper-evidence, and nothing un-parks a held action on the strength of a
 * calibration *event* (the gate only ever escalates — the conservative
 * direction). If a future slice makes the gate consume persisted
 * calibration events as an authority, signing graduates then, the same
 * staged path the approval resolution followed (ADR-0010).
 */
export const CalibrationComputedPayloadSchema = z.object({
  /** Stable id for this pass, so the audit chain can reference it. */
  computation_id: z.string().min(1),
  triggered_by: CalibrationTriggerSchema,
  /** The seq window measured — re-running `calibrate` over it reproduces `report`. */
  cursor: CalibrationCursorSchema,
  /** The verdict: the full report this pass produced. */
  report: CalibrationReportSchema,
  computed_at: TimestampSchema,
})
export type CalibrationComputedPayload = z.infer<typeof CalibrationComputedPayloadSchema>

/**
 * Event-type literal. Use this constant rather than the bare string so a
 * future rename is grep-safe. Mirrors `reflection.completed@1`.
 */
export const CALIBRATION_COMPUTED_EVENT_TYPE = "calibration.computed" as const
export const CALIBRATION_COMPUTED_SCHEMA_VERSION = "1" as const
