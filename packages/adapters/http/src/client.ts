import { type PreparedCredentials, type ResolvedHeader, applyRedactions } from "./credentials.js"
import { type UrlPolicy, assertAllowedUrl } from "./url.js"

/**
 * The HTTP transport: a thin, hand-rolled wrapper over the runtime's standard
 * `fetch` for the two governed operations. The Nostr adapter's `relay.ts`
 * sibling — same posture: a bounded wall-clock timeout, bounded response
 * capture, and secret redaction from everything surfaced — but the egress is an
 * HTTP request, not a relay WebSocket.
 *
 * The HTTP-specific teeth live here: **redirects are followed manually and every
 * hop's host is re-validated** against the operator pin (`assertAllowedUrl`). A
 * pinned host that 3xx-redirects to a non-pinned host is the classic SSRF/exfil
 * escape that destination pinning alone misses; here it stops the request.
 * Credentials are bound to the host the agent originally targeted, so a cross-host
 * redirect carries no token — a server cannot steer the credential elsewhere.
 *
 * Same honesty boundary as ADR-0004/0006/0007: a **TS-level governance boundary,
 * not network containment**. `fetch`/`request` reach the real host by design.
 */

export const DEFAULT_TIMEOUT_MS = 15_000
/** Cap on the captured response body. An untrusted (possibly hostile) server must
 * not be able to inflate an observation or exhaust memory with a huge body. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
export const DEFAULT_MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Methods that may carry a request body. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export interface HttpResponseCapture {
  /** Final URL after any followed (re-validated) redirects. */
  url: string
  status: number
  status_text: string
  ok: boolean
  /** Response headers, values redacted. */
  headers: Record<string, string>
  content_type: string | null
  /** Response body as text, capped at `maxBytes`, redacted. UNTRUSTED content. */
  body: string
  /** Captured body length in bytes (≤ maxBytes). */
  body_bytes: number
  /** True if the body was longer than the cap and was cut off. */
  body_truncated: boolean
  redirected: boolean
  /** Every URL in the followed chain, starting with the initial target. */
  redirect_chain: string[]
  /** True if an operator credential header was injected on the final request. */
  authenticated: boolean
}

export interface PerformRequestOptions {
  method: string
  /** Agent-supplied request headers (already filtered for reserved/credential names). */
  headers: ResolvedHeader[]
  /** Request body (only sent for body-bearing methods). */
  body?: string
  policy: UrlPolicy
  credentials: PreparedCredentials
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
  /** Tool name for error messages. */
  tool: string
}

/** Read a response body into REDACTED text, bounded by `maxBytes`. Streams and
 * stops once the cap (plus a redaction overlap) is exceeded, cancelling the rest —
 * so an oversized body is never fully buffered.
 *
 * The cap is applied AFTER redaction, not before. If we truncated the raw bytes at
 * `maxBytes` first, a credential a hostile server echoes straddling that boundary
 * would be cut mid-secret, leaving an unredacted credential *prefix* that no full
 * redaction variant matches. So we read a small overlap beyond the cap — the
 * longest redaction string — which guarantees any secret with at least one byte
 * inside `[0, maxBytes)` is FULLY present in the window, redact the whole window,
 * then bound the redacted text to the cap. Slicing the already-redacted text can
 * only drop trailing content; it can never reveal a partial secret. */
async function readCappedBody(
  resp: Response,
  maxBytes: number,
  redactions: string[],
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!resp.body) return { text: "", bytes: 0, truncated: false }
  // Overlap = the longest redaction string, so a secret straddling the cap is
  // fully captured for matching before we bound the output.
  const overlap = redactions.reduce((m, r) => Math.max(m, r.length), 0)
  const readLimit = maxBytes + overlap
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let captured = 0
  // Set when we stop early because the stream had more than the read window —
  // load-bearing when overlap is 0 (no credentials), where `captured` maxes at
  // exactly `maxBytes` and `captured > maxBytes` could never fire.
  let hitLimit = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const room = readLimit - captured
    if (value.byteLength > room) {
      if (room > 0) {
        chunks.push(value.subarray(0, room))
        captured += room
      }
      hitLimit = true
      try {
        await reader.cancel()
      } catch {
        /* stream already closing */
      }
      break
    }
    chunks.push(value)
    captured += value.byteLength
  }
  // truncated = the body had more than the cap of real content (either we stopped
  // early at the read window, or we read into the overlap beyond `maxBytes`).
  const truncated = hitLimit || captured > maxBytes
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  // Redact the FULL window (incl. the overlap) FIRST, so a boundary-straddling
  // secret becomes `***`, THEN bound the redacted text to the cap.
  const redacted = applyRedactions(buf.toString("utf8"), redactions)
  const text = truncated ? redacted.slice(0, maxBytes) : redacted
  return { text, bytes: Math.min(captured, maxBytes), truncated }
}

/** Snapshot response headers into a plain record, redacting values. */
function captureHeaders(resp: Response, redactions: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  resp.headers.forEach((value, key) => {
    out[key] = applyRedactions(value, redactions)
  })
  return out
}

/** Settle with `promise`, but reject as soon as `signal` aborts. Brings an async
 * step that does NOT take an AbortSignal (the credential resolver) under the same
 * wall-clock deadline as the fetch — the AbortController is shared — so a hung
 * secret-store lookup cannot outlast `timeoutMs`. The original promise's eventual
 * settlement is still consumed, so a late rejection is never unhandled. */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onTimeout: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(onTimeout())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(onTimeout())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Issue one request, following redirects manually and re-validating every hop's
 * host against the operator pin. Resolves to a captured response for ANY HTTP
 * status (a 4xx/5xx is a real, captured response). Throws on a hard failure: a
 * timeout, a connection/DNS error, or a redirect to a non-pinned host (the SSRF
 * block) — so the action ends `failed`.
 */
export async function performRequest(
  initialUrl: URL,
  opts: PerformRequestOptions,
): Promise<HttpResponseCapture> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const redactions = new Set<string>()
  const redirectChain: string[] = [initialUrl.toString()]
  try {
    let url = initialUrl
    let method = opts.method.toUpperCase()
    let body = opts.body
    let hops = 0
    // The host the agent/operator explicitly targeted. Credentials are bound to
    // it: a server chooses where it redirects, so a cross-host redirect (even to
    // another pinned host) must NOT carry that host's credential — otherwise one
    // host could weaponise another's operator token (a confused-deputy).
    const originalHost = initialUrl.hostname.toLowerCase()
    for (;;) {
      // Inject the operator credential ONLY while we are still on the original
      // host. It is re-resolved per hop there (fresh secret each request); its
      // redactions persist across the whole chain so a later echo stays redacted.
      const onOriginalHost = url.hostname.toLowerCase() === originalHost
      // Race the (possibly async) credential resolution against the shared
      // deadline so a hung resolver can't outlast the advertised wall-clock cap.
      const cred = onOriginalHost
        ? await raceAbort(
            opts.credentials.resolveFor(url.hostname),
            controller.signal,
            () => new Error(`${opts.tool}: request timed out after ${opts.timeoutMs}ms`),
          )
        : { headers: [] as ResolvedHeader[], redactions: [] as string[] }
      for (const r of cred.redactions) redactions.add(r)

      const headers = new Headers()
      for (const h of opts.headers) headers.set(h.name, h.value)
      // Operator credential headers win over any agent-supplied header.
      for (const h of cred.headers) headers.set(h.name, h.value)

      const sendBody = BODY_METHODS.has(method) ? body : undefined
      let resp: Response
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: sendBody,
          redirect: "manual",
          signal: controller.signal,
        })
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`${opts.tool}: request timed out after ${opts.timeoutMs}ms`)
        }
        const msg = applyRedactions(String(err), [...redactions])
        throw new Error(`${opts.tool}: request to '${url.hostname}' failed: ${msg}`)
      }

      const location = resp.headers.get("location")
      if (REDIRECT_STATUSES.has(resp.status) && location) {
        if (hops >= opts.maxRedirects) {
          throw new Error(
            `${opts.tool}: exceeded the redirect limit (${opts.maxRedirects}) at '${url.hostname}'`,
          )
        }
        // Resolve the Location against the current URL, then re-validate the host
        // against the operator pin — the per-hop SSRF/exfil guard. A non-pinned
        // redirect target throws here and the request never reaches it.
        const next = assertAllowedUrl(new URL(location, url).toString(), opts.policy, opts.tool)
        // 307/308 preserve method + body. 301/302/303 drop the body and degrade
        // an UNSAFE method to GET (browser behaviour) — but a safe method keeps
        // its verb: a HEAD must stay HEAD, so a metadata-only request does not
        // start downloading the body across a redirect.
        if (resp.status !== 307 && resp.status !== 308) {
          if (method !== "GET" && method !== "HEAD") method = "GET"
          body = undefined
        }
        try {
          await resp.body?.cancel()
        } catch {
          /* nothing to drain */
        }
        url = next
        hops += 1
        redirectChain.push(url.toString())
        continue
      }

      // Redact EVERY captured field, not just the body/headers: a credentialed
      // host can echo the injected token into a redirect `Location` (e.g.
      // `/next?token=<cred>`) or a `content-type`, so the final URL and the whole
      // redirect chain must be redacted too before they reach an observation.
      const red = [...redactions]
      // readCappedBody redacts BEFORE applying the cap (so a credential straddling
      // the byte boundary can't leave an unredacted prefix), so `capped.text` is
      // already redacted — do not (and need not) redact it again here.
      const capped = await readCappedBody(resp, opts.maxBytes, red)
      const contentType = resp.headers.get("content-type")
      return {
        url: applyRedactions(url.toString(), red),
        status: resp.status,
        // A custom HTTP reason phrase is server-controlled and can echo the
        // credential too, so redact it (it also flows into `summary`).
        status_text: applyRedactions(resp.statusText, red),
        ok: resp.ok,
        headers: captureHeaders(resp, red),
        content_type: contentType === null ? null : applyRedactions(contentType, red),
        body: capped.text,
        body_bytes: capped.bytes,
        body_truncated: capped.truncated,
        redirected: hops > 0,
        redirect_chain: redirectChain.map((u) => applyRedactions(u, red)),
        // `cred` is this (final) hop's resolution — reuse it rather than
        // resolving again (which would re-invoke a credential resolver function).
        authenticated: cred.headers.length > 0,
      }
    }
  } catch (err) {
    // Redaction backstop. Some failures throw the raw offending string before
    // any per-field redaction runs — a malformed redirect `Location`
    // (`new URL(...)`) or an invalid credential header value (`Headers.set`),
    // both of which Bun embeds verbatim in the error. The kernel records a
    // thrown message in the failed-action audit, so a hostile server (or a
    // newline-terminated secret) must not be able to smuggle the token there.
    // `redactions` already holds the resolved credential(s) by the time any such
    // throw can occur, so scrub the message before it escapes.
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(applyRedactions(message, [...redactions]))
  } finally {
    clearTimeout(timer)
  }
}
