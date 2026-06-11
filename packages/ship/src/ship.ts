import { writeFile } from "node:fs/promises"
import type { Sensitivity } from "@qmilab/lodestar-core"
import { defaultLogRoot, loadSessionEvents } from "@qmilab/lodestar-trace"
import { buildShipBatch, serializeBatch } from "./wire.js"

/**
 * The I/O edge of the package. Everything in `wire.ts` is pure; this module
 * reads the log via `@qmilab/lodestar-trace`, builds the `lodestar.session_ship@1`
 * batch, and delivers it — POST the NDJSON body to a collector, write it to a
 * file, or neither (the caller prints the returned body).
 *
 * Read-only with respect to the event log: it only ever reads.
 */

/** v0 ships one bounded POST per session — no silent chunking (ADR-0014). */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * Substrings that mark a header NAME as carrying a credential — RFC auth/cookie
 * plus the common API-key / token / signature families (`X-API-Key`,
 * `X-Auth-Key`, `Authorization`, `Ocp-Apim-Subscription-Key`, `x-functions-key`,
 * AWS `…-Signature`, …). Used two ways: the CLI refuses these on `--header` (so a
 * credential never reaches argv), and {@link shipSession} redacts the VALUE of
 * any header so named from error text (a server may echo it back). Substring-
 * based and deliberately broad — over-matching only routes a header to the
 * env-backed `--secret-header`, while under-matching leaks.
 */
export const CREDENTIAL_HEADER_HINTS = [
  "auth",
  "cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "api-key",
  "apikey",
  "api_key",
  "access-key",
  "subscription-key",
  "functions-key",
  "signature",
] as const

/** True when a header NAME looks like it carries a credential (see {@link CREDENTIAL_HEADER_HINTS}). */
export function looksLikeCredentialHeader(name: string): boolean {
  const n = name.toLowerCase()
  return CREDENTIAL_HEADER_HINTS.some((hint) => n.includes(hint))
}

export interface ShipSessionOptions {
  sessionId: string
  /** Skips the project scan when known. */
  projectId?: string
  /** Event-log root. Defaults to `<cwd>/.lodestar/events`. */
  logRoot?: string
  /** Content above this is withheld (payload replaced, hash kept). Default `internal`. */
  sensitivityCeiling?: Sensitivity
  /** Collector base URL; the body is POSTed to `{endpoint}/v1/events`. */
  endpoint?: string
  /**
   * Extra headers for the POST. The VALUE of any header whose NAME looks like a
   * credential ({@link looksLikeCredentialHeader}) is scrubbed from errors —
   * including an `Authorization` header's bare token. Benign-named header values
   * (e.g. `x-trace`) are NOT redacted, so they can't over-redact the message.
   * For a credential whose header name does NOT look credential-y, also list its
   * value in {@link secretsToRedact}.
   */
  headers?: Record<string, string>
  /**
   * Exact secret values to scrub from any error message this module throws (a
   * server may echo a credential back). The CLI populates this with the
   * `--token-env` token and every `--secret-header` value.
   */
  secretsToRedact?: string[]
  /** Write the NDJSON body to this path instead of POSTing. */
  out?: string
  /**
   * Reject (don't chunk) a POST body larger than this many bytes. Default
   * {@link DEFAULT_MAX_BODY_BYTES}; enforced on the endpoint path only.
   */
  maxBodyBytes?: number
}

export interface ShipSummary {
  session_id: string
  project_id: string
  event_count: number
  redacted_count: number
  ceiling: Sensitivity
  /** How the body was delivered. `none` ⇒ caller prints `ndjson`. */
  delivered: "endpoint" | "file" | "none"
  byte_count: number
  /**
   * The serialised NDJSON body — present only when `delivered === "none"` (the
   * dry-run/stdout path that needs it). On endpoint/file delivery it has already
   * been sent/written, so it is omitted rather than retained (a body can be up to
   * {@link DEFAULT_MAX_BODY_BYTES}).
   */
  ndjson?: string
}

/** Thrown when the session has no events in the log (CLI maps this to exit 3). */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`no events found for session "${sessionId}"`)
    this.name = "SessionNotFoundError"
  }
}

export async function shipSession(opts: ShipSessionOptions): Promise<ShipSummary> {
  // `endpoint` and `out` are mutually exclusive delivery targets. Fail fast
  // (before any I/O) rather than POSTing and silently dropping the file.
  if (opts.endpoint && opts.out) {
    throw new Error("provide only one of `endpoint` or `out` — they are mutually exclusive")
  }

  const logRoot = opts.logRoot ?? defaultLogRoot()
  const loadInput: { logRoot: string; session_id: string; project_id?: string } = {
    logRoot,
    session_id: opts.sessionId,
  }
  if (opts.projectId !== undefined) loadInput.project_id = opts.projectId
  const { project_id, events } = await loadSessionEvents(loadInput)

  if (events.length === 0) throw new SessionNotFoundError(opts.sessionId)

  // Pass the ceiling through only when *present* (not merely truthy), so a
  // falsy-but-invalid value reaches buildShipBatch's validation and fails
  // closed rather than silently defaulting.
  const batch = buildShipBatch({
    project_id,
    session_id: opts.sessionId,
    events,
    ...(opts.sensitivityCeiling !== undefined
      ? { sensitivityCeiling: opts.sensitivityCeiling }
      : {}),
  })
  const ndjson = serializeBatch(batch)
  const byte_count = Buffer.byteLength(ndjson, "utf8")

  let delivered: ShipSummary["delivered"] = "none"
  if (opts.endpoint) {
    const cap = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    if (byte_count > cap) {
      throw new Error(
        `session "${opts.sessionId}" serialises to ${byte_count} bytes, over the ${cap}-byte single-POST ceiling — v0 ships one bounded POST per session (no chunking). Raise maxBodyBytes or narrow the session.`,
      )
    }
    await postEvents(
      opts.endpoint,
      ndjson,
      opts.headers,
      collectSecrets(opts.secretsToRedact, opts.headers),
    )
    delivered = "endpoint"
  } else if (opts.out) {
    await writeFile(opts.out, ndjson, "utf8")
    delivered = "file"
  }

  return {
    session_id: opts.sessionId,
    project_id,
    event_count: batch.manifest.event_count,
    redacted_count: batch.manifest.redacted_count,
    ceiling: batch.manifest.ceiling,
    delivered,
    byte_count,
    // Retain the body only when the caller needs it (dry-run/stdout); on
    // endpoint/file delivery it has been sent/written, so don't pin a ≤64MB
    // string in the returned summary.
    ...(delivered === "none" ? { ndjson } : {}),
  }
}

async function postEvents(
  endpoint: string,
  body: string,
  headers: Record<string, string> | undefined,
  secrets: string[],
): Promise<void> {
  const url = `${endpoint.replace(/\/+$/, "")}/v1/events`
  const res = await fetch(url, {
    method: "POST",
    // content-type LAST so a caller-supplied header can't override the mandated
    // wire type (the receiver contract requires application/x-ndjson).
    headers: { ...headers, "content-type": "application/x-ndjson" },
    body,
  }).catch((err: unknown) => {
    throw new Error(redactSecrets(`POST ${url} failed: ${errMessage(err)}`, secrets))
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // A server may echo a credential back in an error body. Redact the FULL body
    // BEFORE truncating — slicing first could cut a long echoed credential
    // mid-token, leaving an unmatched prefix that survives redaction. The outer
    // redactSecrets then defends the rest of the message (the SQL adapter's
    // DSN-redaction discipline).
    const detail = text ? `: ${redactSecrets(text, secrets).slice(0, 200)}` : ""
    throw new Error(
      redactSecrets(
        `session-ship endpoint ${url} returned ${res.status} ${res.statusText}${detail}`,
        secrets,
      ),
    )
  }
  // Drain the success body so the underlying socket is released promptly — for
  // programmatic callers (the CLI also `process.exit()`s).
  await res.body?.cancel().catch(() => {})
}

/**
 * The exact secret values to scrub from error text: the caller's explicit
 * `secretsToRedact`, plus the VALUE of any header whose NAME looks like a
 * credential ({@link looksLikeCredentialHeader}) — and, for an `Authorization`
 * header, the bare token after the scheme. Benign-named header values (e.g.
 * `x-trace`) are deliberately NOT redacted, so they can't over-redact the
 * message. Sorted longest-first so an overlapping/substring secret can't corrupt
 * the `«redacted»` placeholder.
 */
function collectSecrets(
  explicit: string[] | undefined,
  headers: Record<string, string> | undefined,
): string[] {
  const set = new Set<string>()
  for (const s of explicit ?? []) if (s) set.add(s)
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!value || !looksLikeCredentialHeader(name)) continue
    set.add(value)
    if (name.toLowerCase() === "authorization") {
      const m = value.match(/^\S+\s+(.+)$/)
      if (m?.[1]) set.add(m[1])
    }
  }
  return [...set].sort((a, b) => b.length - a.length)
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join("«redacted»")
  }
  return out
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
