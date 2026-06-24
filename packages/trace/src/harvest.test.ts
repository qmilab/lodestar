import { describe, expect, test } from "bun:test"
import type {
  Belief,
  Claim,
  EventEnvelope,
  EvidenceSet,
  FreshnessStatus,
  RetrievalStatus,
  SecurityStatus,
  Sensitivity,
  TruthStatus,
} from "@qmilab/lodestar-core"
import { FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE } from "@qmilab/lodestar-core"
import { harvestCandidates } from "./harvest.js"

/**
 * `harvestCandidates` projects the durable-memory harvest queue (ADR-0031): the
 * supported beliefs and superseded-with-history chains worth offering a human as
 * keeper lessons. The load-bearing cases are the candidacy gate (a poisoned /
 * hard-demoted belief must not launder past the firewall into the Keep queue),
 * the lifecycle reconstruction (current state, not the adoption snapshot), and
 * the supersession history (replacement with the audit trail preserved).
 */

const PROJECT = "trace-harvest-test-project"
const SESSION = "trace-harvest-test-session"

let seq = 0
function makeEvent(type: string, payload: unknown): EventEnvelope {
  seq += 1
  return {
    id: `evt-${seq}`,
    seq,
    type,
    schema_version: "1",
    project_id: PROJECT,
    session_id: SESSION,
    actor_id: "test-actor",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    logical_clock: seq,
    causal_parent_ids: [],
    payload_hash: "deadbeef",
    payload,
    versions: {},
  }
}

interface BeliefOverrides {
  truth_status?: TruthStatus
  retrieval_status?: RetrievalStatus
  security_status?: SecurityStatus
  freshness_status?: FreshnessStatus
  sensitivity?: Sensitivity
  confidence?: number
  observed_at?: string
  superseded_by?: string
}

function belief(id: string, claimId: string, o: BeliefOverrides = {}): Belief {
  return {
    id,
    claim_id: claimId,
    confidence: o.confidence ?? 0.95,
    calibration_class: "test-class",
    scope: { level: "project", identifier: PROJECT },
    sensitivity: o.sensitivity ?? "internal",
    authority: "observed",
    truth_status: o.truth_status ?? "supported",
    retrieval_status: o.retrieval_status ?? "normal",
    security_status: o.security_status ?? "clean",
    freshness_status: o.freshness_status ?? "fresh",
    observed_at: o.observed_at ?? "2026-01-01T00:00:00.000Z",
    ...(o.superseded_by ? { superseded_by: o.superseded_by } : {}),
  }
}

function claim(id: string, statement: string): Claim {
  return {
    id,
    statement,
    structured_predicate: { subject: "repo", relation: "policy", object: statement },
    source_observation_ids: ["obs-1"],
    extraction_method: "tool",
    extracted_by: "test-actor",
    status: "accepted",
    scope: { level: "project", identifier: PROJECT },
    sensitivity: "internal",
    authors: ["test-actor"],
    created_at: "2026-01-01T00:00:00.000Z",
  }
}

function evidenceSet(id: string, claimId: string): EvidenceSet {
  return {
    id,
    claim_id: claimId,
    items: [
      {
        source_id: "obs-1",
        relation: "supports",
        quality: "direct_observation",
        freshness: "fresh",
      },
    ],
    assessed_by: "test-actor",
    assessed_at: "2026-01-01T00:00:00.000Z",
  }
}

function adopt(b: Belief): EventEnvelope {
  return makeEvent("belief.adopted", b)
}
function extract(c: Claim): EventEnvelope {
  return makeEvent("claim.extracted", c)
}
function assess(e: EvidenceSet): EventEnvelope {
  return makeEvent("evidence.assessed", e)
}
function transition(
  beliefId: string,
  axis: string,
  toValue: string,
  supersededBy?: string,
): EventEnvelope {
  return makeEvent(FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE, {
    kind: "belief.transitioned",
    belief_id: beliefId,
    axis,
    from_value: "unverified",
    to_value: toValue,
    by_authority: "user",
    rationale_id: "exp-1",
    at: "2026-01-01T00:05:00.000Z",
    by_actor_id: "test-actor",
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
  })
}

describe("harvestCandidates", () => {
  test("empty log yields no candidates", () => {
    expect(harvestCandidates([])).toEqual([])
  })

  test("a supported belief surfaces with its claim + evidence as a candidate", () => {
    const events = [
      extract(claim("c1", "tests must pass before commit")),
      assess(evidenceSet("ev1", "c1")),
      adopt(belief("b1", "c1")),
    ]
    const out = harvestCandidates(events)
    expect(out).toHaveLength(1)
    expect(out[0]?.belief.id).toBe("b1")
    expect(out[0]?.status).toBe("candidate")
    expect(out[0]?.claim?.statement).toBe("tests must pass before commit")
    expect(out[0]?.evidence?.id).toBe("ev1")
    expect(out[0]?.supersedes).toEqual([])
    expect(out[0]?.project_id).toBe(PROJECT)
    expect(out[0]?.session_id).toBe(SESSION)
  })

  test("an unverified belief is not a candidate", () => {
    const out = harvestCandidates([adopt(belief("b1", "c1", { truth_status: "unverified" }))])
    expect(out).toEqual([])
  })

  test("a belief adopted unverified then transitioned to supported IS a candidate", () => {
    const events = [
      adopt(belief("b1", "c1", { truth_status: "unverified" })),
      transition("b1", "truth_status", "supported"),
    ]
    const out = harvestCandidates(events)
    expect(out).toHaveLength(1)
    expect(out[0]?.belief.truth_status).toBe("supported")
  })

  test("a supported belief later quarantined is excluded (security gate)", () => {
    const events = [adopt(belief("b1", "c1")), transition("b1", "security_status", "quarantined")]
    expect(harvestCandidates(events)).toEqual([])
  })

  test("a supported belief later blocked/hidden is excluded (retrieval gate)", () => {
    for (const demoted of ["blocked", "hidden", "privileged_only"]) {
      const events = [adopt(belief("b1", "c1")), transition("b1", "retrieval_status", demoted)]
      expect(harvestCandidates(events)).toEqual([])
    }
  })

  test("a supported belief adopted directly quarantined/malicious is excluded", () => {
    expect(
      harvestCandidates([adopt(belief("b1", "c1", { security_status: "quarantined" }))]),
    ).toEqual([])
    expect(
      harvestCandidates([adopt(belief("b2", "c1", { security_status: "malicious" }))]),
    ).toEqual([])
  })

  test("restricted retrieval is still a candidate (adopted/default state)", () => {
    const out = harvestCandidates([adopt(belief("b1", "c1", { retrieval_status: "restricted" }))])
    expect(out).toHaveLength(1)
  })

  test("freshness and sensitivity are surfaced, not gated (reviewer's call)", () => {
    const out = harvestCandidates([
      adopt(belief("b1", "c1", { freshness_status: "expired", sensitivity: "secret" })),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.belief.freshness_status).toBe("expired")
    expect(out[0]?.belief.sensitivity).toBe("secret")
  })

  test("supersession surfaces the successor with the replaced lesson as history", () => {
    const events = [
      adopt(belief("b1", "c1", { observed_at: "2026-01-01T00:00:00.000Z" })),
      adopt(belief("b2", "c2", { observed_at: "2026-01-01T00:10:00.000Z" })),
      extract(claim("c1", "old lesson")),
      extract(claim("c2", "new lesson")),
      // b1 is superseded by b2
      transition("b1", "truth_status", "superseded", "b2"),
    ]
    const out = harvestCandidates(events)
    // Only b2 (the current lesson) is a top-level candidate; b1 is its history.
    expect(out.map((c) => c.belief.id)).toEqual(["b2"])
    expect(out[0]?.supersedes).toHaveLength(1)
    expect(out[0]?.supersedes[0]?.belief.id).toBe("b1")
    expect(out[0]?.supersedes[0]?.belief.truth_status).toBe("superseded")
    expect(out[0]?.supersedes[0]?.claim?.statement).toBe("old lesson")
  })

  test("a multi-level supersession chain lists history newest-first", () => {
    const events = [
      adopt(belief("b0", "c0", { observed_at: "2026-01-01T00:00:00.000Z" })),
      adopt(belief("b1", "c1", { observed_at: "2026-01-01T00:05:00.000Z" })),
      adopt(belief("b2", "c2", { observed_at: "2026-01-01T00:10:00.000Z" })),
      transition("b0", "truth_status", "superseded", "b1"),
      transition("b1", "truth_status", "superseded", "b2"),
    ]
    const out = harvestCandidates(events)
    expect(out.map((c) => c.belief.id)).toEqual(["b2"])
    expect(out[0]?.supersedes.map((s) => s.belief.id)).toEqual(["b1", "b0"])
  })

  test("candidates are ordered oldest-first by observed_at", () => {
    const events = [
      adopt(belief("late", "c1", { observed_at: "2026-01-01T03:00:00.000Z" })),
      adopt(belief("early", "c2", { observed_at: "2026-01-01T01:00:00.000Z" })),
      adopt(belief("mid", "c3", { observed_at: "2026-01-01T02:00:00.000Z" })),
    ]
    expect(harvestCandidates(events).map((c) => c.belief.id)).toEqual(["early", "mid", "late"])
  })

  test("a belief with no claim/evidence in the log still surfaces (graceful)", () => {
    const out = harvestCandidates([adopt(belief("b1", "missing-claim"))])
    expect(out).toHaveLength(1)
    expect(out[0]?.claim).toBeUndefined()
    expect(out[0]?.evidence).toBeUndefined()
  })

  test("filters by session_id", () => {
    const a = adopt(belief("b1", "c1"))
    const b = { ...adopt(belief("b2", "c2")), session_id: "other-session" }
    const out = harvestCandidates([a, b], { session_id: SESSION })
    expect(out.map((c) => c.belief.id)).toEqual(["b1"])
  })

  test("does not mutate its input events", () => {
    const events = [adopt(belief("b1", "c1")), transition("b1", "truth_status", "supported")]
    const snapshot = JSON.stringify(events)
    harvestCandidates(events)
    expect(JSON.stringify(events)).toBe(snapshot)
  })
})
