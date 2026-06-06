import { bytesToHex, randomBytes } from "@noble/hashes/utils.js"
import type { ResolvedSigner } from "./credentials.js"
import { type NostrEvent, signEvent } from "./event.js"

/**
 * The relay transport: a thin, hand-rolled client over the runtime's standard
 * `WebSocket` for the two governed operations — publish (NIP-01 `EVENT` with
 * NIP-42 `AUTH`) and fetch (NIP-01 `REQ` → `EVENT`* → `EOSE`). This is the
 * Nostr-specific sibling of the git adapter's scoped `runGit`: same posture —
 * bounded wall-clock timeout, bounded result capture, and secret redaction from
 * everything surfaced — but the egress is a WebSocket, not a subprocess, so the
 * git adapter's argv/no-shell/process-group machinery does not apply here.
 *
 * Like the git adapter, this is a **TS-level governance boundary, not network
 * containment**: publish/fetch reach the real relay by design. The governance —
 * relay pinning, the in-process signing key never leaving the adapter, the L4
 * approval gate, and treating fetched events as untrusted — lives in `tools.ts`.
 */

export const DEFAULT_RELAY_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_EVENTS = 200
/** Per-frame byte cap: a single relay frame larger than this is dropped BEFORE it
 * is parsed or recorded. An untrusted relay must not be able to exhaust memory or
 * inflate an observation with one giant frame — `maxEvents` bounds frame *count*,
 * not size, so this is the size half of "bounded capture". */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 // 256 KiB
/** Cumulative byte cap on a fetch's collected events; once exceeded the fetch
 * stops and reports `truncated`. Bounds total captured size across many frames. */
export const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 // 4 MiB

/** NIP-42 client authentication event kind. */
const KIND_CLIENT_AUTH = 22242

/** Byte length of a UTF-8 text frame (what crosses the wire), not its UTF-16
 * char count — so the cap is an honest byte bound for multibyte content. */
function frameBytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

export interface RelayPublishResult {
  relay: string
  accepted: boolean
  /** The relay's OK message (or our reason on timeout/error), redacted. */
  message: string
  /** Whether a NIP-42 AUTH round completed before the event was accepted. */
  authenticated: boolean
}

export interface RelayFetchResult {
  relay: string
  /** Raw event objects exactly as received — UNVALIDATED, UNTRUSTED input.
   * `tools.ts` validates the shape and verifies each signature. */
  events: unknown[]
  /** True if the relay sent EOSE (end of stored events). */
  eose: boolean
  /** True if results were cut short — the max-events or cumulative-byte bound was
   * hit, or an oversized frame was dropped. The collected set is incomplete. */
  truncated: boolean
  /** A relay NOTICE/CLOSED reason or our timeout note, redacted. */
  message: string
}

/** Replace every occurrence of each non-empty redaction with `***`. Defence in
 * depth: the secret key never goes on the wire (only the pubkey + sig do), but a
 * relay can echo arbitrary text and we never want a key to slip through. */
export function applyRedactions(text: string, redactions: string[]): string {
  let out = text
  for (const secret of redactions) {
    if (secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}

/** Parse an already size-checked text frame into a JSON array, or null. The
 * caller enforces the typeof/byte-size guard so the parse never runs on an
 * oversized frame. */
function parseFrame(text: string): unknown[] | null {
  try {
    const frame = JSON.parse(text)
    return Array.isArray(frame) ? frame : null
  } catch {
    return null
  }
}

/**
 * Publish a pre-signed event to one relay. Awaits the relay's `OK` (NIP-01) so
 * the *outcome* is the relay's real verdict, not fire-and-forget. Handles
 * NIP-42: on an `auth-required:` rejection (with a challenge the relay offered),
 * signs a kind-22242 auth event with the SAME key, sends it, and resends the
 * original once. Always closes the socket; always resolves (never rejects).
 */
export function publishToRelay(
  url: string,
  event: NostrEvent,
  signer: ResolvedSigner,
  opts: { timeoutMs: number; redactions: string[]; maxFrameBytes?: number },
): Promise<RelayPublishResult> {
  const redact = (s: string): string => applyRedactions(s, opts.redactions)
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  return new Promise((resolveResult) => {
    let settled = false
    let authed = false
    let authTried = false
    let authEventId: string | null = null
    let latestChallenge: string | null = null
    let ws: WebSocket | undefined

    const finish = (r: { accepted: boolean; message: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        /* already closed */
      }
      resolveResult({ relay: url, accepted: r.accepted, message: r.message, authenticated: authed })
    }

    const timer = setTimeout(
      () => finish({ accepted: false, message: redact("timeout waiting for relay OK") }),
      opts.timeoutMs,
    )

    const sendAuth = (challenge: string): void => {
      authTried = true
      const authEvent = signEvent(signer.secretKey, {
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_CLIENT_AUTH,
        tags: [
          ["relay", url],
          ["challenge", challenge],
        ],
        content: "",
      })
      authEventId = authEvent.id
      ws?.send(JSON.stringify(["AUTH", authEvent]))
    }

    try {
      ws = new WebSocket(url)
    } catch (err) {
      finish({ accepted: false, message: redact(`connect failed: ${String(err)}`) })
      return
    }

    ws.onopen = (): void => ws?.send(JSON.stringify(["EVENT", event]))
    ws.onerror = (): void => finish({ accepted: false, message: redact("relay connection error") })
    ws.onclose = (): void =>
      finish({ accepted: false, message: redact("relay closed connection before OK") })
    ws.onmessage = (msg: MessageEvent): void => {
      // Bound the untrusted frame before parsing it. The OK/AUTH frames we need
      // are tiny; an oversized frame is never one of them, so drop it.
      if (typeof msg.data !== "string" || frameBytes(msg.data) > maxFrameBytes) return
      const frame = parseFrame(msg.data)
      if (!frame) return
      const type = frame[0]

      if (type === "AUTH" && typeof frame[1] === "string") {
        // Relay-offered challenge — remember it; we act on it only if the event
        // is rejected with auth-required (the standard NIP-42 client flow).
        latestChallenge = frame[1]
        return
      }

      if (type !== "OK") return // NOTICE / EOSE / etc. — ignore; timeout backstops
      const okId = frame[1]
      const ok = frame[2] === true
      const reason = typeof frame[3] === "string" ? frame[3] : ""

      if (okId === authEventId) {
        if (ok) {
          authed = true
          ws?.send(JSON.stringify(["EVENT", event])) // re-send the original now that we're authed
        } else {
          finish({ accepted: false, message: redact(`auth rejected: ${reason}`) })
        }
        return
      }

      if (okId !== event.id) return // OK for something we didn't send — ignore

      if (ok) {
        finish({ accepted: true, message: redact(reason) })
        return
      }
      // Rejected. If it's auth-required and we have a challenge, authenticate once.
      if (reason.startsWith("auth-required:") && !authTried && latestChallenge) {
        sendAuth(latestChallenge)
        return
      }
      if (reason.startsWith("auth-required:") && !latestChallenge) {
        finish({
          accepted: false,
          message: redact(`auth-required but relay offered no challenge: ${reason}`),
        })
        return
      }
      finish({ accepted: false, message: redact(reason || "relay rejected the event") })
    }
  })
}

/**
 * Subscribe to one relay with the given NIP-01 filters, collect stored events up
 * to `maxEvents`, and stop at `EOSE` (or `CLOSED`, or the timeout). Sends
 * `CLOSE` and shuts the socket on the way out. Returns raw, UNVALIDATED event
 * objects — the caller validates the shape and verifies signatures; nothing here
 * is treated as authentic.
 */
export function fetchFromRelay(
  url: string,
  filters: unknown[],
  opts: {
    timeoutMs: number
    maxEvents: number
    redactions: string[]
    maxFrameBytes?: number
    maxTotalBytes?: number
  },
): Promise<RelayFetchResult> {
  const redact = (s: string): string => applyRedactions(s, opts.redactions)
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const subId = bytesToHex(randomBytes(8))
  const events: unknown[] = []
  return new Promise((resolveResult) => {
    let settled = false
    let truncated = false
    let totalBytes = 0
    let ws: WebSocket | undefined

    const finish = (r: { eose: boolean; message: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.send(JSON.stringify(["CLOSE", subId]))
      } catch {
        /* socket gone */
      }
      try {
        ws?.close()
      } catch {
        /* already closed */
      }
      resolveResult({ relay: url, events, eose: r.eose, truncated, message: redact(r.message) })
    }

    const timer = setTimeout(
      () => finish({ eose: false, message: "timeout waiting for EOSE" }),
      opts.timeoutMs,
    )

    try {
      ws = new WebSocket(url)
    } catch (err) {
      finish({ eose: false, message: `connect failed: ${String(err)}` })
      return
    }

    ws.onopen = (): void => ws?.send(JSON.stringify(["REQ", subId, ...filters]))
    ws.onerror = (): void => finish({ eose: false, message: "relay connection error" })
    ws.onclose = (): void => finish({ eose: false, message: "relay closed connection" })
    ws.onmessage = (msg: MessageEvent): void => {
      if (typeof msg.data !== "string") return
      const bytes = frameBytes(msg.data)
      // An oversized frame is dropped before parsing — the results are then
      // incomplete, so report truncation rather than silently swallowing it.
      if (bytes > maxFrameBytes) {
        truncated = true
        return
      }
      const frame = parseFrame(msg.data)
      if (!frame) return
      const [type, sid] = frame
      if (sid !== subId) return // not our subscription

      if (type === "EVENT") {
        events.push(frame[2])
        totalBytes += bytes
        // Stop at the frame-count OR the cumulative-byte bound — many medium
        // frames must not add up to an unbounded capture either.
        if (events.length >= opts.maxEvents || totalBytes >= maxTotalBytes) {
          truncated = true
          finish({
            eose: false,
            message: totalBytes >= maxTotalBytes ? "max bytes reached" : "max events reached",
          })
        }
        return
      }
      if (type === "EOSE") {
        finish({ eose: true, message: "" })
        return
      }
      if (type === "CLOSED") {
        finish({
          eose: false,
          message: typeof frame[2] === "string" ? frame[2] : "relay closed subscription",
        })
      }
    }
  })
}
