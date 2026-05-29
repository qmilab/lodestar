import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type EventEnvelope,
  SENTINEL_ALERTED_EVENT_TYPE,
  SentinelAlertPayloadSchema,
} from "@qmilab/lodestar-core"
import {
  EventLogReader,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import { eventLogAlertSink } from "./sentinel-recorder.js"
import { Sentinel, type SentinelAlert, type SentinelFinding, SentinelRunner } from "./sentinel.js"
import {
  AnomalousToolSequenceSentinel,
  LowConfidenceActionSentinel,
  SuspiciousMemoryOriginSentinel,
} from "./sentinels/index.js"

// -----------------------------------------------------------------------------
// Event-envelope builder
// -----------------------------------------------------------------------------

let seq = 0
function evt(
  type: string,
  payload: unknown,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    type,
    schema_version: "0.1.0",
    project_id: "proj",
    session_id: "sess",
    actor_id: "agent",
    timestamp: "2026-05-30T00:00:00.000Z",
    logical_clock: seq,
    causal_parent_ids: [],
    payload_hash: "hash",
    payload,
    versions: { schema_registry_version: "0.1.0" },
    ...overrides,
  }
}

function action(
  id: string,
  opts: {
    type?: string
    required_level?: number
    blast_radius?: string
    tool?: string
    decision_id?: string
  } = {},
): EventEnvelope {
  return evt(opts.type ?? "action.proposed", {
    id,
    tool: opts.tool,
    decision_id: opts.decision_id,
    contract: { required_level: opts.required_level, blast_radius: opts.blast_radius },
  })
}

function belief(
  id: string,
  opts: { claim_id?: string; confidence?: number; truth_status?: string } = {},
): EventEnvelope {
  return evt("belief.adopted", {
    id,
    claim_id: opts.claim_id,
    confidence: opts.confidence,
    truth_status: opts.truth_status,
  })
}

function decision(id: string, belief_dependencies: string[]): EventEnvelope {
  return evt("decision.made", { id, belief_dependencies })
}

function evidence(claim_id: string, quality: string, relation = "supports"): EventEnvelope {
  return evt("evidence.assessed", {
    claim_id,
    items: [{ source_id: "obs", relation, quality }],
  })
}

// -----------------------------------------------------------------------------
// Base class + runner
// -----------------------------------------------------------------------------

class FixedSentinel extends Sentinel {
  readonly name = "fixed"
  readonly description = "always fires on observation.recorded"
  inspect(event: EventEnvelope): SentinelFinding[] {
    if (event.type !== "observation.recorded") return []
    return [
      {
        rule: "always",
        severity: "info",
        subject: { kind: "action", id: "x" },
        message: "hi",
        observed_event_ids: [event.id],
      },
    ]
  }
}

describe("SentinelRunner", () => {
  test("emits a schema-valid alert, routed from the triggering event, with parents = observed ids", async () => {
    const runner = new SentinelRunner([new FixedSentinel()])
    const alerts = await runner.observe(
      evt("observation.recorded", {}, { id: "trigger", project_id: "P", session_id: "S" }),
    )
    expect(alerts).toHaveLength(1)
    const alert = alerts[0] as SentinelAlert
    expect(() => SentinelAlertPayloadSchema.parse(alert.payload)).not.toThrow()
    expect(alert.payload.sentinel_name).toBe("fixed")
    expect(alert.payload.observed_event_ids).toEqual(["trigger"])
    expect(alert.project_id).toBe("P")
    expect(alert.session_id).toBe("S")
    expect(alert.causal_parent_ids).toEqual(["trigger"])
    // detail defaults to {} when a finding omits it
    expect(alert.payload.detail).toEqual({})
  })

  test("sweep awaits the sink for every alert in order", async () => {
    const sunk: SentinelAlert[] = []
    const runner = new SentinelRunner([new FixedSentinel()], {
      sink: async (a) => {
        sunk.push(a)
      },
    })
    const out = await runner.sweep([
      evt("observation.recorded", {}, { id: "a" }),
      evt("decision.made", { id: "d", belief_dependencies: [] }), // ignored by FixedSentinel
      evt("observation.recorded", {}, { id: "b" }),
    ])
    expect(out).toHaveLength(2)
    expect(sunk.map((a) => a.payload.observed_event_ids[0])).toEqual(["a", "b"])
  })
})

// -----------------------------------------------------------------------------
// Low-confidence action sentinel
// -----------------------------------------------------------------------------

describe("LowConfidenceActionSentinel", () => {
  test("fires on an L4 action backed by a low-confidence belief", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(belief("b1", { confidence: 0.3, truth_status: "supported" }))
    await runner.observe(decision("d1", ["b1"]))
    const alerts = await runner.observe(
      action("a1", { type: "action.approved", required_level: 4, decision_id: "d1" }),
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.payload.subject).toEqual({ kind: "action", id: "a1" })
    expect(alerts[0]?.payload.detail.weak_beliefs).toHaveLength(1)
  })

  test("fires on an unverified backing belief even at high confidence", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(belief("b1", { confidence: 0.99, truth_status: "unverified" }))
    await runner.observe(decision("d1", ["b1"]))
    const alerts = await runner.observe(action("a1", { required_level: 3, decision_id: "d1" }))
    expect(alerts).toHaveLength(1)
  })

  test("does not fire when backing belief is strong and supported", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(belief("b1", { confidence: 0.9, truth_status: "supported" }))
    await runner.observe(decision("d1", ["b1"]))
    const alerts = await runner.observe(action("a1", { required_level: 4, decision_id: "d1" }))
    expect(alerts).toHaveLength(0)
  })

  test("does not fire below the trust-level floor", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(belief("b1", { confidence: 0.1, truth_status: "unverified" }))
    await runner.observe(decision("d1", ["b1"]))
    const alerts = await runner.observe(action("a1", { required_level: 2, decision_id: "d1" }))
    expect(alerts).toHaveLength(0)
  })

  test("does not double-fire across proposed then approved for the same action", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(belief("b1", { confidence: 0.3 }))
    await runner.observe(decision("d1", ["b1"]))
    const first = await runner.observe(
      action("a1", { type: "action.proposed", required_level: 4, decision_id: "d1" }),
    )
    const second = await runner.observe(
      action("a1", { type: "action.approved", required_level: 4, decision_id: "d1" }),
    )
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Suspicious memory-origin sentinel
// -----------------------------------------------------------------------------

describe("SuspiciousMemoryOriginSentinel", () => {
  test("fires when a decision depends on an external_document-sourced belief", async () => {
    const s = new SuspiciousMemoryOriginSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(evidence("c1", "external_document"))
    await runner.observe(belief("b1", { claim_id: "c1" }))
    const alerts = await runner.observe(decision("d1", ["b1"]))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.payload.subject).toEqual({ kind: "belief", id: "b1" })
  })

  test("emits one alert per offending belief, not per decision", async () => {
    const s = new SuspiciousMemoryOriginSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(evidence("c1", "external_document"))
    await runner.observe(evidence("c2", "external_document"))
    await runner.observe(belief("b1", { claim_id: "c1" }))
    await runner.observe(belief("b2", { claim_id: "c2" }))
    await runner.observe(belief("b3", { claim_id: "c3" })) // clean
    const alerts = await runner.observe(decision("d1", ["b1", "b2", "b3"]))
    expect(alerts).toHaveLength(2)
    expect(alerts.map((a) => a.payload.subject.id).sort()).toEqual(["b1", "b2"])
  })

  test("does not fire for a tool_result-sourced belief", async () => {
    const s = new SuspiciousMemoryOriginSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(evidence("c1", "tool_result"))
    await runner.observe(belief("b1", { claim_id: "c1" }))
    const alerts = await runner.observe(decision("d1", ["b1"]))
    expect(alerts).toHaveLength(0)
  })

  test("ignores an external_document that only contradicts the claim", async () => {
    const s = new SuspiciousMemoryOriginSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(evidence("c1", "external_document", "contradicts"))
    await runner.observe(belief("b1", { claim_id: "c1" }))
    const alerts = await runner.observe(decision("d1", ["b1"]))
    expect(alerts).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Anomalous tool-sequence sentinel
// -----------------------------------------------------------------------------

describe("AnomalousToolSequenceSentinel", () => {
  const completed = (id: string, tool: string, blast_radius?: string) =>
    action(id, { type: "action.completed", tool, blast_radius })

  test("fires on read -> external egress -> write, at completion, once", async () => {
    const s = new AnomalousToolSequenceSentinel()
    const runner = new SentinelRunner([s])
    expect(await runner.observe(completed("a1", "fs.read"))).toHaveLength(0)
    expect(await runner.observe(completed("a2", "network.post", "external"))).toHaveLength(0)
    const fired = await runner.observe(completed("a3", "fs.write"))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.payload.severity).toBe("critical")
    expect(fired[0]?.payload.subject).toEqual({ kind: "tool_sequence", id: "a3" })
    expect(fired[0]?.payload.observed_event_ids).toHaveLength(3)
    // A further write does not re-fire the already-completed pattern.
    expect(await runner.observe(completed("a4", "fs.write"))).toHaveLength(0)
  })

  test("tolerates a benign call interleaved in the sequence", async () => {
    const s = new AnomalousToolSequenceSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(completed("a1", "fs.read"))
    await runner.observe(completed("a2", "git.status")) // benign noise
    await runner.observe(completed("a3", "http.upload", "external"))
    const fired = await runner.observe(completed("a4", "fs.commit"))
    expect(fired).toHaveLength(1)
  })

  test("does not fire on an incomplete sequence", async () => {
    const s = new AnomalousToolSequenceSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(completed("a1", "fs.read"))
    const fired = await runner.observe(completed("a2", "fs.write"))
    expect(fired).toHaveLength(0) // no egress step between
  })

  test("does not bleed sequences across sessions", async () => {
    const s = new AnomalousToolSequenceSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(
      evt("action.completed", { id: "a1", tool: "fs.read", contract: {} }, { session_id: "S1" }),
    )
    await runner.observe(
      evt(
        "action.completed",
        { id: "a2", tool: "network.post", contract: { blast_radius: "external" } },
        { session_id: "S2" },
      ),
    )
    const fired = await runner.observe(
      evt("action.completed", { id: "a3", tool: "fs.write", contract: {} }, { session_id: "S1" }),
    )
    expect(fired).toHaveLength(0) // S1 saw read then write, no egress in S1
  })

  test("ignores non-completed phases by default", async () => {
    const s = new AnomalousToolSequenceSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(action("a1", { type: "action.proposed", tool: "fs.read" }))
    await runner.observe(
      action("a2", { type: "action.proposed", tool: "network.post", blast_radius: "external" }),
    )
    const fired = await runner.observe(action("a3", { type: "action.proposed", tool: "fs.write" }))
    expect(fired).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Event-log alert sink
// -----------------------------------------------------------------------------

describe("eventLogAlertSink", () => {
  test("appends a readable sentinel.alerted event in the triggering session slice", async () => {
    _resetEventLogStateForTests()
    const root = await mkdtemp(join(tmpdir(), "lodestar-sentinel-"))
    try {
      const runner = new SentinelRunner([new SuspiciousMemoryOriginSentinel()], {
        sink: eventLogAlertSink({ root }),
      })
      await runner.observe(
        evt(
          "evidence.assessed",
          { claim_id: "c1", items: [{ quality: "external_document", relation: "supports" }] },
          { project_id: "P", session_id: "S" },
        ),
      )
      await runner.observe(
        evt("belief.adopted", { id: "b1", claim_id: "c1" }, { project_id: "P", session_id: "S" }),
      )
      await runner.observe(
        evt(
          "decision.made",
          { id: "d1", belief_dependencies: ["b1"] },
          { project_id: "P", session_id: "S", id: "trigger-event" },
        ),
      )

      const events = await new EventLogReader(root).readSession("P", "S")
      const alerts = events.filter((e) => e.type === SENTINEL_ALERTED_EVENT_TYPE)
      expect(alerts).toHaveLength(1)
      const alert = alerts[0] as EventEnvelope
      expect(alert.actor_id).toBe("lodestar-sentinel")
      expect(alert.causal_parent_ids).toEqual(["trigger-event"])
      expect(() => SentinelAlertPayloadSchema.parse(alert.payload)).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the stored alert's payload_hash survives a read round-trip (no undefined in detail)", async () => {
    _resetEventLogStateForTests()
    const root = await mkdtemp(join(tmpdir(), "lodestar-sentinel-hash-"))
    try {
      // A matched tool step with NO tool and NO blast_radius would, before the
      // fix, carry `undefined` fields in detail.steps — JSON.stringify drops
      // them while canonicalHash keeps them as null, breaking hash stability.
      const s = new AnomalousToolSequenceSentinel({
        sequences: [
          {
            id: "egress-only",
            description: "any external action",
            steps: [{ blast_radius: "external" }],
          },
        ],
      })
      const runner = new SentinelRunner([s], { sink: eventLogAlertSink({ root }) })
      // No `tool` field on the action at all.
      await runner.observe(
        evt(
          "action.completed",
          { id: "a1", contract: { blast_radius: "external" } },
          { project_id: "P", session_id: "S" },
        ),
      )

      const events = await new EventLogReader(root).readSession("P", "S")
      const alert = events.find((e) => e.type === SENTINEL_ALERTED_EVENT_TYPE) as EventEnvelope
      expect(alert).toBeDefined()
      // The dropped-undefined hazard: re-hash the payload as read back from
      // disk and confirm it equals the stored hash.
      expect(canonicalHash(alert.payload)).toBe(alert.payload_hash)
      // And the undefined fields are physically present as null.
      const steps = (alert.payload as { detail: { steps: Array<Record<string, unknown>> } }).detail
        .steps
      expect(steps[0]).toHaveProperty("tool", null)
      expect(steps[0]).toHaveProperty("blast_radius", "external")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("undefined→null normalisation descends into plain objects but leaves class instances intact (#MEDIUM)", async () => {
    // A custom sentinel whose detail mixes a plain nested object (with an
    // undefined that must become null) and a class instance (a Date — which
    // `typeof === "object"` would have wrongly recursed into, corrupting it).
    class Marker {
      readonly kind = "marker"
      missing?: string // intentionally undefined
    }
    const when = new Date("2026-05-30T00:00:00.000Z")
    const custom = new (class extends Sentinel {
      readonly name = "detail-shapes"
      readonly description = "emits a detail with a class instance and a nested undefined"
      inspect(event: EventEnvelope): SentinelFinding[] {
        if (event.type !== "observation.recorded") return []
        return [
          {
            rule: "shapes",
            severity: "info",
            subject: { kind: "action", id: "x" },
            message: "shapes",
            observed_event_ids: [event.id],
            detail: { when, marker: new Marker(), nested: { a: undefined, b: 1 } },
          },
        ]
      }
    })()

    const runner = new SentinelRunner([custom])
    const [alert] = await runner.observe(evt("observation.recorded", {}, { id: "t" }))
    const detail = (alert as SentinelAlert).payload.detail as {
      when: unknown
      marker: Marker
      nested: { a: unknown; b: number }
    }
    // Class instances are passed through untouched (same reference): Date stays
    // a Date; the Marker keeps its prototype, and its undefined field is left
    // undefined — NOT recursed into and turned to null (which is the corruption
    // the plain-object guard prevents).
    expect(detail.when).toBe(when)
    expect(detail.marker).toBeInstanceOf(Marker)
    expect(detail.marker.kind).toBe("marker")
    expect(detail.marker.missing).toBeUndefined()
    // Plain nested objects are still normalised: undefined -> null.
    expect(detail.nested).toEqual({ a: null, b: 1 })
  })
})

// -----------------------------------------------------------------------------
// Review fixes — session-end eviction (#1) and stateful-regex hardening (#2)
// -----------------------------------------------------------------------------

describe("session-end eviction (#1)", () => {
  const ended = (session: string) => evt("guard.session.ended", {}, { session_id: session })

  test("low-confidence sentinel forgets a session's beliefs/decisions on session end", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(belief("b1", { confidence: 0.2, truth_status: "unverified" }))
    await runner.observe(decision("d1", ["b1"]))
    await runner.observe(ended("sess"))
    // After eviction the decision/belief are gone, so the action has no known
    // weak backing and does not alert.
    const fired = await runner.observe(action("a1", { required_level: 4, decision_id: "d1" }))
    expect(fired).toHaveLength(0)
  })

  test("anomalous-tool-sequence forgets a session's window on session end", async () => {
    const s = new AnomalousToolSequenceSentinel()
    const runner = new SentinelRunner([s])
    const completed = (id: string, tool: string, blast_radius?: string) =>
      action(id, { type: "action.completed", tool, blast_radius })
    await runner.observe(completed("a1", "fs.read"))
    await runner.observe(completed("a2", "network.post", "external"))
    await runner.observe(ended("sess"))
    // The read+egress prefix was evicted; the write alone cannot complete it.
    expect(await runner.observe(completed("a3", "fs.write"))).toHaveLength(0)
  })

  test("eviction is scoped to the ended session, not others", async () => {
    const s = new LowConfidenceActionSentinel()
    const runner = new SentinelRunner([s])
    await runner.observe(
      evt("belief.adopted", { id: "b1", confidence: 0.2 }, { session_id: "keep" }),
    )
    await runner.observe(
      evt("decision.made", { id: "d1", belief_dependencies: ["b1"] }, { session_id: "keep" }),
    )
    await runner.observe(ended("other")) // a different session ends
    const fired = await runner.observe(
      evt(
        "action.approved",
        { id: "a1", decision_id: "d1", contract: { required_level: 4 } },
        { session_id: "keep" },
      ),
    )
    expect(fired).toHaveLength(1) // "keep" state untouched
  })
})

describe("stateful-regex hardening (#2)", () => {
  test("a global-flag regex matcher matches consistently across repeated sequences", async () => {
    // With a /g regex, a naive `re.test()` carries lastIndex between calls and
    // would match sporadically. The sentinel resets lastIndex per test.
    const s = new AnomalousToolSequenceSentinel({
      sequences: [
        {
          id: "g-flag",
          description: "global-flag matchers",
          steps: [{ tool: /read/g }, { blast_radius: "external" }, { tool: /write/g }],
        },
      ],
    })
    const runner = new SentinelRunner([s])
    const completed = (id: string, tool: string, blast_radius?: string) =>
      action(id, { type: "action.completed", tool, blast_radius })

    // First completion fires.
    await runner.observe(completed("a1", "fs.read"))
    await runner.observe(completed("a2", "net.post", "external"))
    expect(await runner.observe(completed("a3", "fs.write"))).toHaveLength(1)
    // A second, fresh completion must fire too — proving the regex did not
    // carry stale lastIndex state from the first round.
    await runner.observe(completed("a4", "fs.read"))
    await runner.observe(completed("a5", "net.post", "external"))
    expect(await runner.observe(completed("a6", "fs.write"))).toHaveLength(1)
  })
})
