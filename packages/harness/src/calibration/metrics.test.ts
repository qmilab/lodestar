import { describe, expect, test } from "bun:test"
import {
  type ScoredPoint,
  brierScore,
  computeMetrics,
  expectedCalibrationError,
  reliabilityBins,
} from "./metrics.js"

const p = (confidence: number, correct: boolean): ScoredPoint => ({ confidence, correct })

// Tolerant float compare for hand-computed expectations.
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 10)

describe("brierScore", () => {
  test("perfect predictions score 0", () => {
    near(brierScore([p(1, true), p(1, true), p(0, false)]), 0)
  })

  test("maximally wrong scores 1", () => {
    near(brierScore([p(1, false), p(0, true)]), 1)
  })

  test("mixed: mean of squared errors", () => {
    // (0.9-1)^2 + (0.9-0)^2 = 0.01 + 0.81 = 0.82; /2 = 0.41
    near(brierScore([p(0.9, true), p(0.9, false)]), 0.41)
  })

  test("empty set is 0 (degenerate, no signal)", () => {
    near(brierScore([]), 0)
  })
})

describe("expectedCalibrationError (10 bins)", () => {
  test("perfectly calibrated single bin → 0", () => {
    // 4 points at conf 0.5, exactly half correct → acc 0.5 == conf
    near(
      expectedCalibrationError([p(0.5, true), p(0.5, true), p(0.5, false), p(0.5, false)], 10),
      0,
    )
  })

  test("single bin, half right at 0.9 confidence → 0.4", () => {
    // |0.9*4 - 2| / 4 = 1.6/4 = 0.4
    near(
      expectedCalibrationError([p(0.9, true), p(0.9, true), p(0.9, false), p(0.9, false)], 10),
      0.4,
    )
  })

  test("two bins, symmetric small error → 0.1", () => {
    // bin0: 2 @ 0.1 incorrect → |0.2-0|=0.2 ; bin9: 2 @ 0.9 correct → |1.8-2|=0.2
    // (0.2 + 0.2) / 4 = 0.1
    near(
      expectedCalibrationError([p(0.1, false), p(0.1, false), p(0.9, true), p(0.9, true)], 10),
      0.1,
    )
  })

  test("confidence 1.0 lands in the top bin, not out of range", () => {
    // 2 @ 1.0, one correct → acc 0.5 → |1.0*2 - 1|/2 = 0.5
    near(expectedCalibrationError([p(1, true), p(1, false)], 10), 0.5)
  })

  test("empty set is 0", () => {
    near(expectedCalibrationError([], 10), 0)
  })
})

describe("reliabilityBins (10 bins)", () => {
  test("returns only non-empty bins, ascending, with correct edges and means", () => {
    // 0.05 → bin 0 (0.0–0.1); 0.95 → bin 9 (0.9–1.0). Values kept clear of
    // bin boundaries so float rounding can't reassign them.
    const bins = reliabilityBins(
      [p(0.05, false), p(0.05, false), p(0.95, true), p(0.95, false)],
      10,
    )
    expect(bins.length).toBe(2)
    const [low, high] = bins
    expect(low?.lower).toBeCloseTo(0.0, 10)
    expect(low?.upper).toBeCloseTo(0.1, 10)
    expect(low?.n).toBe(2)
    near(low?.mean_confidence ?? -1, 0.05)
    near(low?.empirical_accuracy ?? -1, 0)
    expect(high?.lower).toBeCloseTo(0.9, 10)
    expect(high?.n).toBe(2)
    near(high?.mean_confidence ?? -1, 0.95)
    near(high?.empirical_accuracy ?? -1, 0.5)
  })

  test("empty set yields no bins", () => {
    expect(reliabilityBins([], 10)).toEqual([])
  })
})

describe("computeMetrics", () => {
  test("overconfident class: high confidence, no successes", () => {
    const points = Array.from({ length: 6 }, () => p(0.9, false))
    const m = computeMetrics(points, 10)
    expect(m.n).toBe(6)
    near(m.mean_confidence, 0.9)
    near(m.empirical_accuracy, 0)
    near(m.calibration_gap, 0.9)
    expect(m.overconfident).toBe(true)
    near(m.brier_score, 0.81) // (0.9)^2
    near(m.ece, 0.9)
  })

  test("well-calibrated class: gap ~0, not overconfident", () => {
    // 10 @ 0.6, 6 correct → acc 0.6 == conf
    const points = [
      ...Array.from({ length: 6 }, () => p(0.6, true)),
      ...Array.from({ length: 4 }, () => p(0.6, false)),
    ]
    const m = computeMetrics(points, 10)
    near(m.mean_confidence, 0.6)
    near(m.empirical_accuracy, 0.6)
    near(m.calibration_gap, 0)
    expect(m.overconfident).toBe(false)
    near(m.ece, 0)
    // brier = (0.16*6 + 0.36*4)/10 = (0.96 + 1.44)/10 = 0.24
    near(m.brier_score, 0.24)
  })

  test("underconfident class: negative gap, not overconfident", () => {
    // 4 @ 0.2, all correct → acc 1.0, conf 0.2, gap -0.8
    const m = computeMetrics(
      Array.from({ length: 4 }, () => p(0.2, true)),
      10,
    )
    near(m.calibration_gap, -0.8)
    expect(m.overconfident).toBe(false)
  })

  test("empty set is a zeroed block", () => {
    const m = computeMetrics([], 10)
    expect(m).toEqual({
      n: 0,
      mean_confidence: 0,
      empirical_accuracy: 0,
      brier_score: 0,
      ece: 0,
      calibration_gap: 0,
      overconfident: false,
    })
  })
})
