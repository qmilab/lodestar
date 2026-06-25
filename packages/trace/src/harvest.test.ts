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
import {
  FIREWALL_BELIEF_ADOPTED_EVENT_TYPE,
  FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
} from "@qmilab/lodestar-core"
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
function makeEvent(type: string, payload: unknown, schemaVersion = "1"): EventEnvelope {
  seq += 1
  return {
    id: `evt-${seq}`,
    seq,
    type,
    schema_version: schemaVersion,
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

/** Just the full `belief.adopted` record — the agent-forgeable half (no audit). */
function adoptRecord(b: Belief): EventEnvelope {
  return makeEvent("belief.adopted", b)
}
/** The host-authored `firewall.belief.adopted@1` audit (schema_version "1") an agent can't forge. */
function firewallAdopted(beliefId: string, claimId: string): EventEnvelope {
  return makeEvent(FIREWALL_BELIEF_ADOPTED_EVENT_TYPE, {
    kind: "belief.adopted",
    belief_id: beliefId,
    claim_id: claimId,
    evidence_id: `ev-${beliefId}`,
    rationale_id: `exp-${beliefId}`,
    by_authority: "promotion",
    at: "2026-01-01T00:00:00.000Z",
    by_actor_id: "test-actor",
  })
}
/** A genuinely-adopted belief: the full record + its host-authored audit. */
function adopt(b: Belief): EventEnvelope[] {
  return [adoptRecord(b), firewallAdopted(b.id, b.claim_id)]
}
/** Flatten mixed single events and event arrays into one log. */
function log(...parts: (EventEnvelope | EventEnvelope[])[]): EventEnvelope[] {
  return parts.flat()
}
function extract(c: Claim): EventEnvelope {
  return makeEvent("claim.extracted", c)
}
function assess(e: EvidenceSet): EventEnvelope {
  return makeEvent("evidence.assessed", e)
}
function transitionPayload(beliefId: string, axis: string, toValue: string, supersededBy?: string) {
  return {
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
  }
}

/** A genuine firewall-authored transition: canonical type + `schema_version: "1"`. */
function transition(
  beliefId: string,
  axis: string,
  toValue: string,
  supersededBy?: string,
): EventEnvelope {
  return makeEvent(
    FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
    transitionPayload(beliefId, axis, toValue, supersededBy),
  )
}

/**
 * A forged transition a governed agent could write via `ctx.emit`: the same
 * canonical type + payload, but pinned to the session `schema_version` ("0.1.0")
 * the agent cannot override. Must be ignored by lifecycle reconstruction.
 */
function forgedTransition(beliefId: string, axis: string, toValue: string): EventEnvelope {
  return makeEvent(
    FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE,
    transitionPayload(beliefId, axis, toValue),
    "0.1.0",
  )
}

describe("harvestCandidates", () => {
  test("empty log yields no candidates", () => {
    expect(harvestCandidates([])).toEqual([])
  })

  test("a supported belief surfaces with its claim + evidence as a candidate", () => {
    const events = log(
      extract(claim("c1", "tests must pass before commit")),
      assess(evidenceSet("ev1", "c1")),
      adopt(belief("b1", "c1")),
    )
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
    const out = harvestCandidates(adopt(belief("b1", "c1", { truth_status: "unverified" })))
    expect(out).toEqual([])
  })

  test("a belief adopted unverified then transitioned to supported IS a candidate", () => {
    const events = log(
      adopt(belief("b1", "c1", { truth_status: "unverified" })),
      transition("b1", "truth_status", "supported"),
    )
    const out = harvestCandidates(events)
    expect(out).toHaveLength(1)
    expect(out[0]?.belief.truth_status).toBe("supported")
  })

  test("a supported belief later quarantined is excluded (security gate)", () => {
    const events = log(
      adopt(belief("b1", "c1")),
      transition("b1", "security_status", "quarantined"),
    )
    expect(harvestCandidates(events)).toEqual([])
  })

  test("a supported belief later blocked/hidden is excluded (retrieval gate)", () => {
    for (const demoted of ["blocked", "hidden", "privileged_only"]) {
      const events = log(adopt(belief("b1", "c1")), transition("b1", "retrieval_status", demoted))
      expect(harvestCandidates(events)).toEqual([])
    }
  })

  test("a supported belief adopted directly quarantined/malicious is excluded", () => {
    expect(
      harvestCandidates(adopt(belief("b1", "c1", { security_status: "quarantined" }))),
    ).toEqual([])
    expect(harvestCandidates(adopt(belief("b2", "c1", { security_status: "malicious" })))).toEqual(
      [],
    )
  })

  test("restricted retrieval is still a candidate (adopted/default state)", () => {
    const out = harvestCandidates(adopt(belief("b1", "c1", { retrieval_status: "restricted" })))
    expect(out).toHaveLength(1)
  })

  test("freshness and sensitivity are surfaced, not gated (reviewer's call)", () => {
    const out = harvestCandidates(
      adopt(belief("b1", "c1", { freshness_status: "expired", sensitivity: "secret" })),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.belief.freshness_status).toBe("expired")
    expect(out[0]?.belief.sensitivity).toBe("secret")
  })

  test("supersession surfaces the successor with the replaced lesson as history", () => {
    const events = log(
      adopt(belief("b1", "c1", { observed_at: "2026-01-01T00:00:00.000Z" })),
      adopt(belief("b2", "c2", { observed_at: "2026-01-01T00:10:00.000Z" })),
      extract(claim("c1", "old lesson")),
      extract(claim("c2", "new lesson")),
      // b1 is superseded by b2
      transition("b1", "truth_status", "superseded", "b2"),
    )
    const out = harvestCandidates(events)
    // Only b2 (the current lesson) is a top-level candidate; b1 is its history.
    expect(out.map((c) => c.belief.id)).toEqual(["b2"])
    expect(out[0]?.supersedes).toHaveLength(1)
    expect(out[0]?.supersedes[0]?.belief.id).toBe("b1")
    expect(out[0]?.supersedes[0]?.belief.truth_status).toBe("superseded")
    expect(out[0]?.supersedes[0]?.claim?.statement).toBe("old lesson")
  })

  test("a multi-level supersession chain lists history newest-first", () => {
    const events = log(
      adopt(belief("b0", "c0", { observed_at: "2026-01-01T00:00:00.000Z" })),
      adopt(belief("b1", "c1", { observed_at: "2026-01-01T00:05:00.000Z" })),
      adopt(belief("b2", "c2", { observed_at: "2026-01-01T00:10:00.000Z" })),
      transition("b0", "truth_status", "superseded", "b1"),
      transition("b1", "truth_status", "superseded", "b2"),
    )
    const out = harvestCandidates(events)
    expect(out.map((c) => c.belief.id)).toEqual(["b2"])
    expect(out[0]?.supersedes.map((s) => s.belief.id)).toEqual(["b1", "b0"])
  })

  test("candidates are ordered oldest-first by observed_at", () => {
    const events = log(
      adopt(belief("late", "c1", { observed_at: "2026-01-01T03:00:00.000Z" })),
      adopt(belief("early", "c2", { observed_at: "2026-01-01T01:00:00.000Z" })),
      adopt(belief("mid", "c3", { observed_at: "2026-01-01T02:00:00.000Z" })),
    )
    expect(harvestCandidates(events).map((c) => c.belief.id)).toEqual(["early", "mid", "late"])
  })

  test("a belief with no claim/evidence in the log still surfaces (graceful)", () => {
    const out = harvestCandidates(adopt(belief("b1", "missing-claim")))
    expect(out).toHaveLength(1)
    expect(out[0]?.claim).toBeUndefined()
    expect(out[0]?.evidence).toBeUndefined()
  })

  test("filters by session_id", () => {
    const a = adopt(belief("b1", "c1"))
    const b = adopt(belief("b2", "c2")).map((e) => ({ ...e, session_id: "other-session" }))
    const out = harvestCandidates(log(a, b), { session_id: SESSION })
    expect(out.map((c) => c.belief.id)).toEqual(["b1"])
  })

  test("does not mutate its input events", () => {
    const events = log(adopt(belief("b1", "c1")), transition("b1", "truth_status", "supported"))
    const snapshot = JSON.stringify(events)
    harvestCandidates(events)
    expect(JSON.stringify(events)).toBe(snapshot)
  })

  // ── host-authored adoption required (Codex P1, round 2) ────────────────────

  test("a belief.adopted with no firewall.belief.adopted audit is not harvested", () => {
    // An agent ctx.emit can write the full record but cannot stamp the firewall
    // audit, so a fabricated belief never becomes a keeper candidate.
    const out = harvestCandidates([adoptRecord(belief("b1", "c1"))])
    expect(out).toEqual([])
  })

  test("a later forged belief.adopted cannot overwrite a genuine adoption's content", () => {
    // Genuine adoption: b1 quarantined (firewall flagged it). The agent then
    // re-emits belief.adopted for b1 flipped to clean. First-wins keeps the
    // genuine quarantined record, so b1 stays excluded.
    const events = log(
      adopt(belief("b1", "c1", { security_status: "quarantined" })),
      adoptRecord(belief("b1", "c1", { security_status: "clean" })),
    )
    expect(harvestCandidates(events)).toEqual([])
  })

  // ── firewall-authored transitions only (Codex P1#1, round 1) ──────────────

  test("a forged transition (wrong schema_version) cannot clear a quarantined belief", () => {
    const events = log(
      adopt(belief("b1", "c1", { security_status: "quarantined" })),
      // An agent ctx.emit at the session schema version, not the firewall's.
      forgedTransition("b1", "security_status", "clean"),
    )
    expect(harvestCandidates(events)).toEqual([])
  })

  test("a forged transition cannot promote an unverified belief to supported", () => {
    const events = log(
      adopt(belief("b1", "c1", { truth_status: "unverified" })),
      forgedTransition("b1", "truth_status", "supported"),
    )
    expect(harvestCandidates(events)).toEqual([])
  })

  test("a bare belief.transitioned / kind-tagged agent emit is not trusted", () => {
    const bare = makeEvent(
      "belief.transitioned",
      transitionPayload("b1", "security_status", "clean"),
    )
    const tagged = makeEvent(
      "some.agent.event",
      transitionPayload("b1", "security_status", "clean"),
    )
    const events = log(adopt(belief("b1", "c1", { security_status: "quarantined" })), bare, tagged)
    expect(harvestCandidates(events)).toEqual([])
  })

  test("a genuine firewall clearance (schema_version 1) does clear a quarantine", () => {
    // Positive control for the forged-transition tests above.
    const events = log(
      adopt(belief("b1", "c1", { security_status: "quarantined" })),
      transition("b1", "security_status", "clean"),
    )
    expect(harvestCandidates(events)).toHaveLength(1)
  })

  // ── supersession history respects the security gate (Codex P1#2, round 1) ──

  test("a quarantined predecessor is excluded from supersession history", () => {
    const events = log(
      adopt(belief("b1", "c1", { security_status: "quarantined" })),
      adopt(belief("b2", "c2")),
      transition("b1", "truth_status", "superseded", "b2"),
    )
    const out = harvestCandidates(events)
    expect(out.map((c) => c.belief.id)).toEqual(["b2"])
    // b1 is quarantined: it is neither a candidate nor surfaced as history.
    expect(out[0]?.supersedes).toEqual([])
  })

  test("a blocked predecessor is excluded from history but a clean ancestor behind it surfaces", () => {
    // b0 (clean) → b1 (blocked) → b2 (clean, head). b1 hidden, b0 still shown.
    const events = log(
      adopt(belief("b0", "c0", { observed_at: "2026-01-01T00:00:00.000Z" })),
      adopt(
        belief("b1", "c1", {
          retrieval_status: "blocked",
          observed_at: "2026-01-01T00:05:00.000Z",
        }),
      ),
      adopt(belief("b2", "c2", { observed_at: "2026-01-01T00:10:00.000Z" })),
      transition("b0", "truth_status", "superseded", "b1"),
      transition("b1", "truth_status", "superseded", "b2"),
    )
    const out = harvestCandidates(events)
    expect(out.map((c) => c.belief.id)).toEqual(["b2"])
    expect(out[0]?.supersedes.map((s) => s.belief.id)).toEqual(["b0"])
  })
})
