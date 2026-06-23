import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ApprovalRef,
  FileApprovalChannel,
  HttpApprovalChannel,
  assertChannelEndpoint,
  createApprovalChannel,
  httpChannelForbidsUnsigned,
} from "./approval-channel.js"
import {
  type ApprovalResolution,
  readApprovalResolution,
  writeApprovalResolution,
} from "./approvals-channel.js"

const REF: ApprovalRef = {
  project_id: "proj",
  session_id: "sess",
  request_id: "req-1",
  action_id: "act-1",
}

const VALID_RESOLUTION: ApprovalResolution = {
  request_id: "req-1",
  action_id: "act-1",
  kind: "granted",
  approver_id: "operator",
  at: "2026-01-01T00:00:00.000Z",
}

// ─── in-process fake approval service ───────────────────────────────────────

interface Recorded {
  method: string
  path: string
  authorization: string | null
  body: string
}

type Handler = (method: string, url: URL, body: string) => Response | Promise<Response>

interface FakeServer {
  base: string
  recorded: Recorded[]
  setHandler: (h: Handler) => void
  stop: () => void
}

function startFakeService(): FakeServer {
  const recorded: Recorded[] = []
  let handler: Handler = () => new Response(null, { status: 404 })
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text()
      recorded.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body,
      })
      return handler(req.method, url, body)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    recorded,
    setHandler: (h) => {
      handler = h
    },
    stop: () => server.stop(true),
  }
}

let service: FakeServer
beforeAll(() => {
  service = startFakeService()
})
afterAll(() => {
  service.stop()
})

function httpChannel(opts?: { token?: string; timeoutMs?: number; maxBytes?: number }) {
  return new HttpApprovalChannel({
    endpoint: new URL(service.base),
    token: opts?.token,
    timeoutMs: opts?.timeoutMs ?? 5_000,
    maxBytes: opts?.maxBytes ?? 64 * 1024,
  })
}

// ─── HttpApprovalChannel.fetch ──────────────────────────────────────────────

describe("HttpApprovalChannel.fetch", () => {
  test("200 → parses and returns the resolution; GETs the right path", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    const got = await httpChannel().fetch(REF)
    expect(got).toEqual(VALID_RESOLUTION)
    expect(service.recorded.at(-1)?.method).toBe("GET")
    expect(service.recorded.at(-1)?.path).toBe("/v1/approvals/proj/req-1")
  })

  test("404 (not yet) → undefined", async () => {
    service.setHandler(() => new Response(null, { status: 404 }))
    expect(await httpChannel().fetch(REF)).toBeUndefined()
  })

  test("500 → undefined (tolerant; keep polling)", async () => {
    service.setHandler(() => new Response("boom", { status: 500 }))
    expect(await httpChannel().fetch(REF)).toBeUndefined()
  })

  test("malformed JSON body → undefined", async () => {
    service.setHandler(() => new Response("{not json", { status: 200 }))
    expect(await httpChannel().fetch(REF)).toBeUndefined()
  })

  test("valid JSON but wrong shape → undefined", async () => {
    service.setHandler(() => Response.json({ hello: "world" }))
    expect(await httpChannel().fetch(REF)).toBeUndefined()
  })

  test("a schema-valid resolution for a DIFFERENT request_id → undefined (binding)", async () => {
    // A misrouted/hostile service returns a resolution bound to another request.
    service.setHandler(() => Response.json({ ...VALID_RESOLUTION, request_id: "some-other-req" }))
    expect(await httpChannel().fetch(REF)).toBeUndefined()
  })

  test("a 3xx redirect is NOT followed → undefined, target never hit", async () => {
    service.recorded.length = 0
    service.setHandler((method, url) => {
      if (url.pathname === "/elsewhere") return Response.json(VALID_RESOLUTION)
      return new Response(null, { status: 302, headers: { location: `${service.base}/elsewhere` } })
    })
    expect(await httpChannel().fetch(REF)).toBeUndefined()
    expect(service.recorded.some((r) => r.path === "/elsewhere")).toBe(false)
  })

  test("oversized body → undefined (fail closed, not buffered)", async () => {
    service.setHandler(() => new Response("x".repeat(10_000), { status: 200 }))
    expect(await httpChannel({ maxBytes: 1_000 }).fetch(REF)).toBeUndefined()
  })

  test("timeout → undefined", async () => {
    service.setHandler(async () => {
      await new Promise((r) => setTimeout(r, 300))
      return Response.json(VALID_RESOLUTION)
    })
    expect(await httpChannel({ timeoutMs: 40 }).fetch(REF)).toBeUndefined()
  })

  test("stalled body (headers sent, body hangs) → undefined within the timeout", async () => {
    // The server returns 200 headers, then never enqueues or closes the body.
    // The timeout must cover the body read — not just the header fetch — or the
    // channel hangs forever (a hostile service could pin a held tool open). The
    // test would itself time out if the deadline didn't reach the body read.
    service.setHandler(
      () =>
        new Response(
          new ReadableStream({
            start() {
              /* never enqueue, never close — the body stalls */
            },
          }),
          { status: 200 },
        ),
    )
    const started = Date.now()
    expect(await httpChannel({ timeoutMs: 60 }).fetch(REF)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("bearer token is injected as Authorization and never returned", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    const got = await httpChannel({ token: "s3cret-token-value" }).fetch(REF)
    expect(service.recorded.at(-1)?.authorization).toBe("Bearer s3cret-token-value")
    expect(JSON.stringify(got)).not.toContain("s3cret-token-value")
  })

  test("an async token resolver is honored", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    const channel = new HttpApprovalChannel({
      endpoint: new URL(service.base),
      token: async () => "resolved-async-token",
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
    })
    await channel.fetch(REF)
    expect(service.recorded.at(-1)?.authorization).toBe("Bearer resolved-async-token")
  })

  test("a configured token that FAILS to resolve fails closed — no unauthenticated request", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    const channel = new HttpApprovalChannel({
      endpoint: new URL(service.base),
      token: () => {
        throw new Error("secret store unavailable")
      },
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
    })
    // The fetch must NOT be issued unauthenticated: it fails closed to undefined
    // and the server records no request at all.
    expect(await channel.fetch(REF)).toBeUndefined()
    expect(service.recorded.length).toBe(0)
  })

  test("a configured token that resolves EMPTY fails closed", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    const channel = new HttpApprovalChannel({
      endpoint: new URL(service.base),
      token: () => "",
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
    })
    expect(await channel.fetch(REF)).toBeUndefined()
    expect(service.recorded.length).toBe(0)
  })

  test("a token resolver that returns undefined at call time fails closed", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    const channel = new HttpApprovalChannel({
      endpoint: new URL(service.base),
      // A misbehaving host resolver (e.g. a naive `process.env[name]` lookup for an
      // unset var) yields undefined; the channel must NOT issue an unauthenticated
      // request for a configured credential.
      token: (() => undefined) as unknown as () => string,
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
    })
    expect(await channel.fetch(REF)).toBeUndefined()
    expect(service.recorded.length).toBe(0)
  })
})

// ─── announce / consume ─────────────────────────────────────────────────────

describe("HttpApprovalChannel.announce / consume", () => {
  test("announce POSTs the request body to /v1/approvals", async () => {
    service.recorded.length = 0
    service.setHandler(() => new Response(null, { status: 202 }))
    const request = {
      request_id: "req-1",
      action_id: "act-1",
      reason: "needs sign-off",
      required_authority: { min_trust_baseline: 0.9 },
      requested_at: "2026-01-01T00:00:00.000Z",
    }
    // ApprovalRequest is structurally compatible; the channel just serializes it.
    await httpChannel().announce(request as never)
    const post = service.recorded.at(-1)
    expect(post?.method).toBe("POST")
    expect(post?.path).toBe("/v1/approvals")
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      request_id: "req-1",
      action_id: "act-1",
    })
  })

  test("announce swallows a server error (never throws)", async () => {
    service.setHandler(() => new Response("nope", { status: 500 }))
    await expect(httpChannel().announce({ request_id: "r" } as never)).resolves.toBeUndefined()
  })

  test("consume DELETEs the resolution path", async () => {
    service.recorded.length = 0
    service.setHandler(() => new Response(null, { status: 204 }))
    await httpChannel().consume(REF)
    const del = service.recorded.at(-1)
    expect(del?.method).toBe("DELETE")
    expect(del?.path).toBe("/v1/approvals/proj/req-1")
  })
})

// ─── FileApprovalChannel ────────────────────────────────────────────────────

describe("FileApprovalChannel", () => {
  test("round-trips the real .approvals/ file primitives, then consumes", async () => {
    const root = await mkdtemp(join(tmpdir(), "lodestar-approval-channel-"))
    try {
      await writeApprovalResolution(root, REF.project_id, VALID_RESOLUTION)
      const channel = new FileApprovalChannel(root)
      const got = await channel.fetch(REF)
      expect(got).toEqual(VALID_RESOLUTION)
      await channel.consume(REF)
      // After consume the file is gone — fetch and the raw reader both see nothing.
      expect(await channel.fetch(REF)).toBeUndefined()
      expect(await readApprovalResolution(root, REF.project_id, REF.request_id)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ─── config guards ──────────────────────────────────────────────────────────

describe("assertChannelEndpoint", () => {
  test("accepts https", () => {
    expect(assertChannelEndpoint("https://approvals.example.com", false).protocol).toBe("https:")
  })
  test("rejects http unless allow_http", () => {
    expect(() => assertChannelEndpoint("http://127.0.0.1:8080", false)).toThrow(/scheme/)
    expect(assertChannelEndpoint("http://127.0.0.1:8080", true).protocol).toBe("http:")
  })
  test("rejects file:// and unparseable endpoints", () => {
    expect(() => assertChannelEndpoint("file:///etc/passwd", true)).toThrow(/scheme/)
    expect(() => assertChannelEndpoint("not a url", true)).toThrow(/valid URL/)
  })
  test("rejects an endpoint carrying a query or fragment (it would break the route)", () => {
    expect(() => assertChannelEndpoint("https://host/api?tenant=x", false)).toThrow(
      /query or fragment/,
    )
    expect(() => assertChannelEndpoint("https://host/api#frag", false)).toThrow(/query or fragment/)
  })
})

describe("httpChannelForbidsUnsigned", () => {
  test("file channel (or unset) is always ok", () => {
    expect(httpChannelForbidsUnsigned({}).ok).toBe(true)
    expect(httpChannelForbidsUnsigned({ channel: { kind: "file" } }).ok).toBe(true)
  })
  test("http channel with no pinned key is rejected", () => {
    const r = httpChannelForbidsUnsigned({ channel: { kind: "http" }, authorized_keys: [] })
    expect(r.ok).toBe(false)
  })
  test("http channel with allow_unsigned is rejected", () => {
    const r = httpChannelForbidsUnsigned({
      channel: { kind: "http" },
      authorized_keys: ["k"],
      allow_unsigned: true,
    })
    expect(r.ok).toBe(false)
  })
  test("http channel with a pinned key and no allow_unsigned is ok", () => {
    const r = httpChannelForbidsUnsigned({ channel: { kind: "http" }, authorized_keys: ["k"] })
    expect(r.ok).toBe(true)
  })
})

describe("createApprovalChannel", () => {
  test("file kind → FileApprovalChannel", () => {
    expect(createApprovalChannel({ kind: "file" }, { logRoot: "/log" })).toBeInstanceOf(
      FileApprovalChannel,
    )
  })
  test("http kind with a resolver → HttpApprovalChannel", () => {
    const channel = createApprovalChannel(
      {
        kind: "http",
        endpoint: "https://approvals.example.com",
        token_env: "TOKEN",
        allow_http: false,
        timeout_ms: 15_000,
        max_body_bytes: 64 * 1024,
        announce_sensitivity_ceiling: "internal",
      },
      { logRoot: "/log", resolveToken: () => "tok" },
    )
    expect(channel).toBeInstanceOf(HttpApprovalChannel)
  })
  test("http kind naming token_env without a resolver throws (no process.env read)", () => {
    expect(() =>
      createApprovalChannel(
        {
          kind: "http",
          endpoint: "https://approvals.example.com",
          token_env: "TOKEN",
          allow_http: false,
          timeout_ms: 15_000,
          max_body_bytes: 64 * 1024,
          announce_sensitivity_ceiling: "internal",
        },
        { logRoot: "/log" },
      ),
    ).toThrow(/token resolver/)
  })
  test("a minimal literal http config (no timeout_ms/max_body_bytes) gets working defaults", async () => {
    service.recorded.length = 0
    service.setHandler(() => Response.json(VALID_RESOLUTION))
    // A direct/library construction path may omit schema-defaulted fields. The
    // factory must apply them — otherwise an undefined timeout aborts every fetch
    // immediately. Cast a minimal literal to the config type to simulate that.
    const minimal = { kind: "http", endpoint: service.base, allow_http: true } as never
    const channel = createApprovalChannel(minimal, { logRoot: "/log" })
    expect(channel).toBeInstanceOf(HttpApprovalChannel)
    // It actually works (the default 15s timeout, not undefined→0): a real fetch
    // round-trips rather than aborting instantly.
    expect(await (channel as HttpApprovalChannel).fetch(REF)).toEqual(VALID_RESOLUTION)
  })
  test("http kind whose resolver returns undefined for a configured token_env throws (fail closed)", () => {
    expect(() =>
      createApprovalChannel(
        {
          kind: "http",
          endpoint: "https://approvals.example.com",
          token_env: "UNSET_VAR",
          allow_http: false,
          timeout_ms: 15_000,
          max_body_bytes: 64 * 1024,
          announce_sensitivity_ceiling: "internal",
        },
        // A naive env lookup for an unset variable — must not silently downgrade.
        { logRoot: "/log", resolveToken: (() => undefined) as unknown as () => string },
      ),
    ).toThrow(/must not silently downgrade/)
  })
})
