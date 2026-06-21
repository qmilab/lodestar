import { describe, expect, test } from "bun:test"
import {
  type EventEnvelope,
  GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE,
} from "@qmilab/lodestar-core"
import { pendingApprovals } from "./approvals.js"

/**
 * `pendingApprovals` derives the open-hold queue from a flat event stream. The
 * load-bearing cases are the forgery ones: the guard refuses to promote a grant
 * or deny whose signature does not verify against the operator-pinned approver
 * keys and records a `guard.approval.signature_rejected` audit. The projection
 * can't re-verify signatures (it has no access to those keys — the correct
 * boundary), so it trusts the audit, and excludes the rejected resolution
 * *precisely*:
 *   - a `source: "log"` rejection names the forged event via `rejected_event_id`,
 *     so a forged log grant is excluded by id while a genuine grant the operator
 *     submits afterwards still resolves the request;
 *   - a `source: "side_channel"` rejection promotes no log event, so it excludes
 *     nothing;
 *   - a legacy rejection (no `source`/`rejected_event_id`) falls back to the
 *     conservative, ungameable per-request exclusion.
 * Mirrors `collectResolvedRequestIds` in the `lodestar approve` CLI.
 */

const PROJECT = "trace-approvals-test-project"
const SESSION = "trace-approvals-test-session"

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

function requested(requestId: string, actionId: string, requestedAt: string): EventEnvelope {
  return makeEvent("approval.requested", {
    request_id: requestId,
    action_id: actionId,
    reason: "L4 action requires approval",
    required_authority: {},
    requested_at: requestedAt,
  })
}

const resolutionPayload = (requestId: string, actionId: string) => ({
  request_id: requestId,
  action_id: actionId,
  approver_id: "alice",
  at: "2026-01-01T00:01:00.000Z",
})

function grant(requestId: string, actionId: string): EventEnvelope {
  return makeEvent("approval.granted", resolutionPayload(requestId, actionId))
}

/** A `source: "log"` rejection naming a specific forged log event. */
function rejectLog(forged: EventEnvelope): EventEnvelope {
  const p = forged.payload as { request_id: string; action_id: string; approver_id?: string }
  return makeEvent(GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE, {
    request_id: p.request_id,
    action_id: p.action_id,
    approver_id: p.approver_id ?? "alice",
    reason: "approval signature verification failed against the pinned approver keys",
    at: "2026-01-01T00:02:00.000Z",
    source: "log",
    rejected_event_id: forged.id,
  })
}

/** A `source: "side_channel"` rejection — no log event, so no `rejected_event_id`. */
function rejectSideChannel(requestId: string, actionId: string): EventEnvelope {
  return makeEvent(GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE, {
    request_id: requestId,
    action_id: actionId,
    approver_id: "alice",
    reason: "approval signature verification failed against the pinned approver keys",
    at: "2026-01-01T00:02:00.000Z",
    source: "side_channel",
  })
}

/** A pre-`source` legacy rejection (the shape emitted before this change). */
function rejectLegacy(requestId: string, actionId: string): EventEnvelope {
  return makeEvent(GUARD_APPROVAL_SIGNATURE_REJECTED_EVENT_TYPE, {
    request_id: requestId,
    action_id: actionId,
    approver_id: "alice",
    reason: "approval signature verification failed against the pinned approver keys",
    at: "2026-01-01T00:02:00.000Z",
  })
}

describe("pendingApprovals", () => {
  test("a request with no resolution is pending", () => {
    const out = pendingApprovals([requested("req-1", "act-1", "2026-01-01T00:00:00.000Z")])
    expect(out.map((p) => p.request_id)).toEqual(["req-1"])
    expect(out[0]?.status).toBe("pending")
  })

  test("a genuine grant resolves the request (not pending)", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      grant("req-1", "act-1"),
    ])
    expect(out).toEqual([])
  })

  test("a genuine deny resolves the request (not pending)", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      makeEvent("approval.denied", resolutionPayload("req-1", "act-1")),
    ])
    expect(out).toEqual([])
  })

  test("an expired hold is definitive (not pending)", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      makeEvent("approval.expired", { request_id: "req-1", action_id: "act-1" }),
    ])
    expect(out).toEqual([])
  })

  test("a rejected forged log grant leaves the request pending", () => {
    const forged = grant("req-1", "act-1")
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      forged, // a forged grant a local writer planted in the log...
      rejectLog(forged), // ...which the guard refused to promote.
    ])
    expect(out.map((p) => p.request_id)).toEqual(["req-1"])
  })

  test("a genuine grant AFTER a rejected log forgery resolves the request (P2 fix)", () => {
    const forged = grant("req-1", "act-1")
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      forged,
      rejectLog(forged),
      grant("req-1", "act-1"), // genuine grant the operator submits during recovery
    ])
    expect(out).toEqual([])
  })

  test("excluding the forged event by id does not exclude a different valid grant", () => {
    const forged = grant("req-1", "act-1")
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      requested("req-2", "act-2", "2026-01-01T00:00:05.000Z"),
      forged,
      rejectLog(forged),
      grant("req-2", "act-2"), // unrelated genuine grant
    ])
    // req-1 stays pending (its only grant was the rejected forgery); req-2 resolves.
    expect(out.map((p) => p.request_id)).toEqual(["req-1"])
  })

  test("a side-channel rejection excludes nothing; a genuine grant resolves", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      rejectSideChannel("req-1", "act-1"), // a forged .approvals file, never a log event
      grant("req-1", "act-1"), // the genuine grant the operator then submitted
    ])
    expect(out).toEqual([])
  })

  test("a legacy rejection (no source/id) falls back to conservative per-request exclusion", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      grant("req-1", "act-1"), // can't tell if this is the forgery or genuine...
      rejectLegacy("req-1", "act-1"), // ...so an old-shape rejection taints the request
    ])
    // No P1 regression on old logs: the request stays pending.
    expect(out.map((p) => p.request_id)).toEqual(["req-1"])
  })

  test("queue is oldest-request-first", () => {
    const out = pendingApprovals([
      requested("req-late", "act-late", "2026-01-01T00:05:00.000Z"),
      requested("req-early", "act-early", "2026-01-01T00:01:00.000Z"),
    ])
    expect(out.map((p) => p.request_id)).toEqual(["req-early", "req-late"])
  })
})
