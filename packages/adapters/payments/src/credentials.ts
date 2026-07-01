/**
 * Credential model for the payment tool. The same rules as the messaging / HTTP /
 * git / Nostr adapters (ADR-0006/0007/0008/0009), in payments' shape: a single
 * operator-supplied auth header injected on requests to ONE operator-fixed payment
 * provider endpoint (a Stripe secret key, a PSP API token). There is no host
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
 *
 * This is the messaging adapter's `credentials.ts` ported verbatim (only the type
 * name changes): the same audited redaction code, shared by every egress family.
 */

export type SecretValue = string | (() => string | Promise<string>)

export interface PaymentCredential {
  /** Header name to inject, e.g. "Authorization" or "X-Api-Key". */
  header: string
  /** Header value, e.g. "Bearer sk_live_…". A function is resolved per request. */
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
  cred: PaymentCredential | undefined,
): Promise<ResolvedCredential> {
  if (!cred) return { headers: [], redactions: [] }
  let value: string
  try {
    value = typeof cred.value === "function" ? await cred.value() : cred.value
  } catch {
    // The resolver threw. Its error may embed secret material we never obtained
    // (so cannot add to the redaction set), e.g. a vault client that echoes the
    // attempted value. Do NOT propagate the resolver's message — it would reach
    // the kernel's failed-action audit unredacted. Fail with a generic message.
    throw new Error("credential resolution failed")
  }
  return { headers: [{ name: cred.header, value }], redactions: redactionVariants(value) }
}

/** Lowercase only the `%XX` percent-escapes in a string, leaving the rest intact.
 * `encodeURIComponent` emits UPPERCASE hex (`%2F`); a provider that re-encodes a
 * credential it echoes may emit lowercase (`%2f`), which an exact-match redaction
 * of the uppercase form would miss. */
function lowercasePercentEscapes(s: string): string {
  return s.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toLowerCase())
}

/** The redaction strings to scrub for one secret. A hostile or misbehaving
 * provider can echo a credential into its JSON response (e.g. a debug field) or an
 * error string; we must catch every form it could surface in:
 *
 *   - the raw value AND the bare token after a scheme prefix (a provider can echo
 *     just `sk_live_…`, not the whole `Bearer sk_live_…` header value), and
 *   - the URL-encoded forms of each (with lowercase percent-escapes too).
 *
 * Redacting only the full header value would miss a bare-token or re-encoded echo. */
export function redactionVariants(secret: string): string[] {
  if (secret.length === 0) return []
  // Base strings to redact: the whole value, plus the token after a scheme prefix
  // (`Bearer <token>` / `Basic <b64>`). The segment guard (≥ 6 chars) avoids
  // redacting a short scheme word; real tokens are long.
  const bases = new Set<string>([secret])
  // The token after a scheme prefix is EVERYTHING after the first whitespace run
  // (`Bearer <token>` / `Basic <b64>`) — redact the whole token even if it itself
  // contains spaces, not just its last segment. The ≥ 6-char guard avoids
  // redacting a tiny fragment; real tokens are long.
  const afterScheme = secret.trim().match(/^\S+\s+(\S.*)$/)
  const token = afterScheme?.[1]
  if (token !== undefined && token.length >= 6) bases.add(token)
  const variants = new Set<string>()
  for (const base of bases) {
    variants.add(base)
    for (const enc of encodedForms(base)) {
      variants.add(enc)
      variants.add(lowercasePercentEscapes(enc))
    }
    // JSON `\uXXXX`-escaped forms (lower- and upper-case hex). The transport
    // (`readCappedBody`) normalises a captured body before redacting — canonicalising
    // complete JSON, or full-escape-decoding a non-parseable body — so an escaped echo
    // is collapsed to literal there; these variants serve two remaining purposes: they
    // size the read overlap so a *fully*-escaped secret straddling the byte cap is
    // captured before that step (the `\uXXXX` form is the longest, 6× per char), and
    // they backstop non-body surfaces (status text / error strings), which are not
    // normalised.
    variants.add(jsonUnicodeEscape(base, false))
    variants.add(jsonUnicodeEscape(base, true))
    // JSON *string* escaping (`"` → \", `\` → \\, control chars → \n / \uXXXX). The form
    // a credential with JSON-special characters takes inside a JSON string — including
    // after the transport canonicalises a complete JSON body with `JSON.stringify`,
    // which RE-escapes `"`/`\`. Load-bearing for the canonicalise path; a no-op for a
    // token with no special chars.
    variants.add(jsonStringEscape(base))
  }
  return [...variants]
}

/** The JSON `\uXXXX` escape of every UTF-16 code unit of `s` (the form a hostile
 * provider uses to hide a credential from a raw-string redaction). */
function jsonUnicodeEscape(s: string, upperHex: boolean): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const hex = s.charCodeAt(i).toString(16).padStart(4, "0")
    out += `\\u${upperHex ? hex.toUpperCase() : hex}`
  }
  return out
}

/** The inner (quote-stripped) JSON string escaping of `s` — what a value looks like
 * inside a JSON string after `JSON.stringify` (`"` → \", `\` → \\, control chars). */
function jsonStringEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/** URL-encoded forms of a value (component- and URI-encoded), skipping any that
 * throw (e.g. a lone surrogate) — the raw form still redacts in that case. */
function encodedForms(value: string): string[] {
  const out: string[] = []
  try {
    out.push(encodeURIComponent(value))
  } catch {
    /* encoder threw; skip */
  }
  try {
    out.push(encodeURI(value))
  } catch {
    /* encoder threw; skip */
  }
  return out
}

/** Replace every occurrence of each non-empty redaction with `***`. Defence in
 * depth: the secret should not appear in a response, but a misbehaving or hostile
 * provider can echo arbitrary text and a credential must never slip into an
 * observation or the log.
 *
 * Redactions are applied LONGEST-FIRST: if a shorter secret is a substring of a
 * longer one (e.g. the bare token is a substring of the full `Bearer <token>`
 * header, or two related tokens), replacing the short one first would consume part
 * of the longer match and could leave its unique remainder in the output. Matching
 * the longest secret first closes that gap. */
export function applyRedactions(text: string, redactions: string[]): string {
  let out = text
  for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}
