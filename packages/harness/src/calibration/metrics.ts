import type { CalibrationMetrics, ReliabilityBin } from "./schema.js"

/**
 * Pure calibration math. No I/O, no event knowledge — every function
 * here takes already-resolved `(confidence, correct)` points and returns
 * numbers. This is the unit-tested core: the values are checked against
 * hand-computed expectations in `metrics.test.ts`.
 *
 * Definitions (standard calibration literature):
 *   - Brier score: mean squared error of the probabilistic prediction,
 *     mean((p - y)^2). 0 is perfect.
 *   - ECE (Expected Calibration Error): partition predictions into B
 *     equal-width confidence bins; ECE is the sample-weighted mean of
 *     |mean_confidence - accuracy| across non-empty bins.
 */

/** A minimal scored point — what every metric below consumes. */
export interface ScoredPoint {
  confidence: number
  correct: boolean
}

const y = (p: ScoredPoint): number => (p.correct ? 1 : 0)

/**
 * The bin index for a confidence value under `bins` equal-width bins over
 * [0, 1]. `confidence === 1` lands in the top bin (clamped) rather than
 * an out-of-range `bins`th bin.
 */
function binIndex(confidence: number, bins: number): number {
  const idx = Math.floor(confidence * bins)
  if (idx < 0) return 0
  if (idx >= bins) return bins - 1
  return idx
}

/** mean((p - y)^2). Returns 0 for an empty set (degenerate, no signal). */
export function brierScore(points: ScoredPoint[]): number {
  if (points.length === 0) return 0
  let sum = 0
  for (const p of points) {
    const d = p.confidence - y(p)
    sum += d * d
  }
  return sum / points.length
}

interface BinAcc {
  sumConf: number
  sumCorrect: number
  count: number
}

/** Accumulate points into `bins` equal-width bins over [0, 1]. */
function accumulateBins(points: ScoredPoint[], bins: number): BinAcc[] {
  const acc: BinAcc[] = Array.from({ length: bins }, () => ({
    sumConf: 0,
    sumCorrect: 0,
    count: 0,
  }))
  for (const p of points) {
    const bin = acc[binIndex(p.confidence, bins)]
    if (!bin) continue // unreachable: binIndex is clamped into range
    bin.sumConf += p.confidence
    bin.sumCorrect += y(p)
    bin.count += 1
  }
  return acc
}

/**
 * Expected Calibration Error over `bins` equal-width bins.
 *
 * ECE = Σ_b (n_b / n) · |conf_b − acc_b|. Because the per-bin weight
 * `n_b / n` cancels the `1 / n_b` in the bin means, this reduces to
 * (1/n) · Σ_b |Σ conf − Σ correct| over non-empty bins — computed with no
 * division by an empty bin's count.
 */
export function expectedCalibrationError(points: ScoredPoint[], bins: number): number {
  const n = points.length
  if (n === 0) return 0
  let ece = 0
  for (const bin of accumulateBins(points, bins)) {
    if (bin.count === 0) continue
    ece += Math.abs(bin.sumConf - bin.sumCorrect)
  }
  return ece / n
}

/**
 * Non-empty reliability bins, ascending by lower edge. Each carries its
 * edges, count, mean confidence, and empirical accuracy — the rows a
 * reliability diagram is plotted from. Empty bins are omitted (their
 * means are undefined); a plotting consumer fills the x-axis gaps itself.
 */
export function reliabilityBins(points: ScoredPoint[], bins: number): ReliabilityBin[] {
  const out: ReliabilityBin[] = []
  for (const [b, bin] of accumulateBins(points, bins).entries()) {
    if (bin.count === 0) continue
    out.push({
      lower: b / bins,
      upper: (b + 1) / bins,
      n: bin.count,
      mean_confidence: bin.sumConf / bin.count,
      empirical_accuracy: bin.sumCorrect / bin.count,
    })
  }
  return out
}

/**
 * Full metric block for a set of points. `overconfident` is the sign of
 * the calibration gap (stated confidence above realised accuracy). An
 * empty set returns a zeroed block — callers never build a class from
 * zero samples, but `overall` over an empty included set is well-defined.
 */
export function computeMetrics(points: ScoredPoint[], bins: number): CalibrationMetrics {
  const n = points.length
  if (n === 0) {
    return {
      n: 0,
      mean_confidence: 0,
      empirical_accuracy: 0,
      brier_score: 0,
      ece: 0,
      calibration_gap: 0,
      overconfident: false,
    }
  }
  let sumConf = 0
  let sumCorrect = 0
  for (const p of points) {
    sumConf += p.confidence
    sumCorrect += y(p)
  }
  const mean_confidence = sumConf / n
  const empirical_accuracy = sumCorrect / n
  const calibration_gap = mean_confidence - empirical_accuracy
  return {
    n,
    mean_confidence,
    empirical_accuracy,
    brier_score: brierScore(points),
    ece: expectedCalibrationError(points, bins),
    calibration_gap,
    overconfident: calibration_gap > 0,
  }
}
