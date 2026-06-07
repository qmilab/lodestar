/**
 * Destination allowlists — the messaging-specific exfil guard. This is the
 * messaging analogue of the HTTP adapter's host pinning, the git adapter's remote
 * pinning, and the Nostr adapter's relay pinning: the chokepoint that stops the
 * agent from steering a send to an arbitrary recipient.
 *
 * The difference from the earlier egress slices: for HTTP the *host* was the
 * exfil vector and the agent supplied it. For messaging the provider endpoint is
 * operator-fixed (the agent never names the host — see `tools.ts`), so the only
 * destination the agent controls is the *recipient* — a Slack channel or an email
 * address. That is the thing the operator pins here.
 *
 * Two shapes, one purpose:
 *
 *   - **Channel allowlist** (Slack): the agent may post only to operator-pinned
 *     channels. Matching is format-insensitive (`#general`/`general`, case), and a
 *     matched send is delivered to the operator's *canonical* channel string — the
 *     agent cannot smuggle a different channel past the pin via a format trick.
 *   - **Recipient allowlist** (email): the operator pins exact addresses
 *     (`ops@co.com`) and/or whole domains (`@co.com` or `co.com`); every recipient
 *     of a send must match one. The agent cannot email `attacker@evil.com`.
 *
 * Same honesty boundary as ADR-0004/0006/0007/0008: a TS-level governance
 * boundary, not network containment.
 */

// -----------------------------------------------------------------------------
// Slack channel allowlist
// -----------------------------------------------------------------------------

export interface ChannelPolicy {
  /** normalized-channel → operator's canonical channel string (what we send). */
  byNormalized: Map<string, string>
}

/** Normalize a channel for matching: trim, lowercase, strip a single leading `#`.
 * Slack channel IDs are case-sensitive uppercase and names lowercase; normalizing
 * both the allowlist and the agent input the same way lets `#General`, `general`,
 * and `GENERAL` all match a pin written either way — while the *sent* value is
 * always the operator's canonical form. */
export function normalizeChannel(entry: string): string {
  const v = entry.trim().toLowerCase()
  return v.startsWith("#") ? v.slice(1) : v
}

export function compileChannelPolicy(channels: string[]): ChannelPolicy {
  const byNormalized = new Map<string, string>()
  for (const raw of channels) {
    const canonical = raw.trim()
    if (canonical.length === 0) continue
    const key = normalizeChannel(canonical)
    if (key.length === 0) continue
    // First pin for a normalized key wins; a duplicate is ignored.
    if (!byNormalized.has(key)) byNormalized.set(key, canonical)
  }
  return { byNormalized }
}

/** Validate the agent's channel against the pin. Throws on a non-pinned channel.
 * Returns the operator's canonical channel string to actually send to. */
export function assertAllowedChannel(channel: string, policy: ChannelPolicy, tool: string): string {
  const canonical = policy.byNormalized.get(normalizeChannel(channel))
  if (canonical === undefined) {
    const pinned = [...policy.byNormalized.values()].join(", ") || "none"
    throw new Error(
      `${tool}: channel '${channel}' is not in the operator-allowed channels (${pinned})`,
    )
  }
  return canonical
}

// -----------------------------------------------------------------------------
// Email recipient allowlist
// -----------------------------------------------------------------------------

export interface RecipientPolicy {
  /** Lowercased exact addresses (`ops@co.com`). */
  allowedAddresses: Set<string>
  /** Lowercased bare domains (`co.com`) — any address under one is allowed. */
  allowedDomains: Set<string>
}

/** Compile an email recipient allowlist. Entry forms:
 *   - `ops@co.com`  → exact address
 *   - `@co.com`     → domain (anything @co.com)
 *   - `co.com`      → domain (bare, no local part) */
export function compileRecipientPolicy(entries: string[]): RecipientPolicy {
  const allowedAddresses = new Set<string>()
  const allowedDomains = new Set<string>()
  for (const raw of entries) {
    const e = raw.trim().toLowerCase()
    if (e.length === 0) continue
    if (e.startsWith("@")) {
      const d = e.slice(1)
      if (d.length > 0) allowedDomains.add(d)
    } else if (e.includes("@")) {
      allowedAddresses.add(e)
    } else {
      allowedDomains.add(e)
    }
  }
  return { allowedAddresses, allowedDomains }
}

/** The domain part of an address (after the last `@`), lowercased, or null. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@")
  if (at <= 0 || at === address.length - 1) return null
  return address.slice(at + 1)
}

/** Validate that EVERY recipient is allowlisted (exact address or allowed
 * domain). Throws on the first that is not — a single non-pinned recipient fails
 * the whole send, so the agent cannot append `attacker@evil.com` to a legitimate
 * recipient list. Returns the trimmed recipients to send to. */
export function assertAllowedRecipients(
  recipients: string[],
  policy: RecipientPolicy,
  tool: string,
): string[] {
  if (recipients.length === 0) {
    throw new Error(`${tool}: no recipients supplied`)
  }
  const out: string[] = []
  for (const raw of recipients) {
    const addr = raw.trim()
    const lower = addr.toLowerCase()
    const domain = domainOf(lower)
    if (domain === null) {
      throw new Error(`${tool}: '${addr}' is not a valid email address`)
    }
    const ok = policy.allowedAddresses.has(lower) || policy.allowedDomains.has(domain)
    if (!ok) {
      throw new Error(
        `${tool}: recipient '${addr}' is not operator-allowed (no matching address or domain)`,
      )
    }
    out.push(addr)
  }
  return out
}
