import { z } from "zod"
import { TimestampSchema } from "./common.js"

/**
 * Memory-firewall audit events — the wire format the firewall emits for
 * every promotion / transition decision it makes.
 *
 * Design lock: ADR-0029 (and issue #137). The firewall is made observable
 * through the **event stream**, not through a stable store interface. The
 * `MemoryFirewall` already routes each decision to an `auditSink`, and its
 * three hosts (`guard.wrap()`, the MCP proxy, the runtime gate) already
 * write that audit event to the log as `firewall.<kind>`. This module is
 * the stable contract for those already-flowing events, mirroring how
 * `sentinel.alerted@1` / `calibration.computed@1` were stabilized:
 *
 * - These are **governance events, not Observations**. Like
 *   `sentinel.alerted@1`, the payload is the event payload directly and is
 *   NOT registered in the observation schema registry.
 * - The payload is a **structural supertype** of the firewall's richer
 *   internal `FirewallAuditEvent` union (`@qmilab/lodestar-memory-firewall`):
 *   `by_authority` is an opaque string here (the authority set may grow —
 *   additive-safe), while `axis` is the locked four-value enum. So a host
 *   can `parse()` the producer object at the emit boundary without the core
 *   contract weakening or re-typing the firewall's internals.
 * - The three envelope `type` strings are **two-segment** (`firewall.claim.accepted`,
 *   not `firewall.claim_accepted`) and are kept verbatim: existing logs and
 *   the `@qmilab/lodestar-trace` projection (`type.startsWith("firewall.")`)
 *   already depend on them.
 *
 * Every optional field is omitted entirely when unset (never `undefined`)
 * so the event-log writer's canonical hash and `JSON.stringify` never
 * disagree on a dropped key — the same discipline the sentinel and
 * calibration payloads follow.
 *
 * Core owns the wire format only. The `MemoryFirewall` that *produces*
 * these events lives in `@qmilab/lodestar-memory-firewall`; the hosts that
 * *write* them live in `-guard` / `-guard-mcp` / `-runtime-core`.
 */

/**
 * The lifecycle axis a `belief.transitioned` event moved. The four
 * orthogonal axes are a locked architectural decision, so pinning them as
 * an enum is safe — a new axis would be a new attribute, not a new enum
 * value (see the memory-firewall CLAUDE.md).
 */
export const FirewallLifecycleAxisSchema = z.enum([
  "truth_status",
  "retrieval_status",
  "security_status",
  "freshness_status",
])
export type FirewallLifecycleAxis = z.infer<typeof FirewallLifecycleAxisSchema>

/**
 * `firewall.claim.accepted@1` — a freshly-extracted claim cleared the
 * firewall's intake and was persisted at `status: extracted`.
 */
export const FirewallClaimAcceptedPayloadSchema = z.object({
  kind: z.literal("claim.accepted"),
  claim_id: z.string().min(1).describe("The accepted claim's id."),
  at: TimestampSchema.describe("When the firewall accepted the claim."),
  by_actor_id: z.string().min(1).describe("The actor that extracted the claim."),
})
export type FirewallClaimAcceptedPayload = z.infer<typeof FirewallClaimAcceptedPayloadSchema>

/**
 * `firewall.belief.adopted@1` — the promotion gate let a candidate claim
 * become a belief. The references let the read side rebuild the
 * claim → evidence → belief link from the log alone.
 */
export const FirewallBeliefAdoptedPayloadSchema = z.object({
  kind: z.literal("belief.adopted"),
  belief_id: z.string().min(1).describe("The adopted belief's id."),
  claim_id: z.string().min(1).describe("The claim the belief was adopted from."),
  evidence_id: z.string().min(1).describe("The evidence set the adoption cleared against."),
  rationale_id: z.string().min(1).describe("The Explanation id justifying the adoption."),
  by_authority: z
    .string()
    .min(1)
    .describe("The transition authority that permitted the adoption (open set — opaque string)."),
  at: TimestampSchema.describe("When the belief was adopted."),
  by_actor_id: z.string().min(1).describe("The actor that drove the adoption."),
  causal_parent_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Present for a reflection-driven adoption: the events (e.g. reflection.completed) the adoption descends from. Also the envelope's causal_parent_ids. Omitted when not reflection-driven.",
    ),
})
export type FirewallBeliefAdoptedPayload = z.infer<typeof FirewallBeliefAdoptedPayloadSchema>

/**
 * `firewall.belief.transitioned@1` — one lifecycle axis of an existing
 * belief moved (truth/retrieval/security/freshness). `from_value`/`to_value`
 * are opaque strings because each axis has its own value set.
 */
export const FirewallBeliefTransitionedPayloadSchema = z.object({
  kind: z.literal("belief.transitioned"),
  belief_id: z.string().min(1).describe("The belief whose axis moved."),
  axis: FirewallLifecycleAxisSchema.describe("Which lifecycle axis transitioned."),
  from_value: z.string().min(1).describe("The axis value before the transition."),
  to_value: z.string().min(1).describe("The axis value after the transition."),
  by_authority: z
    .string()
    .min(1)
    .describe("The transition authority that permitted the move (open set — opaque string)."),
  rationale_id: z.string().min(1).describe("The Explanation id justifying the transition."),
  at: TimestampSchema.describe("When the transition occurred."),
  by_actor_id: z.string().min(1).describe("The actor that drove the transition."),
  causal_parent_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Present for a reflection-driven transition: the events it descends from. Also the envelope's causal_parent_ids. Omitted otherwise.",
    ),
  superseded_by: z
    .string()
    .optional()
    .describe(
      "Set only for a truth_status → superseded transition: the successor belief id, so the supersession link is reconstructable from the log alone. Omitted otherwise.",
    ),
})
export type FirewallBeliefTransitionedPayload = z.infer<
  typeof FirewallBeliefTransitionedPayloadSchema
>

/**
 * The payload of any `firewall.*@1` event, discriminated on `kind`. A host
 * parses a `MemoryFirewall` audit event against this before stamping the
 * version and appending the envelope.
 */
export const FirewallAuditPayloadSchema = z.discriminatedUnion("kind", [
  FirewallClaimAcceptedPayloadSchema,
  FirewallBeliefAdoptedPayloadSchema,
  FirewallBeliefTransitionedPayloadSchema,
])
export type FirewallAuditPayload = z.infer<typeof FirewallAuditPayloadSchema>

/**
 * Event-type literals and the shared schema version. Use the constants
 * rather than the bare strings so a future rename is grep-safe — same
 * convention as `SENTINEL_ALERTED_EVENT_TYPE`. The three types share one
 * version because they version together as one audit family.
 */
export const FIREWALL_CLAIM_ACCEPTED_EVENT_TYPE = "firewall.claim.accepted" as const
export const FIREWALL_BELIEF_ADOPTED_EVENT_TYPE = "firewall.belief.adopted" as const
export const FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE = "firewall.belief.transitioned" as const
export const FIREWALL_EVENT_SCHEMA_VERSION = "1" as const

/**
 * The envelope `type` string for a given audit `kind`. The single place
 * the `firewall.<kind>` mapping is defined, shared by every host emitter so
 * the three sites cannot drift.
 */
export function firewallEventType(
  kind: FirewallAuditPayload["kind"],
):
  | typeof FIREWALL_CLAIM_ACCEPTED_EVENT_TYPE
  | typeof FIREWALL_BELIEF_ADOPTED_EVENT_TYPE
  | typeof FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE {
  switch (kind) {
    case "claim.accepted":
      return FIREWALL_CLAIM_ACCEPTED_EVENT_TYPE
    case "belief.adopted":
      return FIREWALL_BELIEF_ADOPTED_EVENT_TYPE
    case "belief.transitioned":
      return FIREWALL_BELIEF_TRANSITIONED_EVENT_TYPE
  }
}
