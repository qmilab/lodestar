import { describe, expect, test } from "bun:test"
import type { Action, EventEnvelope } from "@qmilab/lodestar-core"
import { Sentinel, type SentinelFinding } from "@qmilab/lodestar-harness"
import { SentinelArbiter } from "./sentinel-arbiter.js"

/**
 * A deterministic stub sentinel: alerts (belief-subject `belief-X`) on a
 * `trigger` event and nothing else. Keeps the unit test of the arbiter's
 * projection/buffer/reset logic independent of the real sentinels' event
 * choreography (which the `guard-arbiter-gates-dependent-action` probe covers
 * end-to-end).
 */
class StubSentinel extends Sentinel {
  readonly name = "stub"
  readonly description = "test stub"
  inspect(event: EventEnvelope): SentinelFinding[] {
    if (event.type !== "trigger") return []
    return [
      {
        rule: "stub-rule",
        severity: "warning",
        subject: { kind: "belief", id: "belief-X" },
        message: "stub flagged belief-X",
        observed_event_ids: [event.id],
      },
    ]
  }
}

let seq = 0
function evt(type: string, payload: unknown, session = "s1"): EventEnvelope {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    type,
    schema_version: "0.1.0",
    project_id: "p",
    session_id: session,
    actor_id: "a",
    timestamp: "2026-06-05T00:00:00.000Z",
    logical_clock: seq,
    causal_parent_ids: [],
    payload_hash: "h",
    payload,
    versions: { schema_registry_version: "0.1.0" },
  }
}

/** Minimal Action — `resolveContext` only reads `decision_id`. */
function action(decision_id?: string): Action {
  return { id: "act-1", decision_id } as unknown as Action
}

describe("SentinelArbiter", () => {
  test("resolves backing beliefs via decision_id → belief_dependencies", async () => {
    const arbiter = new SentinelArbiter({ sentinels: [] })
    await arbiter.observe(
      evt("belief.adopted", {
        id: "belief-X",
        claim_id: "c-X",
        calibration_class: "auth",
        confidence: 0.9,
        truth_status: "supported",
      }),
    )
    await arbiter.observe(evt("decision.made", { id: "d1", belief_dependencies: ["belief-X"] }))

    const ctx = arbiter.resolveContext(action("d1"))
    expect(ctx.beliefs).toEqual([
      { id: "belief-X", calibration_class: "auth", confidence: 0.9, truth_status: "supported" },
    ])
  })

  test("an action with no decision link has no backing beliefs", async () => {
    const arbiter = new SentinelArbiter({ sentinels: [] })
    await arbiter.observe(
      evt("belief.adopted", { id: "belief-X", confidence: 0.2, truth_status: "unverified" }),
    )
    expect(arbiter.resolveContext(action(undefined)).beliefs).toEqual([])
    // A decision naming a belief the arbiter never saw resolves to nothing,
    // not a placeholder.
    await arbiter.observe(
      evt("decision.made", { id: "d1", belief_dependencies: ["belief-UNSEEN"] }),
    )
    expect(arbiter.resolveContext(action("d1")).beliefs).toEqual([])
  })

  test("belief projection fails closed: a partial belief reads as unverified", async () => {
    const arbiter = new SentinelArbiter({ sentinels: [] })
    await arbiter.observe(evt("belief.adopted", { id: "belief-bare" }))
    await arbiter.observe(evt("decision.made", { id: "d1", belief_dependencies: ["belief-bare"] }))
    expect(arbiter.resolveContext(action("d1")).beliefs).toEqual([
      // A malformed/partial belief.adopted (no truth_status) reads as unverified,
      // so it HOLDS a dependent action rather than slipping past the low-confidence
      // signal — the conservative direction (PR #54 review, F3).
      {
        id: "belief-bare",
        calibration_class: "general",
        confidence: 1,
        truth_status: "unverified",
      },
    ])
  })

  test("observe ignores sentinel.alerted events (re-entrancy guard)", async () => {
    // A pathological sentinel that alerts on the arbiter's OWN output would
    // recurse if fed back. The arbiter skips sentinel.alerted entirely, so the
    // depth-one guarantee holds for any sentinel set (PR #54 review, F5).
    class MetaSentinel extends Sentinel {
      readonly name = "meta"
      readonly description = "alerts on alerts"
      inspect(event: EventEnvelope): SentinelFinding[] {
        if (event.type !== "sentinel.alerted") return []
        return [
          {
            rule: "meta-rule",
            severity: "warning",
            subject: { kind: "belief", id: "belief-Y" },
            message: "meta flagged",
            observed_event_ids: [event.id],
          },
        ]
      }
    }
    const arbiter = new SentinelArbiter({ sentinels: [new MetaSentinel()] })
    expect(await arbiter.observe(evt("sentinel.alerted", {}))).toEqual([])
    expect(arbiter.resolveContext(action(undefined)).alerts).toEqual([])
  })

  test("observe returns landed alerts and resolveContext surfaces them", async () => {
    const arbiter = new SentinelArbiter({ sentinels: [new StubSentinel()] })
    expect(await arbiter.observe(evt("noise", {}))).toEqual([])

    const alerts = await arbiter.observe(evt("trigger", {}))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.payload.sentinel_name).toBe("stub")
    expect(alerts[0]?.payload.subject).toEqual({ kind: "belief", id: "belief-X" })

    const ctx = arbiter.resolveContext(action(undefined))
    expect(ctx.alerts).toHaveLength(1)
    expect(ctx.alerts?.[0]?.subject).toEqual({ kind: "belief", id: "belief-X" })
  })

  test("calibration snapshot passes through (constructor + setter)", async () => {
    const arbiter = new SentinelArbiter({
      sentinels: [],
      calibration: { flagged_classes: ["auth"] },
    })
    expect(arbiter.resolveContext(action(undefined)).calibration).toEqual({
      flagged_classes: ["auth"],
    })

    arbiter.setCalibration(null)
    expect(arbiter.resolveContext(action(undefined)).calibration).toBeNull()
  })

  test("session-end frees per-session state", async () => {
    const arbiter = new SentinelArbiter({ sentinels: [new StubSentinel()] })
    await arbiter.observe(
      evt("belief.adopted", { id: "belief-X", confidence: 0.9, truth_status: "supported" }),
    )
    await arbiter.observe(evt("decision.made", { id: "d1", belief_dependencies: ["belief-X"] }))
    await arbiter.observe(evt("trigger", {}))
    expect(arbiter.resolveContext(action("d1")).alerts).toHaveLength(1)

    await arbiter.observe(evt("guard.session.ended", {}))
    const ctx = arbiter.resolveContext(action("d1"))
    expect(ctx.alerts).toEqual([])
    expect(ctx.beliefs).toEqual([])
  })
})
