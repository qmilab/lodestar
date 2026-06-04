import { join } from "node:path"
import type { EventEnvelope } from "@qmilab/lodestar-core"
import { EventLogReader } from "@qmilab/lodestar-event-log"
import { defaultLogRoot, projectChain, renderReport } from "@qmilab/lodestar-trace"
import { Elysia } from "elysia"
import { listSessions, pendingApprovals, readAllEvents } from "./sessions.js"
import { toWireProjection } from "./wire.js"

/**
 * The read-side Governing UI server.
 *
 * Strictly read-only: every route is a `GET` and every handler is a pure
 * read + projection over the NDJSON event log. There is no mutation route
 * anywhere — pending approvals are *surfaced*, never resolved (resolution
 * is the separate write-side surface). Binds to loopback by default; the
 * log can carry `secret`-sensitivity beliefs, so localhost is the trust
 * boundary, exactly as for `lodestar report`.
 */

export interface ViewerOptions {
  /** Event-log root. Defaults to `<cwd>/.lodestar/events`. */
  logRoot?: string
  /** Interface to bind. Defaults to `127.0.0.1` (loopback). */
  host?: string
  /** Port to bind. Defaults to 4319; pass 0 for an ephemeral port. */
  port?: number
  /** SSE live-tail re-read interval, in milliseconds. Defaults to 1000. */
  tailIntervalMs?: number
}

export interface ViewerHandle {
  /** The resolved base URL, e.g. `http://127.0.0.1:4319`. */
  url: string
  host: string
  port: number
  /** The resolved event-log root being served. */
  logRoot: string
  /** Stop the server and release the port. */
  stop: () => Promise<void>
}

const PUBLIC_DIR = join(import.meta.dir, "public")

function assetResponse(name: string, contentType: string): Response {
  return new Response(Bun.file(join(PUBLIC_DIR, name)), {
    headers: { "content-type": contentType },
  })
}

function parseSeq(value: string | undefined): number {
  if (value === undefined) return -1
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : -1
}

/**
 * A Server-Sent-Events stream of envelopes with `seq > sinceSeq`. The
 * event log has no native tail, so the server re-reads the session on a
 * short interval and emits whatever is new; the client subscribes with an
 * `EventSource`. Polling stops when the client disconnects (`cancel`).
 */
function sseResponse(
  logRoot: string,
  project: string,
  session: string,
  sinceSeq: number,
  intervalMs: number,
): Response {
  const reader = new EventLogReader(logRoot)
  const encoder = new TextEncoder()
  let lastSeq = sinceSeq
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const stop = () => {
    closed = true
    if (timer) clearTimeout(timer)
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = async () => {
        if (closed) return
        let fresh: EventEnvelope[] = []
        try {
          const events = await reader.readSession(project, session)
          fresh = events.filter((event) => event.seq > lastSeq)
        } catch {
          fresh = [] // tolerate a torn read mid-append; next tick retries
        }
        if (closed) return
        try {
          if (fresh.length > 0) {
            for (const event of fresh) {
              if (event.seq > lastSeq) lastSeq = event.seq
              controller.enqueue(
                encoder.encode(`event: append\ndata: ${JSON.stringify(event)}\n\n`),
              )
            }
          } else {
            controller.enqueue(encoder.encode(`: ping ${lastSeq}\n\n`))
          }
        } catch {
          stop() // controller closed under us — stop polling
          return
        }
        if (!closed) timer = setTimeout(tick, intervalMs)
      }

      controller.enqueue(encoder.encode(`: connected sinceSeq=${sinceSeq}\n\n`))
      void tick()
    },
    cancel() {
      stop()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}

/**
 * Build the Elysia app. Internal — callers use {@link startViewer}, which
 * returns a transport-agnostic {@link ViewerHandle} (and keeps the complex
 * Elysia generic out of the package's public type surface).
 */
function createApp(opts: Required<Pick<ViewerOptions, "logRoot" | "tailIntervalMs">>) {
  const { logRoot, tailIntervalMs } = opts
  const reader = new EventLogReader(logRoot)

  return (
    new Elysia()
      // ── Static SPA assets ────────────────────────────────────────────
      .get("/", () => assetResponse("index.html", "text/html; charset=utf-8"))
      .get("/app.js", () => assetResponse("app.js", "text/javascript; charset=utf-8"))
      .get("/app.css", () => assetResponse("app.css", "text/css; charset=utf-8"))
      // ── Read-only API ────────────────────────────────────────────────
      .get("/api/health", () => ({ ok: true, log_root: logRoot, read_only: true }))
      .get("/api/sessions", () => listSessions(logRoot))
      .get("/api/approvals", async () => pendingApprovals(await readAllEvents(logRoot)))
      .get("/api/sessions/:project/:session", async ({ params, set }) => {
        const project = decodeURIComponent(params.project)
        const session = decodeURIComponent(params.session)
        const events = await reader.readSession(project, session)
        if (events.length === 0) {
          set.status = 404
          return { error: "session not found", project, session }
        }
        const projection = projectChain(events, { session_id: session, project_id: project })
        return toWireProjection(projection)
      })
      .get("/api/sessions/:project/:session/report", async ({ params, set }) => {
        const project = decodeURIComponent(params.project)
        const session = decodeURIComponent(params.session)
        const events = await reader.readSession(project, session)
        if (events.length === 0) {
          set.status = 404
          return "session not found"
        }
        const projection = projectChain(events, { session_id: session, project_id: project })
        set.headers["content-type"] = "text/markdown; charset=utf-8"
        return renderReport(projection)
      })
      .get("/api/sessions/:project/:session/events", async ({ params, query }) => {
        const project = decodeURIComponent(params.project)
        const session = decodeURIComponent(params.session)
        const sinceSeq = parseSeq(query.sinceSeq)
        const events = await reader.readSession(project, session)
        return events.filter((event) => event.seq > sinceSeq)
      })
      .get("/api/sessions/:project/:session/stream", ({ params, query }) => {
        const project = decodeURIComponent(params.project)
        const session = decodeURIComponent(params.session)
        const sinceSeq = parseSeq(query.sinceSeq)
        return sseResponse(logRoot, project, session, sinceSeq, tailIntervalMs)
      })
  )
}

function formatHost(host: string): string {
  // Bracket IPv6 literals for the URL authority component.
  return host.includes(":") ? `[${host}]` : host
}

/**
 * Start the read-side viewer. Returns once Bun is listening, with a handle
 * carrying the resolved URL and a `stop()` for graceful shutdown.
 */
export async function startViewer(opts: ViewerOptions = {}): Promise<ViewerHandle> {
  const logRoot = opts.logRoot ?? defaultLogRoot()
  const host = opts.host ?? "127.0.0.1"
  const port = opts.port ?? 4319
  const tailIntervalMs = opts.tailIntervalMs ?? 1000

  const app = createApp({ logRoot, tailIntervalMs })
  app.listen({ hostname: host, port })

  const server = app.server
  if (!server) throw new Error("viewer failed to start: Bun server handle is unavailable")

  const resolvedHost = server.hostname ?? host
  const resolvedPort = server.port ?? port
  const url = `http://${formatHost(resolvedHost)}:${resolvedPort}`

  return {
    url,
    host: resolvedHost,
    port: resolvedPort,
    logRoot,
    stop: async () => {
      await app.stop()
    },
  }
}
