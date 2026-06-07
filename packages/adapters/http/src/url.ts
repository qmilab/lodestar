/**
 * The URL guard: scheme allowlist + operator-pinned host allowlist. This is the
 * HTTP analogue of the git adapter's remote pinning and the Nostr adapter's
 * relay pinning (`resolveTargets`) — the chokepoint that stops the agent from
 * pointing the adapter at an arbitrary destination (an SSRF / exfiltration
 * guard).
 *
 * It is checked at TWO points: the initial agent-supplied URL, AND every
 * redirect `Location` the client is asked to follow (`client.ts`). A pinned host
 * that 302s to a non-pinned host is the classic HTTP SSRF/exfil vector that
 * relay/remote pinning alone does not cover, so re-validating each hop is the
 * teeth this adapter adds over the earlier egress slices.
 *
 * Same honesty boundary as ADR-0004/0006/0007: this is a **TS-level governance
 * boundary, not network containment**. It does not resolve DNS and block private
 * address ranges (that would be a network sandbox we do not claim); the pinned
 * host allowlist is the destination control, exactly as Nostr pins relay URLs.
 */

export interface UrlPolicy {
  /** Operator-pinned hostnames (lowercased, port/scheme stripped). Exact match. */
  allowedHosts: string[]
  /** Allowed URL protocols, each including the trailing colon (e.g. "https:"). */
  allowedSchemes: string[]
}

/** Normalize an allowlist entry to a bare lowercase hostname. Accepts a bare
 * host (`example.com`), a host:port (`example.com:8443`), or a full URL
 * (`https://example.com/x`) and reduces each to its hostname, so the allowlist
 * matches `URL.hostname` (which never carries a port or path). */
export function normalizeHost(entry: string): string {
  const v = entry.trim().toLowerCase()
  const withScheme = v.includes("://") ? v : `https://${v}`
  try {
    return new URL(withScheme).hostname
  } catch {
    return v
  }
}

/** Compile an operator host/scheme policy. HTTPS only unless `allowHttp` is set
 * explicitly — no silent insecure default. */
export function compileUrlPolicy(opts: { allowedHosts: string[]; allowHttp?: boolean }): UrlPolicy {
  const allowedHosts = [
    ...new Set(opts.allowedHosts.map(normalizeHost).filter((h) => h.length > 0)),
  ]
  const allowedSchemes = opts.allowHttp ? ["https:", "http:"] : ["https:"]
  return { allowedHosts, allowedSchemes }
}

/**
 * Parse and validate a URL against the policy. Throws on any violation — a
 * malformed/relative URL, a disallowed scheme, or a non-pinned host. Returns the
 * parsed `URL` on success. Used for the initial target AND each redirect hop.
 */
export function assertAllowedUrl(raw: string, policy: UrlPolicy, tool: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${tool}: '${raw}' is not a valid absolute URL`)
  }
  if (!policy.allowedSchemes.includes(url.protocol)) {
    throw new Error(
      `${tool}: scheme '${url.protocol}' is not allowed (allowed: ${policy.allowedSchemes.join(", ")})`,
    )
  }
  const host = url.hostname.toLowerCase()
  if (!policy.allowedHosts.includes(host)) {
    throw new Error(
      `${tool}: host '${host}' is not in the operator-allowed hosts (${policy.allowedHosts.join(", ") || "none"})`,
    )
  }
  return url
}
