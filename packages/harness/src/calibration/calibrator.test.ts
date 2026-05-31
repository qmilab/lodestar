import { describe, expect, test } from "bun:test"
import type { EventEnvelope } from "@qmilab/lodestar-core"
import { Calibrator, calibrate } from "./calibrator.js"
import { formatCalibrationReport } from "./format.js"

// -----------------------------------------------------------------------------
// Minimal event-envelope + chain builders. Payloads are partial on purpose:
// the calibrator reads through tolerant `.passthrough()` views, the same way
// the sentinels do, so only the fields a rule needs are required.
// -----------------------------------------------------------------------------

let seq = 0
function evt(type: string, payload: unknown): EventEnvelope {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    type,
    schema_version: "0.1.0",
    project_id: "proj",
    session_id: "sess",
    actor_id: "agent",
    timestamp: "2026-05-31T00:00:00.000Z",
    logical_clock: seq,
    causal_parent_ids: [],
    payload_hash: "hash",
    payload,
    versions: { schema_registry_version: "0.1.0" },
  }
}

let uid = 0
function nextId(prefix: string): string {
  uid += 1
  return `${prefix}-${uid}`
}

/**
 * Build a belief → decision → action chain whose action realises to
 * `success`. Returns the three events. The belief is the calibration unit.
 */
function actionChain(
  calibration_class: string,
  confidence: number,
  success: boolean,
  authority = "inferred",
): EventEnvelope[] {
  const beliefId = nextId("b")
  const decisionId = nextId("d")
  const actionId = nextId("a")
  return [
    evt("belief.adopted", { id: beliefId, confidence, calibration_class, authority }),
    evt("decision.made", { id: decisionId, belief_dependencies: [beliefId] }),
    evt(success ? "action.completed" : "action.failed", {
      id: actionId,
      decision_id: decisionId,
      phase: success ? "completed" : "failed",
    }),
  ]
}

/** N chains for one class with a fixed confidence and success count. */
function classChains(
  calibration_class: string,
  confidence: number,
  total: number,
  successes: number,
  authority = "inferred",
): EventEnvelope[] {
  const out: EventEnvelope[] = []
  for (let i = 0; i < total; i++) {
    out.push(...actionChain(calibration_class, confidence, i < successes, authority))
  }
  return out
}

/** A belief whose truth_status the firewall later adjudicates. */
function truthChain(
  calibration_class: string,
  confidence: number,
  supported: boolean,
  authority = "inferred",
): EventEnvelope[] {
  const beliefId = nextId("b")
  return [
    evt("belief.adopted", { id: beliefId, confidence, calibration_class, authority }),
    evt("firewall.belief.transitioned", {
      kind: "belief.transitioned",
      belief_id: beliefId,
      axis: "truth_status",
      from_value: "unverified",
      to_value: supported ? "supported" : "contradicted",
    }),
  ]
}

describe("action_outcome resolution + flagging", () => {
  test("overconfident class is flagged; well-calibrated control is not", () => {
    const events = [
      // 8 beliefs @ 0.9, every action fails → gap ~0.9
      ...classChains("payments-api-shape", 0.9, 8, 0),
      // 10 beliefs @ 0.6, 6 succeed → acc 0.6 == conf
      ...classChains("git-state", 0.6, 10, 6),
    ]
    const report = calibrate(events)

    expect(report.sample_count).toBe(18)
    expect(report.flagged_classes).toContain("payments-api-shape")
    expect(report.flagged_classes).not.toContain("git-state")

    const bad = report.classes.find((c) => c.calibration_class === "payments-api-shape")
    expect(bad?.flagged).toBe(true)
    expect(bad?.metrics.overconfident).toBe(true)
    expect(bad?.metrics.calibration_gap).toBeCloseTo(0.9, 10)
    expect(bad?.flag_reason).toContain("overconfident")

    const good = report.classes.find((c) => c.calibration_class === "git-state")
    expect(good?.flagged).toBe(false)
    expect(good?.metrics.calibration_gap).toBeCloseTo(0, 10)
    expect(good?.flag_reason).toBeNull()
  })

  test("a class below min_samples is never flagged, even with a huge gap", () => {
    // 3 chains @ 0.95 all failing: gap 0.95 but n=3 < default min_samples 5
    const report = calibrate(classChains("thin-class", 0.95, 3, 0))
    const thin = report.classes.find((c) => c.calibration_class === "thin-class")
    expect(thin?.metrics.n).toBe(3)
    expect(thin?.metrics.calibration_gap).toBeCloseTo(0.95, 10)
    expect(thin?.flagged).toBe(false)
    expect(report.flagged_classes).toEqual([])

    // Lowering the guard makes the same data flag.
    const lowered = calibrate(classChains("thin-class", 0.95, 3, 0), { minSamples: 3 })
    expect(lowered.flagged_classes).toContain("thin-class")
  })

  test("classes are sorted and overall pools every sample", () => {
    const report = calibrate([
      ...classChains("zeta", 0.9, 6, 0),
      ...classChains("alpha", 0.6, 6, 4),
    ])
    expect(report.classes.map((c) => c.calibration_class)).toEqual(["alpha", "zeta"])
    expect(report.overall.n).toBe(12)
  })
})

describe("synthetic-authority exclusion", () => {
  test("synthetic beliefs contribute zero samples by default", () => {
    const events = classChains("S", 0.9, 6, 0, "synthetic")
    const report = calibrate(events)
    expect(report.sample_count).toBe(0)
    expect(report.classes).toEqual([])
  })

  test("opting in surfaces them (proves exclusion is the gate, not the fixture)", () => {
    const events = classChains("S", 0.9, 6, 0, "synthetic")
    const report = calibrate(events, { includeSyntheticAuthority: true })
    expect(report.sample_count).toBe(6)
    expect(report.flagged_classes).toContain("S")
  })
})

describe("truth_status resolution", () => {
  test("contradicted = incorrect, supported = correct", () => {
    const events = [
      ...Array.from({ length: 6 }, () => truthChain("model-claims", 0.9, false)).flat(),
      ...Array.from({ length: 2 }, () => truthChain("model-claims", 0.9, true)).flat(),
    ]
    const report = calibrate(events, { outcomeSources: ["truth_status"] })
    const cls = report.classes.find((c) => c.calibration_class === "model-claims")
    expect(cls?.metrics.n).toBe(8)
    // 2 of 8 supported → accuracy 0.25, conf 0.9 → gap 0.65, overconfident
    expect(cls?.metrics.empirical_accuracy).toBeCloseTo(0.25, 10)
    expect(cls?.metrics.overconfident).toBe(true)
    expect(cls?.flagged).toBe(true)
  })

  test("superseded / unverified transitions are not labels", () => {
    const beliefId = "b-super"
    const events = [
      evt("belief.adopted", {
        id: beliefId,
        confidence: 0.9,
        calibration_class: "c",
        authority: "inferred",
      }),
      evt("firewall.belief.transitioned", {
        kind: "belief.transitioned",
        belief_id: beliefId,
        axis: "truth_status",
        from_value: "supported",
        to_value: "superseded",
      }),
      // a non-truth axis transition is also ignored
      evt("firewall.belief.transitioned", {
        kind: "belief.transitioned",
        belief_id: beliefId,
        axis: "retrieval_status",
        from_value: "restricted",
        to_value: "normal",
      }),
    ]
    expect(calibrate(events, { outcomeSources: ["truth_status"] }).sample_count).toBe(0)
  })
})

describe("source gating and explicit Outcome events", () => {
  test("outcomeSources restricts which signal is resolved", () => {
    const events = [
      ...classChains("act", 0.9, 6, 0), // action outcomes
      ...Array.from({ length: 6 }, () => truthChain("truth", 0.9, false)).flat(), // truth
    ]
    const onlyTruth = calibrate(events, { outcomeSources: ["truth_status"] })
    expect(onlyTruth.classes.map((c) => c.calibration_class)).toEqual(["truth"])

    const onlyAction = calibrate(events, { outcomeSources: ["action_outcome"] })
    expect(onlyAction.classes.map((c) => c.calibration_class)).toEqual(["act"])
  })

  test("an explicit Outcome event overrides the action's terminal phase", () => {
    const beliefId = "b-x"
    const decisionId = "d-x"
    const actionId = "a-x"
    const events = [
      evt("belief.adopted", {
        id: beliefId,
        confidence: 0.9,
        calibration_class: "c",
        authority: "inferred",
      }),
      evt("decision.made", { id: decisionId, belief_dependencies: [beliefId] }),
      // phase says completed...
      evt("action.completed", { id: actionId, decision_id: decisionId, phase: "completed" }),
      // ...but the host's considered Outcome says failure — that wins.
      evt("outcome.observed", { action_id: actionId, result: "failure" }),
    ]
    const samples = new Calibrator().samples(events)
    expect(samples).toHaveLength(1)
    expect(samples[0]?.correct).toBe(false)
    expect(samples[0]?.source).toBe("action_outcome")
  })

  test("partial / unknown outcomes and rejected actions are not labels", () => {
    const events = [
      evt("belief.adopted", {
        id: "b1",
        confidence: 0.9,
        calibration_class: "c",
        authority: "inferred",
      }),
      evt("decision.made", { id: "d1", belief_dependencies: ["b1"] }),
      evt("action.rejected", { id: "a1", decision_id: "d1", phase: "rejected" }),
      evt("belief.adopted", {
        id: "b2",
        confidence: 0.9,
        calibration_class: "c",
        authority: "inferred",
      }),
      evt("decision.made", { id: "d2", belief_dependencies: ["b2"] }),
      evt("action.approved", { id: "a2", decision_id: "d2", phase: "approved" }),
      evt("outcome.observed", { action_id: "a2", result: "partial" }),
    ]
    expect(calibrate(events).sample_count).toBe(0)
  })

  test("an explicit partial/unknown outcome suppresses the action's terminal phase", () => {
    // The teeth: each action reaches a *terminal* phase (completed), so the
    // phase alone would manufacture a success sample. An explicit non-binary
    // outcome must override that and yield nothing — otherwise calibration is
    // biased by results the host itself declared inconclusive.
    const chain = (beliefId: string, decisionId: string, actionId: string): EventEnvelope[] => [
      evt("belief.adopted", {
        id: beliefId,
        confidence: 0.9,
        calibration_class: "c",
        authority: "inferred",
      }),
      evt("decision.made", { id: decisionId, belief_dependencies: [beliefId] }),
      evt("action.completed", { id: actionId, decision_id: decisionId, phase: "completed" }),
    ]
    const events = [
      // completed phase + explicit partial → suppressed
      ...chain("bp", "dp", "ap"),
      evt("outcome.observed", { action_id: "ap", result: "partial" }),
      // completed phase + explicit unknown (via the legacy event name) → suppressed
      ...chain("bu", "du", "au"),
      evt("action.outcome", { action_id: "au", result: "unknown" }),
      // completed phase + explicit success → still a sample (resolver works)
      ...chain("bs", "ds", "as"),
      evt("outcome.observed", { action_id: "as", result: "success" }),
    ]
    const report = calibrate(events)
    expect(report.sample_count).toBe(1)
    expect(report.classes[0]?.metrics.empirical_accuracy).toBe(1)
  })
})

describe("report shape + formatter", () => {
  test("config is echoed and the report validates", () => {
    const report = calibrate(classChains("x", 0.9, 6, 0), { bins: 5, gapThreshold: 0.2 })
    expect(report.config.bins).toBe(5)
    expect(report.config.gap_threshold).toBe(0.2)
    expect(report.config.outcome_sources).toEqual(["action_outcome", "truth_status"])
  })

  test("formatter renders class rows, the overall line, and flags", () => {
    const report = calibrate([
      ...classChains("payments-api-shape", 0.9, 6, 0),
      ...classChains("git-state", 0.6, 10, 6),
    ])
    const md = formatCalibrationReport(report, { title: "Session calibration" })
    expect(md).toContain("# Session calibration")
    expect(md).toContain("payments-api-shape")
    expect(md).toContain("git-state")
    expect(md).toContain("**overall**")
    expect(md).toContain("⚠️")
    expect(md).toContain("## Flagged classes")
  })
})
