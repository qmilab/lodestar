import { normalizeHost } from "./url.js"

/**
 * Credential model for the HTTP tools. The same rules as the git and Nostr
 * adapters (ADR-0006/0007), adapted to HTTP's credential shape — a header (an
 * API key, a `Bearer` token, a Basic auth string) injected on requests to a
 * specific pinned host:
 *
 *   - **No silent default.** The operator supplies credentials explicitly and
 *     binds each to a host. The agent never sees, picks, or supplies one.
 *   - **Host-scoped.** A credential is injected ONLY on requests to its bound
 *     host, and re-resolved per redirect hop — so host A's token is never sent to
 *     host B, even across an allowlisted redirect. The agent cannot redirect a
 *     credential to another destination.
 *   - **Resolver seam.** `value` may be a `() => Promise<string>` so a production
 *     host fetches the secret from a store at request time rather than persisting
 *     it in config. This is the bridge to the Action Kernel's capability handles
 *     once kernel capability resolution lands (the forward direction ADR-0006/0007
 *     recorded for git/nostr).
 *   - **Redacted.** The resolved value is stripped from any captured output
 *     (response body / headers / error text) before it can reach an observation
 *     or the event log.
 */
export interface HttpCredential {
  /** The pinned host this credential is bound to (matched against `URL.hostname`). */
  host: string
  /** Header name to inject, e.g. "Authorization" or "X-Api-Key". */
  header: string
  /** Header value. A function is resolved per request (fetch at use time). */
  value: string | (() => string | Promise<string>)
}

/** A header resolved for one request: the name to set and its value. */
export interface ResolvedHeader {
  name: string
  value: string
}

export interface PreparedCredentials {
  /** Header names bound to a host — used to stop the agent from shadowing an
   * injected credential header on that host. Lowercased. */
  reservedHeaderNames(host: string): string[]
  /** Resolve the credential header(s) to inject for a target host, plus the
   * literal secret strings to redact from captured output. Re-invokes any
   * resolver function; nothing is retained between calls. */
  resolveFor(host: string): Promise<{ headers: ResolvedHeader[]; redactions: string[] }>
}

/** Index the operator's credentials by normalized host and expose host-scoped
 * resolution. The raw credential values are never retained — only the config
 * reference is closed over, and the value (or its resolver) is read inside
 * `resolveFor`. */
export function prepareCredentials(creds: HttpCredential[]): PreparedCredentials {
  const byHost = new Map<string, HttpCredential[]>()
  for (const cred of creds) {
    const host = normalizeHost(cred.host)
    const list = byHost.get(host) ?? []
    list.push(cred)
    byHost.set(host, list)
  }
  return {
    reservedHeaderNames(host: string): string[] {
      return (byHost.get(host.toLowerCase()) ?? []).map((c) => c.header.toLowerCase())
    },
    resolveFor: async (host: string) => {
      const list = byHost.get(host.toLowerCase()) ?? []
      const headers: ResolvedHeader[] = []
      const redactions = new Set<string>()
      for (const cred of list) {
        const value = typeof cred.value === "function" ? await cred.value() : cred.value
        headers.push({ name: cred.header, value })
        for (const v of redactionVariants(value)) redactions.add(v)
      }
      return { headers, redactions: [...redactions] }
    },
  }
}

/** The redaction strings to scrub for one secret: the raw value AND its
 * URL-encoded forms. A hostile server can echo a credential into a redirect
 * `Location`, where the URL serialization percent-encodes it (e.g. a space in
 * `Bearer abc` becomes `Bearer%20abc`); redacting only the raw value would miss
 * the encoded copy in the captured URL / redirect chain. */
export function redactionVariants(secret: string): string[] {
  if (secret.length === 0) return []
  const variants = new Set<string>([secret])
  try {
    variants.add(encodeURIComponent(secret))
  } catch {
    /* lone surrogate etc. — the encoder threw; the raw form still redacts */
  }
  try {
    variants.add(encodeURI(secret))
  } catch {
    /* as above */
  }
  return [...variants]
}

/** Replace every occurrence of each non-empty redaction with `***`. Defence in
 * depth: the secret should not appear in a response, but a misbehaving or hostile
 * server can echo arbitrary text and a credential must never slip into an
 * observation or the log. (Mirrors the Nostr adapter's `applyRedactions`.) */
export function applyRedactions(text: string, redactions: string[]): string {
  let out = text
  for (const secret of redactions) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}
