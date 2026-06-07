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
 * Credentials are re-resolved per hop and bound to the target host, so a token is
 * never carried to a different host across a redirect.
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

/** Read a response body into text, bounded by `maxBytes`. Streams and stops once
 * the cap is exceeded, cancelling the rest — so an oversized body is never fully
 * buffered. */
async function readCappedBody(
  resp: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!resp.body) return { text: "", bytes: 0, truncated: false }
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let captured = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const room = maxBytes - captured
    if (value.byteLength > room) {
      if (room > 0) {
        chunks.push(value.subarray(0, room))
        captured += room
      }
      truncated = true
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
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { text: buf.toString("utf8"), bytes: buf.byteLength, truncated }
}

/** Snapshot response headers into a plain record, redacting values. */
function captureHeaders(resp: Response, redactions: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  resp.headers.forEach((value, key) => {
    out[key] = applyRedactions(value, redactions)
  })
  return out
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
    for (;;) {
      // Re-resolve the operator credential for THIS host (never carry host A's
      // token to host B), and accumulate its redactions.
      const cred = await opts.credentials.resolveFor(url.hostname)
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
        // 307/308 preserve method + body; 301/302/303 degrade to GET with no body
        // (matching browser behaviour for an unsafe method).
        if (resp.status !== 307 && resp.status !== 308) {
          method = "GET"
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

      const capped = await readCappedBody(resp, opts.maxBytes)
      return {
        url: url.toString(),
        status: resp.status,
        status_text: resp.statusText,
        ok: resp.ok,
        headers: captureHeaders(resp, [...redactions]),
        content_type: resp.headers.get("content-type"),
        body: applyRedactions(capped.text, [...redactions]),
        body_bytes: capped.bytes,
        body_truncated: capped.truncated,
        redirected: hops > 0,
        redirect_chain: redirectChain,
        // `cred` is this (final) hop's resolution — reuse it rather than
        // resolving again (which would re-invoke a credential resolver function).
        authenticated: cred.headers.length > 0,
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
