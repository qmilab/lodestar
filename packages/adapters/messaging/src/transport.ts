import {
  type MessagingCredential,
  type ResolvedHeader,
  applyRedactions,
  resolveCredential,
} from "./credentials.js"

/**
 * The messaging transport: a thin, hand-rolled wrapper over the runtime's `fetch`
 * for one JSON POST to an operator-fixed provider endpoint. The HTTP adapter's
 * `client.ts` sibling — same posture (bounded wall-clock timeout, bounded
 * response capture, secret redaction from everything surfaced) — but
 * deliberately *simpler* in the one place that matters:
 *
 *   **Redirects are NOT followed.** The HTTP adapter follows redirects with
 *   per-hop re-validation because a fetch may legitimately redirect. A messaging
 *   provider's API endpoint does not: a 3xx on a `chat.postMessage` / send-email
 *   POST is anomalous, and *following* one would be exactly the SSRF/exfil escape
 *   the HTTP adapter works hard to bound. So a redirect is a hard failure here,
 *   not something to chase. The destination stays exactly the operator-fixed
 *   endpoint.
 *
 * Same honesty boundary as ADR-0004/0006/0007/0008: a TS-level governance
 * boundary, not network containment. The POST reaches the real provider by design.
 */

export const DEFAULT_TIMEOUT_MS = 15_000
/** Cap on the captured provider response. A send confirmation is small; an
 * untrusted (or hostile) provider must not be able to inflate an observation. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 // 64 KiB

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface SendResult {
  status: number
  status_text: string
  /** 2xx. */
  ok: boolean
  /** Provider response body, redacted, capped at `maxBytes`. UNTRUSTED. */
  body: string
  body_bytes: number
  body_truncated: boolean
  /** Whether an operator credential header was injected on the request. */
  authenticated: boolean
}

export interface PostJsonOptions {
  /** Operator-fixed provider endpoint — NOT agent-supplied. */
  url: URL
  /** JSON request body (already serialized). */
  body: string
  /** Operator credential (resolved per request, redacted from output). */
  credential?: MessagingCredential
  /** Extra non-secret headers (e.g. Content-Type). */
  extraHeaders?: ResolvedHeader[]
  timeoutMs: number
  maxBytes: number
  /** Tool name for error messages. */
  tool: string
}

/** Read a response body into text, bounded by `maxBytes`. Streams and stops once
 * the cap is exceeded, cancelling the rest — so an oversized body is never fully
 * buffered. (Mirrors the HTTP adapter's `readCappedBody`.) */
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

/** Settle with `promise`, but reject as soon as `signal` aborts. Brings an async
 * step that does NOT take an AbortSignal (the credential resolver) under the same
 * wall-clock deadline as the fetch — so a hung secret-store lookup cannot outlast
 * `timeoutMs`. (Mirrors the HTTP adapter's `raceAbort`.) */
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
 * POST a JSON body to the operator-fixed provider endpoint. Resolves to a captured
 * response for ANY HTTP status (a 4xx/5xx is a real, captured response the tool
 * layer interprets). Throws on a hard failure: a timeout, a connection error, or a
 * redirect (which is NOT followed) — so the action ends `failed`.
 */
export async function postJson(opts: PostJsonOptions): Promise<SendResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const redactions = new Set<string>()
  try {
    // Race the (possibly async) credential resolution against the shared deadline
    // so a hung resolver can't outlast the advertised wall-clock cap.
    const cred = await raceAbort(
      resolveCredential(opts.credential),
      controller.signal,
      () => new Error(`${opts.tool}: request timed out after ${opts.timeoutMs}ms`),
    )
    for (const r of cred.redactions) redactions.add(r)

    const headers = new Headers()
    for (const h of opts.extraHeaders ?? []) headers.set(h.name, h.value)
    // Operator credential headers win over any extra header.
    for (const h of cred.headers) headers.set(h.name, h.value)

    let resp: Response
    try {
      resp = await fetch(opts.url, {
        method: "POST",
        headers,
        body: opts.body,
        redirect: "manual",
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`${opts.tool}: request timed out after ${opts.timeoutMs}ms`)
      }
      const msg = applyRedactions(String(err), [...redactions])
      throw new Error(`${opts.tool}: request to '${opts.url.hostname}' failed: ${msg}`)
    }

    // A messaging API does not legitimately redirect a send. Following one would
    // be the SSRF/exfil escape; refuse it (the destination stays the pinned
    // endpoint). Drain the body so the socket can close.
    if (REDIRECT_STATUSES.has(resp.status)) {
      try {
        await resp.body?.cancel()
      } catch {
        /* nothing to drain */
      }
      throw new Error(
        `${opts.tool}: provider endpoint '${opts.url.hostname}' returned a ${resp.status} redirect, which is not followed`,
      )
    }

    const capped = await readCappedBody(resp, opts.maxBytes)
    const red = [...redactions]
    return {
      status: resp.status,
      status_text: applyRedactions(resp.statusText, red),
      ok: resp.ok,
      body: applyRedactions(capped.text, red),
      body_bytes: capped.bytes,
      body_truncated: capped.truncated,
      authenticated: cred.headers.length > 0,
    }
  } catch (err) {
    // Redaction backstop. Some failures throw a raw offending string before any
    // per-field redaction runs (an invalid credential header value embedded
    // verbatim by `Headers.set`, say). The kernel records a thrown message in the
    // failed-action audit, so scrub the message before it escapes.
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(applyRedactions(message, [...redactions]))
  } finally {
    clearTimeout(timer)
  }
}
