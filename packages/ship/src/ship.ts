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
   * Extra headers for the POST (e.g. `authorization`). Header values — and the
   * bare token from an `Authorization: <scheme> <token>` header — are scrubbed
   * from any error message this module throws, so a credential a server echoes
   * back can never surface in logs.
   */
  headers?: Record<string, string>
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
  /** The serialised NDJSON body, for inspection or stdout printing. */
  ndjson: string
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
    await postEvents(opts.endpoint, ndjson, opts.headers)
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
    ndjson,
  }
}

async function postEvents(
  endpoint: string,
  body: string,
  headers?: Record<string, string>,
): Promise<void> {
  const url = `${endpoint.replace(/\/+$/, "")}/v1/events`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson", ...headers },
    body,
  }).catch((err: unknown) => {
    throw new Error(redactSecrets(`POST ${url} failed: ${errMessage(err)}`, headers))
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const detail = text ? `: ${text.slice(0, 200)}` : ""
    // A server may echo the bearer token back in an error body. Never let a
    // credential surface in our error text (the SQL adapter's DSN-redaction
    // discipline).
    throw new Error(
      redactSecrets(
        `session-ship endpoint ${url} returned ${res.status} ${res.statusText}${detail}`,
        headers,
      ),
    )
  }
}

/**
 * Values worth scrubbing from error text: every header value, plus the bare
 * token from an `Authorization: <scheme> <token>` header (a server might echo
 * just the token, not the whole header value).
 */
function secretsFromHeaders(headers?: Record<string, string>): string[] {
  if (!headers) return []
  const secrets: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (!value) continue
    secrets.push(value)
    if (name.toLowerCase() === "authorization") {
      const m = value.match(/^\S+\s+(.+)$/)
      if (m?.[1]) secrets.push(m[1])
    }
  }
  return secrets
}

function redactSecrets(text: string, headers?: Record<string, string>): string {
  let out = text
  for (const secret of secretsFromHeaders(headers)) {
    if (secret.length === 0) continue
    out = out.split(secret).join("«redacted»")
  }
  return out
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
