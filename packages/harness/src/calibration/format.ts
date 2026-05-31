import type { CalibrationReport } from "./schema.js"

/**
 * Render a {@link CalibrationReport} as scannable markdown — the artefact
 * a calibration-paper draft or a CLI report pastes. Pure string building;
 * no I/O.
 */
export interface FormatCalibrationOptions {
  /** optional heading line above the tables */
  title?: string
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const sign = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`

export function formatCalibrationReport(
  report: CalibrationReport,
  options: FormatCalibrationOptions = {},
): string {
  const lines: string[] = []
  if (options.title) {
    lines.push(`# ${options.title}`, "")
  }

  const syntheticNote = report.config.include_synthetic_authority ? " · incl. synthetic" : ""
  lines.push(
    `Samples: ${report.sample_count} · ` +
      `classes: ${report.classes.length} · ` +
      `flagged: ${report.flagged_classes.length}`,
    "",
    `Sources: ${report.config.outcome_sources.join(", ")} · ` +
      `min samples ${report.config.min_samples} · ` +
      `thresholds ECE ${report.config.ece_threshold}, gap ${report.config.gap_threshold}${syntheticNote}`,
    "",
  )

  // Per-class table.
  lines.push(
    "| class | n | mean conf | accuracy | gap | ECE | Brier | flag |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |",
  )
  for (const c of report.classes) {
    const m = c.metrics
    lines.push(
      `| ${c.calibration_class} | ${m.n} | ${pct(m.mean_confidence)} | ${pct(m.empirical_accuracy)} | ` +
        `${sign(m.calibration_gap)} | ${m.ece.toFixed(3)} | ${m.brier_score.toFixed(3)} | ` +
        `${c.flagged ? "⚠️" : "—"} |`,
    )
  }
  const o = report.overall
  lines.push(
    `| **overall** | ${o.n} | ${pct(o.mean_confidence)} | ${pct(o.empirical_accuracy)} | ` +
      `${sign(o.calibration_gap)} | ${o.ece.toFixed(3)} | ${o.brier_score.toFixed(3)} | |`,
    "",
  )

  // Flagged detail.
  if (report.flagged_classes.length > 0) {
    lines.push("## Flagged classes", "")
    for (const c of report.classes) {
      if (c.flagged && c.flag_reason) {
        lines.push(`- **${c.calibration_class}** — ${c.flag_reason}`)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}
