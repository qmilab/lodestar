import { describe, expect, test } from "bun:test"
import type { EventEnvelope } from "@qmilab/lodestar-core"
import { pendingApprovals } from "./approvals.js"

/**
 * `pendingApprovals` derives the open-hold queue from a flat event stream. The
 * load-bearing case is the forgery-recovery one: a grant/deny the guard refused
 * to promote (`guard.approval.signature_rejected`) is NOT a real resolution, so
 * the request must stay in the queue — otherwise a forged `approval.granted@1` a
 * local writer planted in the log would silently drop a still-held request, and
 * a legitimate operator could never submit a real signed grant after a forgery.
 * This mirrors `collectResolvedRequestIds` in the `lodestar approve` CLI; the
 * projection can't re-verify signatures (it has no access to the operator's
 * pinned approver keys — the correct boundary), so it trusts the guard's audit.
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

describe("pendingApprovals", () => {
  test("a request with no resolution is pending", () => {
    const out = pendingApprovals([requested("req-1", "act-1", "2026-01-01T00:00:00.000Z")])
    expect(out.map((p) => p.request_id)).toEqual(["req-1"])
    expect(out[0]?.status).toBe("pending")
  })

  test("a genuine grant resolves the request (not pending)", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      makeEvent("approval.granted", resolutionPayload("req-1", "act-1")),
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

  test("a signature-rejected forged grant leaves the request pending", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      // A forged grant a local writer planted in the log...
      makeEvent("approval.granted", resolutionPayload("req-1", "act-1")),
      // ...which the guard refused to promote (signature did not verify).
      makeEvent("guard.approval.signature_rejected", {
        ...resolutionPayload("req-1", "act-1"),
        reason: "approval signature verification failed against the pinned approver keys",
      }),
    ])
    expect(out.map((p) => p.request_id)).toEqual(["req-1"])
  })

  test("a signature-rejected forgery against one request does not affect another genuinely resolved one", () => {
    const out = pendingApprovals([
      requested("req-1", "act-1", "2026-01-01T00:00:00.000Z"),
      requested("req-2", "act-2", "2026-01-01T00:00:05.000Z"),
      // req-1: forged grant rejected → stays pending
      makeEvent("approval.granted", resolutionPayload("req-1", "act-1")),
      makeEvent("guard.approval.signature_rejected", resolutionPayload("req-1", "act-1")),
      // req-2: genuine grant → resolved
      makeEvent("approval.granted", resolutionPayload("req-2", "act-2")),
    ])
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
