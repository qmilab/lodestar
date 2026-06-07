/**
 * Credential model for the messaging tools. The same rules as the git / Nostr /
 * HTTP adapters (ADR-0006/0007/0008), simplified to messaging's shape: a single
 * operator-supplied auth header injected on requests to ONE operator-fixed
 * provider endpoint (a Slack bot token, an email-API key). There is no host
 * binding to reason about — unlike the HTTP adapter, the agent never supplies the
 * destination host, so a credential cannot be steered to a different host (no
 * confused-deputy surface to defend).
 *
 *   - **No silent default.** The operator supplies the credential explicitly. The
 *     agent never sees, picks, or supplies one.
 *   - **Resolver seam.** `value` may be a `() => Promise<string>` so a production
 *     host fetches the secret from a store at request time rather than persisting
 *     it in config — the bridge to the Action Kernel's capability handles, exactly
 *     as the earlier egress adapters recorded.
 *   - **Redacted.** The resolved value is stripped from any captured output (the
 *     provider response body, status text, error text) before it can reach an
 *     observation or the event log.
 */

export type SecretValue = string | (() => string | Promise<string>)

export interface MessagingCredential {
  /** Header name to inject, e.g. "Authorization" or "X-Api-Key". */
  header: string
  /** Header value, e.g. "Bearer xoxb-…". A function is resolved per request. */
  value: SecretValue
}

/** A header resolved for one request. */
export interface ResolvedHeader {
  name: string
  value: string
}

export interface ResolvedCredential {
  headers: ResolvedHeader[]
  /** Literal secret strings to redact from any captured output. */
  redactions: string[]
}

/** Resolve the operator credential for one request (re-invoking a resolver
 * function each time; nothing is retained between calls), returning the header to
 * inject plus the redaction set. */
export async function resolveCredential(
  cred: MessagingCredential | undefined,
): Promise<ResolvedCredential> {
  if (!cred) return { headers: [], redactions: [] }
  const value = typeof cred.value === "function" ? await cred.value() : cred.value
  return { headers: [{ name: cred.header, value }], redactions: redactionVariants(value) }
}

/** The redaction strings to scrub for one secret: the raw value AND its
 * URL-encoded forms. A hostile or misbehaving provider can echo a credential into
 * its JSON response (e.g. a debug field); redacting only the raw value would miss
 * an encoded copy. (Mirrors the HTTP adapter's `redactionVariants`.) */
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
 * provider can echo arbitrary text and a credential must never slip into an
 * observation or the log. */
export function applyRedactions(text: string, redactions: string[]): string {
  let out = text
  for (const secret of redactions) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}
