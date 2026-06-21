import type { ApprovalRequest } from "@qmilab/lodestar-core"
import { z } from "zod"
import {
  type ApprovalResolution,
  ApprovalResolutionSchema,
  deleteApprovalResolution,
  readApprovalResolution,
} from "./approvals-channel.js"

/**
 * The approval **transport** seam (ADR-0015): *where* a host looks for an
 * out-of-band approval resolution and *how* it notifies that a hold opened.
 *
 * ## Untrusted transport — categorically distinct from `ApprovalResolver`
 *
 * An {@link ApprovalChannel} is UNTRUSTED. {@link ApprovalChannel.fetch} returns
 * an {@link ApprovalResolution} whose `approver_id` is just a claimed string and
 * whose bytes came from wherever the channel reads — a local file, a remote HTTP
 * service, anything. The consumer (the MCP proxy's `resolutionVerified`, the
 * runtime gate) verifies that resolution's Ed25519 signature against the
 * operator-pinned approver keys **after** transport, before promoting it. So the
 * worst a fully malicious channel can do is *withhold* or *return garbage* — a
 * denial-of-service on approvals (the hold times out to the conservative
 * outcome), never mint / upgrade / replay / revive a grant.
 *
 * This is NOT the `ApprovalResolver` (in `./types.ts`): that is the *trusted
 * in-process producer* a host injects to decide a hold, running inside the same
 * process with no forgery surface. The two must never be conflated — a channel
 * moves bytes; a resolver makes decisions. Keeping the vocabulary strict is the
 * whole point of the seam.
 *
 * The default {@link FileApprovalChannel} wraps today's signed `.approvals/`
 * file side-channel byte-for-byte. {@link HttpApprovalChannel} is the
 * config-driven remote transport for an out-of-process approval service.
 */
export interface ApprovalChannel {
  /**
   * Best-effort notify that a hold opened, carrying the `ApprovalRequest`. A
   * channel without a notify surface (the file channel) omits this. Failure here
   * NEVER blocks or fails the hold — the host swallows it.
   */
  announce?(request: ApprovalRequest): Promise<void>
  /**
   * Poll for a resolution of `ref`. `undefined` means "not yet" (keep polling).
   * The return value is **UNTRUSTED INPUT**: the consumer verifies its Ed25519
   * signature against the operator-pinned approver keys before trusting it.
   */
  fetch(ref: ApprovalRef): Promise<ApprovalResolution | undefined>
  /**
   * Consume a resolution after the host has promoted it (delete the file / issue
   * a DELETE). Best-effort — errors are swallowed; a channel without a consume
   * surface omits this.
   */
  consume?(ref: ApprovalRef): Promise<void>
}

/** Identifies one held action's approval across a channel. */
export interface ApprovalRef {
  project_id: string
  session_id: string
  request_id: string
  action_id: string
}

/**
 * A secret value, or a resolver that produces it (sync or async). The channel
 * never reads `process.env` itself — honoring the "no host-env passthrough"
 * rule; the host (the CLI, which owns the process) resolves a `token_env` name
 * into one of these and injects it.
 */
export type SecretValue = string | (() => string | Promise<string>)

// ── Config ────────────────────────────────────────────────────────────────

/**
 * Channel configuration. `file` (the default) is the local signed `.approvals/`
 * side-channel — no forgery surface beyond the filesystem, no notify route.
 * `http` is a remote approval service: the `endpoint` is the **operator pin**
 * (never derived from agent or log content, so there is no SSRF discovery
 * surface), HTTPS-only unless `allow_http`, with a bounded wall-clock timeout
 * and response-body cap. The bearer token is named by `token_env` and resolved
 * by the host — never inlined here, never logged.
 *
 * Lives in `@qmilab/lodestar-guard` (beside the channel impls), NOT in
 * `@qmilab/lodestar-core`: it is host config, meaningless without the channel
 * classes it drives, and core may not import `@qmilab/lodestar-*`. Same
 * placement precedent as `ApprovalsConfigSchema` / `ProxyConfigSchema` in
 * `guard-mcp/config.ts`.
 */
export const ApprovalChannelConfigSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("file") }).strict(),
    z
      .object({
        kind: z.literal("http"),
        endpoint: z
          .string()
          .url()
          .describe(
            "operator-pinned base URL of the approval service; config only, never derived from agent/log content",
          ),
        token_env: z
          .string()
          .min(1)
          .optional()
          .describe(
            "name of the env var holding the bearer token; the secret is resolved by the host and never inlined or logged",
          ),
        allow_http: z
          .boolean()
          .default(false)
          .describe(
            "permit http:// (local stub / dev only); HTTPS-only otherwise — no silent insecure default",
          ),
        timeout_ms: z.number().int().positive().default(15_000),
        max_body_bytes: z
          .number()
          .int()
          .positive()
          .default(64 * 1024),
      })
      .strict(),
  ])
  .default({ kind: "file" })
export type ApprovalChannelConfig = z.infer<typeof ApprovalChannelConfigSchema>

// ── File channel (default) ──────────────────────────────────────────────────

/**
 * The default channel: the signed `.approvals/` file side-channel, wrapped
 * byte-for-byte. Delegates to the existing `readApprovalResolution` /
 * `deleteApprovalResolution` primitives, so the atomic temp-file + rename write
 * and the sole-writer `seq` integrity are literally the same code path as before
 * the seam existed. No `announce` — the file channel has no notify surface (the
 * resolver polls the directory).
 *
 * `writeApprovalResolution` (the `lodestar approve` CLI's write side) is
 * intentionally NOT part of the channel interface: a channel is consumer-side
 * transport (read + consume), not a producer.
 */
export class FileApprovalChannel implements ApprovalChannel {
  constructor(private readonly logRoot: string) {}

  async fetch(ref: ApprovalRef): Promise<ApprovalResolution | undefined> {
    return readApprovalResolution(this.logRoot, ref.project_id, ref.request_id)
  }

  async consume(ref: ApprovalRef): Promise<void> {
    await deleteApprovalResolution(this.logRoot, ref.project_id, ref.request_id)
  }
}

// ── HTTP channel ────────────────────────────────────────────────────────────

interface HttpApprovalChannelOptions {
  endpoint: URL
  token?: SecretValue
  timeoutMs: number
  maxBytes: number
}

/**
 * A remote approval service, reached over HTTP. Mirrors the messaging adapter's
 * transport posture (`adapters/messaging/src/transport.ts`) — a bounded
 * wall-clock timeout, a bounded response capture, no redirect following, and
 * credential redaction — replicated inline because guard must not depend on an
 * adapter.
 *
 * Routes (all under the operator-pinned `endpoint`):
 *   - `announce`: `POST {endpoint}/v1/approvals` with the `ApprovalRequest` JSON.
 *   - `fetch`:    `GET  {endpoint}/v1/approvals/{project_id}/{request_id}`.
 *   - `consume`:  `DELETE` the same path.
 *
 * Tolerant by construction: every failure on `fetch` (404, any non-2xx, a 3xx
 * redirect which is NOT followed, a network error, a timeout, a torn / oversized
 * / unparseable body) resolves to `undefined`, exactly like
 * `readApprovalResolution` — so the host keeps polling and the hold times out to
 * the conservative outcome. `announce` / `consume` are best-effort and swallow
 * everything. The bearer token rides only the `Authorization` header and never
 * enters any returned, thrown, or logged string.
 */
export class HttpApprovalChannel implements ApprovalChannel {
  private readonly base: string
  private readonly token?: SecretValue
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(opts: HttpApprovalChannelOptions) {
    // Normalise once: strip a trailing slash so path joins are unambiguous.
    this.base = opts.endpoint.href.replace(/\/+$/, "")
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
    this.maxBytes = opts.maxBytes
  }

  async announce(request: ApprovalRequest): Promise<void> {
    // Best-effort: a failed notify must never block or fail the hold.
    const resp = await this.send("POST", `${this.base}/v1/approvals`, JSON.stringify(request))
    await drain(resp)
  }

  async fetch(ref: ApprovalRef): Promise<ApprovalResolution | undefined> {
    const resp = await this.send("GET", this.resolutionUrl(ref))
    if (resp === undefined) return undefined
    // Any non-2xx — 404 (not yet), a 3xx redirect (never followed; `redirect:
    // "manual"` keeps the destination the pinned endpoint), a 5xx — is "no
    // resolution yet". Drain and keep polling.
    if (!resp.ok) {
      await drain(resp)
      return undefined
    }
    const text = await readBoundedText(resp, this.maxBytes)
    if (text === undefined) return undefined // oversized / torn → fail closed
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    const result = ApprovalResolutionSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  }

  async consume(ref: ApprovalRef): Promise<void> {
    const resp = await this.send("DELETE", this.resolutionUrl(ref))
    await drain(resp)
  }

  private resolutionUrl(ref: ApprovalRef): string {
    return `${this.base}/v1/approvals/${encodeURIComponent(ref.project_id)}/${encodeURIComponent(
      ref.request_id,
    )}`
  }

  /**
   * Issue one request under the wall-clock timeout, with the bearer token (if
   * configured) on the `Authorization` header and redirects disabled. Returns the
   * `Response` or `undefined` on ANY failure (timeout, network error, a hung
   * token resolver). Never throws, never surfaces the token.
   */
  private async send(method: string, url: string, body?: string): Promise<Response | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = new Headers()
      if (body !== undefined) headers.set("content-type", "application/json")
      // Resolve the token under the same deadline so a hung resolver can't
      // outlast the timeout. A resolution failure → no auth header → the request
      // simply fails server-side → undefined (keep polling); the token never
      // surfaces.
      const token = await resolveSecret(this.token)
      if (token !== undefined && token.length > 0) {
        headers.set("authorization", `Bearer ${token}`)
      }
      return await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      })
    } catch {
      // Timeout or network error — tolerated. We deliberately surface NO detail
      // (a thrown fetch message could, in principle, echo a header); the host
      // keeps polling and the hold times out to the conservative outcome.
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Drain a response body so the socket can close; ignore failures. */
async function drain(resp: Response | undefined): Promise<void> {
  if (resp?.body === null || resp?.body === undefined) return
  try {
    await resp.body.cancel()
  } catch {
    /* already closing */
  }
}

/**
 * Read a response body to text, bounded by `maxBytes`. Returns `undefined` if the
 * body exceeds the cap (an approval resolution is tiny; an oversized body is
 * anomalous — fail closed rather than buffer it) or the read tears. The token is
 * never echoed into a resolution body, so no straddle-safe redaction is needed
 * here — an over-cap body is simply rejected.
 */
async function readBoundedText(resp: Response, maxBytes: number): Promise<string | undefined> {
  if (!resp.body) return ""
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let captured = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      captured += value.byteLength
      if (captured > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          /* already closing */
        }
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")
}

/** Resolve a {@link SecretValue} to its string, or `undefined` if unset/failed. */
async function resolveSecret(value: SecretValue | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  try {
    return await value()
  } catch {
    return undefined
  }
}

// ── Endpoint scheme guard ────────────────────────────────────────────────────

/**
 * Validate the operator-pinned endpoint's scheme: HTTPS only unless `allowHttp`
 * (a `http://127.0.0.1` local stub / dev escape — explicit, never silent). A
 * `file://` / `gopher://` / unparseable endpoint throws at construction, loudly.
 * No host allowlist is needed: the endpoint IS the pin (the proxy only ever
 * appends its own `project_id` / `request_id` path segments, each
 * `encodeURIComponent`'d — no agent-derived host), the same posture that lets the
 * messaging adapter skip per-hop SSRF re-validation.
 */
export function assertChannelEndpoint(endpoint: string, allowHttp: boolean): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`http approval channel: endpoint '${endpoint}' is not a valid URL`)
  }
  const allowed = allowHttp ? ["https:", "http:"] : ["https:"]
  if (!allowed.includes(url.protocol)) {
    throw new Error(
      `http approval channel: scheme '${url.protocol}' is not allowed (allowed: ${allowed.join(
        ", ",
      )}; set allow_http: true for http:// in a local/dev setup)`,
    )
  }
  return url
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the {@link ApprovalChannel} a host's hold loop reads from. `file` →
 * {@link FileApprovalChannel} over `ctx.logRoot`. `http` →
 * {@link HttpApprovalChannel} over the scheme-validated endpoint, with the bearer
 * token resolved from `config.token_env` via the host-supplied `ctx.resolveToken`
 * (the channel never reads `process.env` — invariant 9 / no host-env passthrough).
 * A `token_env` named but no resolver supplied is a wiring error and throws.
 */
export function createApprovalChannel(
  config: ApprovalChannelConfig,
  ctx: { logRoot: string; resolveToken?: (envName: string) => SecretValue },
): ApprovalChannel {
  if (config.kind === "file") return new FileApprovalChannel(ctx.logRoot)
  const endpoint = assertChannelEndpoint(config.endpoint, config.allow_http)
  let token: SecretValue | undefined
  if (config.token_env !== undefined) {
    if (ctx.resolveToken === undefined) {
      throw new Error(
        "http approval channel: token_env is set but no token resolver was provided. The host " +
          "must resolve the env var and inject a resolver via ctx.resolveToken — the channel " +
          "never reads process.env itself.",
      )
    }
    token = ctx.resolveToken(config.token_env)
  }
  return new HttpApprovalChannel({
    endpoint,
    token,
    timeoutMs: config.timeout_ms,
    maxBytes: config.max_body_bytes,
  })
}

// ── Cross-field guard (shared parse-time + construct-time) ───────────────────

/**
 * An HTTP approval channel reads resolutions from a remote service — a forgery
 * surface that ONLY the Ed25519 signature gate closes. So an *unsigned* HTTP
 * channel must be unrepresentable: it requires at least one pinned approver key
 * and forbids `allow_unsigned`. (The file channel is exempt: an unsigned local
 * `.approvals/` setup is the documented trusted-local escape.)
 *
 * Shared by the `guard-mcp` `ApprovalsConfigSchema.superRefine` AND the
 * `MCPProxy` constructor so the parse-time and construct-time guards can never
 * drift — the same single-source-of-truth shape as
 * `hasUnauthenticatedApprovalGap`.
 */
export function httpChannelForbidsUnsigned(approvals: {
  channel?: { kind?: string }
  authorized_keys?: ReadonlyArray<unknown>
  allow_unsigned?: boolean
}): { ok: true } | { ok: false; reason: string } {
  if (approvals.channel?.kind !== "http") return { ok: true }
  if ((approvals.authorized_keys?.length ?? 0) === 0) {
    return {
      ok: false,
      reason:
        '`approvals.channel.kind: "http"` requires at least one `approvals.authorized_keys` entry — a remote approval channel is a forgery surface that only the signature gate closes, so an unsigned remote channel must be unrepresentable.',
    }
  }
  if (approvals.allow_unsigned === true) {
    return {
      ok: false,
      reason:
        '`approvals.channel.kind: "http"` forbids `approvals.allow_unsigned` — a remote approval channel must be signature-verified; an unsigned remote channel must be unrepresentable.',
    }
  }
  return { ok: true }
}
