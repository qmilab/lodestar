import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"
import { type NostrCredential, type PreparedSigner, prepareSigner } from "./credentials.js"
import { noteIdFromHex, npubFromHex, signEvent, verifyEvent } from "./event.js"
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_RELAY_TIMEOUT_MS,
  fetchFromRelay,
  publishToRelay,
} from "./relay.js"

/**
 * Native Nostr *transport* tools — `nostr.publish` (egress, L4) and
 * `nostr.fetch` (inbound, untrusted). P2 slice 3 (ADR-0005 / ADR-0007).
 *
 * `nostr.publish` is the second native egress after `git.push`, and the same
 * governance shape applies with one substitution: on Nostr the **signing key is
 * the credential**, and signing is in-process (BIP-340 Schnorr) rather than a
 * subprocess. The teeth:
 *
 *   - **Relay pinning.** The operator pins the allowed relay URLs; the agent may
 *     only target a pinned URL (or, by default, all of them). It cannot exfiltrate
 *     a note to an attacker-controlled relay — the Nostr analogue of git's remote
 *     pinning. Pinning applies to `nostr.fetch` too: the agent cannot make the
 *     adapter open a socket to an arbitrary URL (an SSRF guard on reads).
 *   - **Kind allowlist.** The operator pins which event kinds may be published
 *     (default: kind 1, text notes). The agent cannot publish a deletion
 *     (kind 5), a metadata/contact-list overwrite (kind 0 / 3), etc. unless the
 *     operator opts in.
 *   - **Credential scoping.** The secret key is operator-supplied, resolved at
 *     publish time, never seen by the agent, never on the wire (only the pubkey
 *     and signature are), and redacted from captured output.
 *   - **Untrusted inbound.** Fetched events are returned with a per-event
 *     `signature_valid` flag (the id is recomputed AND the schnorr signature
 *     verified locally) but are otherwise UNTRUSTED external content — a valid
 *     signature proves authorship, not truth. Malformed events are dropped and
 *     counted, never silently trusted.
 */

// -----------------------------------------------------------------------------
// Output schemas (registered; guarded so a double import is a harmless no-op).
// -----------------------------------------------------------------------------

const RelayPublishResultSchema = z.object({
  relay: z.string(),
  accepted: z.boolean(),
  message: z.string().describe("the relay's OK reason (redacted)"),
  authenticated: z.boolean().describe("whether a NIP-42 AUTH round completed first"),
})

export const NostrPublishOutputSchema = z
  .object({
    published: z.boolean().describe("true if at least one pinned relay accepted the event"),
    event_id: z.string().describe("the signed event id (hex)"),
    note_id: z.string().describe("NIP-19 note1… encoding of the event id"),
    pubkey: z.string().describe("x-only public key (hex) the note was signed with"),
    npub: z.string().describe("NIP-19 npub1… encoding of the public key"),
    kind: z.number().int(),
    created_at: z.number().int(),
    relay_results: z.array(RelayPublishResultSchema),
    summary: z.string(),
  })
  .describe("nostr.publish tool output")

const FetchedEventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
  signature_valid: z
    .boolean()
    .describe("the id recomputed AND the schnorr signature verified locally"),
  relay: z.string().describe("which relay returned this event"),
})

const RelayFetchResultSchema = z.object({
  relay: z.string(),
  event_count: z.number().int().nonnegative(),
  eose: z.boolean().describe("did the relay signal end-of-stored-events"),
  truncated: z.boolean().describe("did this relay hit the per-relay max-events bound"),
  message: z.string().describe("a relay NOTICE/CLOSED reason or timeout note (redacted)"),
})

export const NostrFetchOutputSchema = z
  .object({
    events: z
      .array(FetchedEventSchema)
      .describe("UNTRUSTED external content. signature_valid attests authorship only, not truth."),
    event_count: z.number().int().nonnegative(),
    malformed_count: z
      .number()
      .int()
      .nonnegative()
      .describe("events dropped for not matching the NIP-01 shape"),
    truncated: z.boolean().describe("collection stopped at the overall max-events bound"),
    relay_results: z.array(RelayFetchResultSchema),
    summary: z.string(),
  })
  .describe("nostr.fetch tool output")

if (!registry.has("nostr.publish@1")) registry.register("nostr.publish@1", NostrPublishOutputSchema)
if (!registry.has("nostr.fetch@1")) registry.register("nostr.fetch@1", NostrFetchOutputSchema)

export type NostrPublishOutput = z.infer<typeof NostrPublishOutputSchema>
export type NostrFetchOutput = z.infer<typeof NostrFetchOutputSchema>

// -----------------------------------------------------------------------------
// Input schemas
// -----------------------------------------------------------------------------

const NostrPublishInputSchema = z.object({
  content: z.string().describe("the note body"),
  kind: z
    .number()
    .int()
    .min(0)
    .max(65535)
    .optional()
    .describe("event kind; default 1 (text note); must be operator-allowed"),
  tags: z
    .array(z.array(z.string()))
    .optional()
    .describe('NIP-01 tags (array of string arrays), e.g. [["t","nostr"]]'),
  relays: z
    .array(z.string().min(1))
    .optional()
    .describe("target relay URLs; each MUST be operator-pinned; default = all pinned relays"),
})

const NostrFilterSchema = z
  .object({
    ids: z.array(z.string()).optional(),
    authors: z.array(z.string()).optional(),
    kinds: z.array(z.number().int()).optional(),
    since: z.number().int().optional(),
    until: z.number().int().optional(),
    limit: z.number().int().positive().optional(),
    tags: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe('single-letter tag filters, e.g. { "t": ["nostr"] } → #t'),
  })
  .strict()

const NostrFetchInputSchema = z.object({
  filters: z
    .array(NostrFilterSchema)
    .optional()
    .describe("NIP-01 REQ filters; default [{ kinds: [1] }]"),
  relays: z
    .array(z.string().min(1))
    .optional()
    .describe("relay URLs to query; each MUST be operator-pinned; default = all pinned relays"),
})

// Shape of a raw event off the wire, before we trust anything about it.
const RawNostrEventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
})

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Confine the agent's chosen relays to the operator-pinned allowlist. Returns
 * the resolved target list (all pinned when the agent named none). Throws on any
 * non-pinned URL — the relay-pinning / SSRF guard. */
function resolveTargets(pinned: string[], requested: string[] | undefined, tool: string): string[] {
  const pinnedSet = new Set(pinned.map((r) => r.trim()))
  if (requested === undefined || requested.length === 0) {
    if (pinned.length === 0) throw new Error(`${tool}: no relays are pinned`)
    return [...pinned]
  }
  const targets = requested.map((r) => r.trim())
  for (const t of targets) {
    if (!pinnedSet.has(t)) {
      throw new Error(
        `${tool}: relay '${t}' is not in the operator-pinned relays (${pinned.join(", ") || "none"})`,
      )
    }
  }
  return targets
}

/** Translate a typed filter into a NIP-01 wire filter (the `tags` map becomes
 * `#x` keys) and clamp `limit` to the adapter's max-events bound. */
function toWireFilter(filter: z.infer<typeof NostrFilterSchema>, maxEvents: number): unknown {
  const { tags, limit, ...rest } = filter
  const wire: Record<string, unknown> = { ...rest }
  wire.limit = Math.min(limit ?? maxEvents, maxEvents)
  if (tags) for (const [key, vals] of Object.entries(tags)) wire[`#${key}`] = vals
  return wire
}

// -----------------------------------------------------------------------------
// nostr.publish — egress, L4
// -----------------------------------------------------------------------------

export interface NostrPublishToolOptions {
  /** Operator-pinned relay URLs: the allowlist AND the default fan-out targets. */
  relays: string[]
  /** The signing key. Explicit, no default (security-relevant). */
  credential: NostrCredential
  /** Event kinds the agent may publish. Default [1] (text notes only). */
  allowedKinds?: number[]
  /** Per-relay wall-clock timeout. Default 10s. */
  timeoutMs?: number
  /** Trust floor. Default L4 — egress, held until approved. */
  trust?: TrustLevel
}

export function makeNostrPublishTool(
  opts: NostrPublishToolOptions,
): Tool<z.infer<typeof NostrPublishInputSchema>, NostrPublishOutput> {
  const pinned = [...opts.relays]
  const allowedKinds = opts.allowedKinds ?? [1]
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS
  const prepared: PreparedSigner = prepareSigner(opts.credential)
  const effects: Effect[] = [
    { kind: "external_call", description: "connect to a nostr relay" },
    { kind: "publication", description: "publish a signed note to a public relay" },
  ]
  return {
    name: "nostr.publish",
    inputs: NostrPublishInputSchema,
    output_schema_key: "nostr.publish@1",
    effects,
    reversibility: "irreversible",
    permissions: ["network.egress", "secret.sign"] as Permission[],
    required_trust_level: opts.trust ?? 4,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      const kind = inputs.kind ?? 1
      if (!allowedKinds.includes(kind)) {
        throw new Error(
          `nostr.publish: kind ${kind} is not in the operator-allowed kinds (${allowedKinds.join(", ")})`,
        )
      }
      const targets = resolveTargets(pinned, inputs.relays, "nostr.publish")
      const signer = await prepared.resolve()
      const event = signEvent(signer.secretKey, {
        created_at: Math.floor(Date.now() / 1000),
        kind,
        tags: inputs.tags ?? [],
        content: inputs.content,
      })
      const relay_results = await Promise.all(
        targets.map((url) =>
          publishToRelay(url, event, signer, { timeoutMs, redactions: signer.redactions }),
        ),
      )
      const published = relay_results.some((r) => r.accepted)
      const accepted = relay_results.filter((r) => r.accepted).length
      return {
        published,
        event_id: event.id,
        note_id: noteIdFromHex(event.id),
        pubkey: signer.pubkey,
        npub: npubFromHex(signer.pubkey),
        kind,
        created_at: event.created_at,
        relay_results,
        summary: `kind ${kind} note ${published ? "accepted" : "rejected"} by ${accepted}/${relay_results.length} relay(s)`,
      }
    },
  }
}

// -----------------------------------------------------------------------------
// nostr.fetch — inbound, untrusted
// -----------------------------------------------------------------------------

export interface NostrFetchToolOptions {
  /** Operator-pinned relay URLs: the allowlist (SSRF guard) AND default targets. */
  relays: string[]
  /** Overall cap on events collected. Default 200. */
  maxEvents?: number
  /** Per-relay wall-clock timeout. Default 10s. */
  timeoutMs?: number
  /** Trust floor. Default L1 — a relay-pinned read of untrusted content. */
  trust?: TrustLevel
}

export function makeNostrFetchTool(
  opts: NostrFetchToolOptions,
): Tool<z.infer<typeof NostrFetchInputSchema>, NostrFetchOutput> {
  const pinned = [...opts.relays]
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS
  const effects: Effect[] = [{ kind: "external_call", description: "subscribe to a nostr relay" }]
  return {
    name: "nostr.fetch",
    inputs: NostrFetchInputSchema,
    output_schema_key: "nostr.fetch@1",
    effects,
    reversibility: "reversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 1,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (inputs) => {
      const targets = resolveTargets(pinned, inputs.relays, "nostr.fetch")
      const filters = inputs.filters ?? [{ kinds: [1] }]
      const wireFilters = filters.map((f) => toWireFilter(f, maxEvents))
      const relayResults = await Promise.all(
        targets.map((url) =>
          fetchFromRelay(url, wireFilters, { timeoutMs, maxEvents, redactions: [] }),
        ),
      )

      const events: z.infer<typeof FetchedEventSchema>[] = []
      let malformed = 0
      let truncated = false
      const relay_results = relayResults.map((rr) => {
        let relayValid = 0
        for (const raw of rr.events) {
          if (events.length >= maxEvents) {
            truncated = true
            break
          }
          const parsed = RawNostrEventSchema.safeParse(raw)
          if (!parsed.success) {
            malformed += 1
            continue
          }
          events.push({
            ...parsed.data,
            signature_valid: verifyEvent(parsed.data),
            relay: rr.relay,
          })
          relayValid += 1
        }
        return {
          relay: rr.relay,
          event_count: relayValid,
          eose: rr.eose,
          truncated: rr.truncated,
          message: rr.message,
        }
      })

      return {
        events,
        event_count: events.length,
        malformed_count: malformed,
        truncated,
        relay_results,
        summary: `fetched ${events.length} event(s) from ${targets.length} relay(s)${malformed > 0 ? `, dropped ${malformed} malformed` : ""}${truncated ? " (truncated)" : ""}`,
      }
    },
  }
}

// -----------------------------------------------------------------------------
// Config-driven factory (mirrors registerGitTransportTools)
// -----------------------------------------------------------------------------

export interface NostrToolsConfig {
  /** Enable nostr.publish. Requires pinned relays + an explicit credential. */
  publish?: {
    relays: string[]
    credential: NostrCredential
    allowedKinds?: number[]
    trust?: TrustLevel
  }
  /** Enable nostr.fetch. Requires pinned relays (the SSRF allowlist). */
  fetch?: { relays: string[]; maxEvents?: number; trust?: TrustLevel }
  /** Per-relay wall-clock timeout shared by both tools. Default 10s. */
  timeoutMs?: number
}

/** Build the configured subset of Nostr tools. */
export function defineNostrTools(config: NostrToolsConfig): Tool[] {
  const tools: Tool[] = []
  if (config.publish) {
    tools.push(makeNostrPublishTool({ ...config.publish, timeoutMs: config.timeoutMs }) as Tool)
  }
  if (config.fetch) {
    tools.push(makeNostrFetchTool({ ...config.fetch, timeoutMs: config.timeoutMs }) as Tool)
  }
  return tools
}

/** Build and register the configured subset of Nostr tools. Returns them. */
export function registerNostrTools(config: NostrToolsConfig): Tool[] {
  const tools = defineNostrTools(config)
  for (const tool of tools) registerTool(tool)
  return tools
}
