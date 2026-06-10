/**
 * Secret redaction for the SQL adapter — the same defence-in-depth rule as the
 * git / Nostr / HTTP / messaging adapters (ADR-0006/0007/0008/0009), specialised
 * to a database credential.
 *
 * The credential here is the password embedded in the operator's connection
 * string (e.g. the `secret` in `postgres://user:secret@host/db`). The agent never
 * supplies, sees, or names it. But a connection or driver error can echo the
 * connection string — and therefore the password — into its message, and that
 * message would otherwise reach the kernel's failed-action audit and the event
 * log. So before any caught error text leaves the adapter it is scrubbed of every
 * form the password could surface in.
 */

/** Lowercase only the `%XX` percent-escapes in a string, leaving the rest intact.
 * `encodeURIComponent` emits UPPERCASE hex (`%2F`); a driver that re-encodes a
 * connection string it echoes may emit lowercase (`%2f`), which an exact-match
 * redaction of the uppercase form would miss. */
function lowercasePercentEscapes(s: string): string {
  return s.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toLowerCase())
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

/** The redaction strings to scrub for one secret: the raw value plus its
 * URL-encoded forms (uppercase and lowercase percent-escapes). A password is
 * commonly percent-encoded inside a connection string, and a driver that echoes
 * the string back may emit either escape case. */
export function redactionVariants(secret: string): string[] {
  if (secret.length === 0) return []
  const variants = new Set<string>([secret])
  for (const enc of encodedForms(secret)) {
    variants.add(enc)
    variants.add(lowercasePercentEscapes(enc))
  }
  return [...variants]
}

/** Replace every occurrence of each non-empty redaction with `***`. Defence in
 * depth: the password should never appear in a driver error, but a misbehaving
 * driver can echo arbitrary text and a credential must never slip into an
 * observation or the log.
 *
 * Redactions are applied LONGEST-FIRST: if a shorter secret is a substring of a
 * longer one, replacing the short one first would consume part of the longer
 * match and could leave its unique remainder in the output. */
export function applyRedactions(text: string, redactions: string[]): string {
  let out = text
  for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}

/**
 * Extract the redaction set for a connection string: the password component and
 * its encoded variants. Parses with the WHATWG `URL`; a DSN that does not parse
 * as a URL (e.g. a libpq key=value string) yields no redactions — the operator
 * can pass explicit `redactions` for that shape instead.
 */
export function connectionRedactions(connectionString: string): string[] {
  let password = ""
  try {
    // `URL` does not understand the `postgres://`/`postgresql://` scheme as
    // special, but it still parses the userinfo, so `.password` is populated.
    password = new URL(connectionString).password
  } catch {
    return []
  }
  if (password === "") return []
  // The connection string stores the password percent-encoded; redact both the
  // decoded value (what the driver actually authenticates with) and the raw
  // encoded form as it appears in the string.
  let decoded = password
  try {
    decoded = decodeURIComponent(password)
  } catch {
    /* not valid percent-encoding; the raw form still redacts */
  }
  return [...new Set([...redactionVariants(decoded), ...redactionVariants(password)])]
}
