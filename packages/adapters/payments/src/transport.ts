import {
  type PaymentCredential,
  type ResolvedHeader,
  applyRedactions,
  resolveCredential,
} from "./credentials.js"

/**
 * The payment transport: a thin, hand-rolled wrapper over the runtime's `fetch`
 * for one JSON POST to an operator-fixed payment-provider endpoint. The messaging
 * adapter's `transport.ts` sibling, ported verbatim — same posture (bounded
 * wall-clock timeout, bounded response capture, secret redaction from everything
 * surfaced), and the same deliberate simplification:
 *
 *   **Redirects are NOT followed.** A payment provider's charge endpoint does not
 *   legitimately redirect a POST: a 3xx on a `charge` is anomalous, and *following*
 *   one would be exactly the SSRF/exfil escape. So a redirect is a hard failure
 *   here, not something to chase. The destination stays exactly the operator-fixed
 *   endpoint.
 *
 * Same honesty boundary as ADR-0004/0006/0007/0008/0009: a TS-level governance
 * boundary, not network containment. The POST reaches the real provider by design.
 */

export const DEFAULT_TIMEOUT_MS = 15_000
/** Cap on the captured provider response. A charge confirmation is small; an
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
  credential?: PaymentCredential
  /** Extra non-secret headers (e.g. Content-Type, Idempotency-Key). */
  extraHeaders?: ResolvedHeader[]
  timeoutMs: number
  maxBytes: number
  /** Tool name for error messages. */
  tool: string
}

/** Read a response body into REDACTED text, bounded by `maxBytes`. Streams and
 * stops once the cap (plus a redaction overlap) is exceeded, cancelling the rest —
 * so an oversized body is never fully buffered.
 *
 * The cap is applied AFTER redaction, not before. If we truncated the raw bytes at
 * `maxBytes` first, a credential a hostile provider echoes straddling that
 * boundary would be cut mid-secret, leaving an unredacted credential *prefix* that
 * no full redaction variant matches. So we read a small overlap beyond the cap —
 * the longest redaction string — which guarantees any secret with at least one
 * byte inside `[0, maxBytes)` is FULLY present in the window, redact the whole
 * window, then bound the redacted text to the cap. Slicing the already-redacted
 * text can only drop trailing content; it can never reveal a partial secret. */

const JSON_SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

/** Decode the COMPLETE set of JSON string escapes in `text` to their literal
 * characters — every form a hostile provider can use to hide a credential from a
 * raw-string redaction, which a JSON consumer would then DECODE: `\"` `\\` `\/` `\b`
 * `\f` `\n` `\r` `\t` and `\uXXXX`. A single left-to-right pass mirrors JSON's own
 * decoding (so `\\/` → `\/`, never over-decoded), collapsing full / partial / mixed
 * escapes — and works on a truncated or invalid body that cannot be parsed. Adjacent
 * `\uXXXX` surrogate-pair escapes recombine naturally in the result. */
function decodeJsonStringEscapes(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_m, esc) =>
    esc[0] === "u"
      ? String.fromCharCode(Number.parseInt(esc.slice(1), 16))
      : (JSON_SIMPLE_ESCAPES[esc] ?? esc),
  )
}

async function readCappedBody(
  resp: Response,
  maxBytes: number,
  redactions: string[],
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!resp.body) return { text: "", bytes: 0, truncated: false }
  // Overlap = the longest redaction string in BYTES (not UTF-16 chars — the read
  // window is byte-oriented, and a multibyte secret's byte length exceeds its
  // `.length`), so a secret straddling the cap is fully captured for matching
  // before we bound the output.
  const overlap = redactions.reduce((m, r) => Math.max(m, Buffer.byteLength(r, "utf8")), 0)
  const readLimit = maxBytes + overlap
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let captured = 0
  // Set when we stop early because the stream had more than the read window —
  // load-bearing when overlap is 0, where `captured` maxes at exactly `maxBytes`
  // and `captured > maxBytes` could never fire.
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
  // secret becomes `***`, THEN bound the redacted text to the cap by BYTES (the
  // cap is a byte cap; slicing by chars could leave the body several× over it for
  // multibyte content). Cutting already-redacted text can only drop trailing bytes
  // — every secret in the window is already `***` — so a partial secret can never
  // reappear (a cut multibyte tail is at worst a cosmetic replacement char).
  const raw = buf.toString("utf8")
  // JSON-escape evasion: a hostile provider can echo the credential using ANY JSON
  // string escape — `\"` `\\` `\/` `\b` `\f` `\n` `\r` `\t` `\uXXXX`, full / partial /
  // mixed — which a raw-string match misses but a JSON consumer DECODES, so the secret
  // would surface decoded in any field parsed from this body (an `id` / `error`) AND in
  // this very excerpt. NORMALISE before redacting so no escaped form survives:
  //   - COMPLETE JSON → re-encode canonically (`JSON.stringify` of the parse). This
  //     collapses every ASCII escape (`\uXXXX`, `\/`, …) to literal so redaction
  //     matches, while KEEPING the body valid JSON (control chars stay `\n` etc.) — so
  //     `defaultInterpret` can still parse `status`/`id` from it. The `"` → `\"`
  //     re-escape is covered by the `jsonStringEscape` redaction variant.
  //   - NOT parseable (truncated / invalid) → decode the FULL JSON string-escape set to
  //     literal. Such a body is not validly parsed downstream anyway (the charge fails,
  //     correctly), so there is no parseability to preserve — only the escaped secret
  //     to scrub from the excerpt / audit (e.g. a `\/`-escaped base64 token).
  // The redaction set's `\uXXXX` variants also size the read overlap so a fully-escaped
  // secret straddling the cap is captured before this step.
  let normalized: string
  try {
    normalized = JSON.stringify(JSON.parse(raw))
  } catch {
    normalized = decodeJsonStringEscapes(raw)
  }
  const redacted = applyRedactions(normalized, redactions)
  const redactedBuf = Buffer.from(redacted, "utf8")
  const text = redactedBuf.byteLength > maxBytes ? utf8CutAtMost(redactedBuf, maxBytes) : redacted
  return { text, bytes: Buffer.byteLength(text, "utf8"), truncated }
}

/** Decode the first ≤ `maxBytes` bytes of `buf` as UTF-8, cutting on a character
 * boundary (never mid-sequence, which would decode to U+FFFD and overshoot). */
function utf8CutAtMost(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.byteLength)
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

/** Settle with `promise`, but reject as soon as `signal` aborts. Brings an async
 * step that does NOT take an AbortSignal (the credential resolver) under the same
 * wall-clock deadline as the fetch — so a hung secret-store lookup cannot outlast
 * `timeoutMs`. (Mirrors the messaging/HTTP adapters' `raceAbort`.) */
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

    // A payment API does not legitimately redirect a charge. Following one would be
    // the SSRF/exfil escape; refuse it (the destination stays the pinned endpoint).
    // Drain the body so the socket can close.
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

    const red = [...redactions]
    // readCappedBody redacts BEFORE applying the cap (so a credential straddling
    // the byte boundary can't leave an unredacted prefix), so `capped.text` is
    // already redacted — do not (and need not) redact it again here.
    const capped = await readCappedBody(resp, opts.maxBytes, red)
    return {
      status: resp.status,
      status_text: applyRedactions(resp.statusText, red),
      ok: resp.ok,
      body: capped.text,
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
