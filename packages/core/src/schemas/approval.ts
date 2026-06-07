import { z } from "zod"
import { SignatureSchema } from "./actor.js"
import { TimestampSchema } from "./common.js"
import { RequiredAuthoritySchema } from "./policy.js"

/**
 * The approval workflow wire formats — the first-class record of an action
 * parked at `pending_approval` and the events that resolve it.
 *
 * Design lock: `docs/architecture/policy-kernel.md`, "The approval workflow".
 * The discipline mirrors the sentinel / reflection governance events:
 *
 * - These are governance events, NOT Observations. Like `sentinel.alerted@1`,
 *   each payload is the event payload directly and is NOT registered in the
 *   observation schema registry.
 * - Grant and deny are *distinct event types*, not one event with an
 *   `approved` flag. The type *is* the verdict, so a redundant boolean (which
 *   could disagree with the type on re-read) is omitted. When the resolution
 *   folds back into the action via the Action Kernel's `resolve()`, it lands
 *   in the action's existing `approval` field (`ApprovalEvent`), where a
 *   single boolean is the natural shape — so the stream view
 *   (type-discriminated) and the single-action view agree without duplicating
 *   the verdict on the wire.
 * - No optional field is ever set to `undefined` — it is omitted entirely when
 *   unset (`deadline` and `reason` in particular), so the event-log writer's
 *   `canonicalHash` (undefined → null) and `JSON.stringify` (drops the key)
 *   cannot disagree on re-read.
 *
 * Core owns the wire format only. The lifecycle manager — opening a request on
 * a hold, matching a resolution against `required_authority`, driving the
 * Action-Kernel `resolve()` transition — lives in
 * `@qmilab/lodestar-policy-kernel`.
 */

/**
 * The payload of an `approval.requested@1` event: a parked action awaiting a
 * human (or auto-rule) verdict. `reason` is the matched rule's reason,
 * verbatim. `required_authority` says what an approver must be (checked
 * against the resolver's `Actor`); an empty object means any configured
 * resolver may approve.
 *
 * `deadline` is the proxy's hold timeout (the MCP path cannot hold a
 * `tools/call` open indefinitely without tripping client timeouts); it is
 * *omitted entirely* in the in-process `guard.wrap()` path, where a hold can
 * simply await the resolver — never set to `undefined`.
 */
export const ApprovalRequestSchema = z.object({
  request_id: z.string().min(1),
  action_id: z.string().min(1).describe("the parked action, at phase pending_approval"),
  reason: z.string().min(1).describe("the matched rule's reason, verbatim"),
  required_authority: RequiredAuthoritySchema.describe(
    "what an approver must be; checked against the resolver's Actor. Empty object = any configured resolver",
  ),
  requested_at: TimestampSchema,
  deadline: TimestampSchema.optional().describe(
    "ISO 8601 hold timeout (proxy path); omitted entirely in-process, never undefined",
  ),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

/**
 * The payload of an `approval.granted@1` event. The event *type* is the
 * verdict — there is no `approved` boolean. `reason` (the approver's note) is
 * omitted entirely when unset.
 *
 * `signature` is an optional Ed25519 signature over the canonical resolution
 * document (`{ request_id, action_id, kind, approver_id, reason?, at }`),
 * produced by the approver's private key. When present it makes the granted
 * event **self-verifying in the log**: a reader can later re-check the grant
 * came from an operator-pinned approver key, not merely trust that the proxy
 * verified it at promotion time. Its `signer_id` equals `approver_id` (the same
 * actor that resolved). Omitted entirely when unset (never `undefined`), so the
 * canonical-hash discipline above carries through; the cross-process proxy path
 * requires it (a forged side-channel grant cannot un-park an action), while the
 * in-process resolver path may omit it (same trusted process, no forgery
 * surface). Hash + verification live in `@qmilab/lodestar-policy-kernel`.
 */
export const ApprovalGrantedPayloadSchema = z.object({
  request_id: z.string().min(1),
  action_id: z.string().min(1),
  approver_id: z.string().min(1).describe("actor_id of the resolver"),
  reason: z.string().min(1).optional().describe("approver's note; omitted entirely when unset"),
  at: TimestampSchema,
  signature: SignatureSchema.optional().describe(
    "Ed25519 signature over the canonical resolution; signer_id === approver_id; omitted entirely when unset",
  ),
})
export type ApprovalGrantedPayload = z.infer<typeof ApprovalGrantedPayloadSchema>

/**
 * The payload of an `approval.denied@1` event. Identical shape to
 * `approval.granted@1` — the verdict is carried by the event type, not a
 * field. Defined as its own schema (rather than re-exporting one shared
 * object) so the two event types stay independently evolvable. `signature`
 * follows the same contract as the grant payload (a denial is also authority-
 * bearing — it must not be forgeable into un-holding via a later grant either).
 */
export const ApprovalDeniedPayloadSchema = z.object({
  request_id: z.string().min(1),
  action_id: z.string().min(1),
  approver_id: z.string().min(1).describe("actor_id of the resolver"),
  reason: z.string().min(1).optional().describe("approver's note; omitted entirely when unset"),
  at: TimestampSchema,
  signature: SignatureSchema.optional().describe(
    "Ed25519 signature over the canonical resolution; signer_id === approver_id; omitted entirely when unset",
  ),
})
export type ApprovalDeniedPayload = z.infer<typeof ApprovalDeniedPayloadSchema>

/**
 * The payload of an `approval.expired@1` event: the deadline passed with no
 * human resolution. Carries no `approver_id` — no actor resolved it; the
 * passage of the deadline did. The Action Kernel transitions the parked action
 * to `rejected` on receipt (a timed-out hold is a soft denial the agent
 * re-proposes; durable resume is deferred — `policy-kernel.md`).
 */
export const ApprovalExpiredPayloadSchema = z.object({
  request_id: z.string().min(1),
  action_id: z.string().min(1),
  at: TimestampSchema,
})
export type ApprovalExpiredPayload = z.infer<typeof ApprovalExpiredPayloadSchema>

/**
 * Event-type literals and versions. Use the constants rather than the bare
 * strings so a future rename is grep-safe — same convention as
 * `SENTINEL_ALERTED_EVENT_TYPE` and `REFLECTION_COMPLETED_EVENT_TYPE`.
 */
export const APPROVAL_REQUESTED_EVENT_TYPE = "approval.requested" as const
export const APPROVAL_REQUESTED_SCHEMA_VERSION = "1" as const
export const APPROVAL_GRANTED_EVENT_TYPE = "approval.granted" as const
export const APPROVAL_GRANTED_SCHEMA_VERSION = "1" as const
export const APPROVAL_DENIED_EVENT_TYPE = "approval.denied" as const
export const APPROVAL_DENIED_SCHEMA_VERSION = "1" as const
export const APPROVAL_EXPIRED_EVENT_TYPE = "approval.expired" as const
export const APPROVAL_EXPIRED_SCHEMA_VERSION = "1" as const
