import { writeFile } from "node:fs/promises"
import type { Sensitivity } from "@qmilab/lodestar-core"
import { defaultLogRoot, loadSessionEvents, projectChain } from "@qmilab/lodestar-trace"
import { type OtlpTracePayload, toOtlpTraceJson } from "./otlp.js"
import { buildTrace } from "./project-spans.js"

/**
 * The I/O edge of the package. Everything upstream (`project-spans`,
 * `otlp`) is pure; this module reads the log via `@qmilab/lodestar-trace`,
 * builds the trace, and delivers it — POST to an OTLP endpoint, write to a
 * file, or neither (the caller prints the returned body).
 *
 * Read-only with respect to the event log: it only ever reads.
 */

export interface ExportSessionOptions {
  sessionId: string
  /** Skips the project scan when known. */
  projectId?: string
  /** Event-log root. Defaults to `<cwd>/.lodestar/events`. */
  logRoot?: string
  /** Content above this is withheld. Default "internal". */
  sensitivityCeiling?: Sensitivity
  /** OTLP/HTTP base URL (e.g. `http://localhost:4318`); `/v1/traces` is appended. */
  endpoint?: string
  /** Extra headers for the OTLP POST (e.g. `authorization`). */
  headers?: Record<string, string>
  /** Write the OTLP JSON to this path instead of POSTing. */
  out?: string
  /** Pretty-print the JSON written to file / returned body. Default true. */
  pretty?: boolean
}

export interface ExportSummary {
  session_id: string
  project_id: string
  trace_id: string
  span_count: number
  event_count: number
  redacted_count: number
  /** How the trace was delivered. `none` ⇒ caller prints `otlp`. */
  delivered: "endpoint" | "file" | "none"
  /** The serialised OTLP body, for inspection or stdout printing. */
  otlp: OtlpTracePayload
}

/** Thrown when the session has no events in the log (CLI maps this to exit 3). */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`no events found for session "${sessionId}"`)
    this.name = "SessionNotFoundError"
  }
}

export async function exportSession(opts: ExportSessionOptions): Promise<ExportSummary> {
  const logRoot = opts.logRoot ?? defaultLogRoot()
  const loadInput: { logRoot: string; session_id: string; project_id?: string } = {
    logRoot,
    session_id: opts.sessionId,
  }
  if (opts.projectId !== undefined) loadInput.project_id = opts.projectId
  const { project_id, events } = await loadSessionEvents(loadInput)

  if (events.length === 0) throw new SessionNotFoundError(opts.sessionId)

  const projection = projectChain(events, { session_id: opts.sessionId, project_id })
  const buildOpts = opts.sensitivityCeiling ? { sensitivityCeiling: opts.sensitivityCeiling } : {}
  const trace = buildTrace(projection, buildOpts)
  const otlp = toOtlpTraceJson([trace])

  let delivered: ExportSummary["delivered"] = "none"
  if (opts.endpoint) {
    await postOtlp(opts.endpoint, otlp, opts.headers)
    delivered = "endpoint"
  } else if (opts.out) {
    const body = JSON.stringify(otlp, null, opts.pretty === false ? 0 : 2)
    await writeFile(opts.out, `${body}\n`, "utf8")
    delivered = "file"
  }

  return {
    session_id: opts.sessionId,
    project_id,
    trace_id: trace.trace_id,
    span_count: trace.spans.length,
    event_count: projection.event_count,
    redacted_count: trace.redacted_count,
    delivered,
    otlp,
  }
}

async function postOtlp(
  endpoint: string,
  body: OtlpTracePayload,
  headers?: Record<string, string>,
): Promise<void> {
  const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const detail = text ? `: ${text.slice(0, 200)}` : ""
    throw new Error(`OTLP endpoint ${url} returned ${res.status} ${res.statusText}${detail}`)
  }
}
