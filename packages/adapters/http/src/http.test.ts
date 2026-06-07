import { afterEach, describe, expect, test } from "bun:test"
import type { ToolContext } from "@qmilab/lodestar-action-kernel"
import { applyRedactions } from "./credentials.js"
import { makeHttpFetchTool, makeHttpRequestTool } from "./tools.js"
import { assertAllowedUrl, compileUrlPolicy, normalizeHost } from "./url.js"

const CTX: ToolContext = {
  session_id: "test-session",
  project_id: "test-project",
  actor_id: "test-actor",
  capabilities: new Map(),
}

// -----------------------------------------------------------------------------
// In-process fake HTTP server (Bun.serve) that records what it received.
// -----------------------------------------------------------------------------

interface Received {
  count: number
  method: string
  authorization: string | null
  apiKey: string | null
  body: string | null
  paths: string[]
}

interface FakeServer {
  base: string
  received: Received
  stop: () => void
}

type Handler = (req: Request, received: Received) => Response | Promise<Response>

function startServer(handler: Handler): FakeServer {
  const received: Received = {
    count: 0,
    method: "",
    authorization: null,
    apiKey: null,
    body: null,
    paths: [],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.count += 1
      received.method = req.method
      received.authorization = req.headers.get("authorization")
      received.apiKey = req.headers.get("x-api-key")
      received.paths.push(new URL(req.url).pathname)
      if (req.method !== "GET" && req.method !== "HEAD") received.body = await req.text()
      return handler(req, received)
    },
  })
  return { base: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) }
}

const servers: FakeServer[] = []
function serve(handler: Handler): FakeServer {
  const s = startServer(handler)
  servers.push(s)
  return s
}
afterEach(() => {
  while (servers.length) servers.pop()?.stop()
})

const PINNED = ["127.0.0.1"]

// -----------------------------------------------------------------------------
// url guard (pure)
// -----------------------------------------------------------------------------

describe("url guard", () => {
  test("normalizeHost reduces host:port and full URLs to a bare hostname", () => {
    expect(normalizeHost("Example.com")).toBe("example.com")
    expect(normalizeHost("example.com:8443")).toBe("example.com")
    expect(normalizeHost("https://example.com/a/b?x=1")).toBe("example.com")
    expect(normalizeHost("127.0.0.1:9000")).toBe("127.0.0.1")
  })

  test("HTTPS-only by default; a non-pinned host or http scheme is rejected", () => {
    const policy = compileUrlPolicy({ allowedHosts: ["api.example.com"] })
    expect(() => assertAllowedUrl("https://api.example.com/x", policy, "t")).not.toThrow()
    expect(() => assertAllowedUrl("https://evil.invalid/x", policy, "t")).toThrow(/not in the/)
    expect(() => assertAllowedUrl("http://api.example.com/x", policy, "t")).toThrow(/scheme/)
    expect(() => assertAllowedUrl("not-a-url", policy, "t")).toThrow(/valid absolute URL/)
  })

  test("allowHttp opts into plain http explicitly", () => {
    const policy = compileUrlPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true })
    expect(() => assertAllowedUrl("http://127.0.0.1:9/x", policy, "t")).not.toThrow()
  })
})

// -----------------------------------------------------------------------------
// http.fetch (L1 read)
// -----------------------------------------------------------------------------

describe("http.fetch", () => {
  test("reads a pinned host and returns the body as untrusted content", async () => {
    const s = serve(
      () => new Response("hello world", { headers: { "content-type": "text/plain" } }),
    )
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true })
    const out = await tool.execute({ url: `${s.base}/page` }, CTX)
    expect(out.status).toBe(200)
    expect(out.ok).toBe(true)
    expect(out.body).toBe("hello world")
    expect(out.content_type).toContain("text/plain")
    expect(s.received.paths).toContain("/page")
  })

  test("rejects a non-pinned host before any request", async () => {
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true })
    await expect(tool.execute({ url: "http://10.0.0.5/secret" }, CTX)).rejects.toThrow(
      /not in the operator-allowed hosts/,
    )
  })

  test("rejects http when allowHttp is not set (HTTPS-only default)", async () => {
    const tool = makeHttpFetchTool({ allowedHosts: PINNED })
    await expect(tool.execute({ url: "http://127.0.0.1:9/x" }, CTX)).rejects.toThrow(/scheme/)
  })

  test("caps an oversized response body and flags truncation", async () => {
    const s = serve(() => new Response("x".repeat(5000)))
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true, maxBytes: 100 })
    const out = await tool.execute({ url: `${s.base}/big` }, CTX)
    expect(out.body_truncated).toBe(true)
    expect(out.body_bytes).toBeLessThanOrEqual(100)
    expect(out.body.length).toBeLessThanOrEqual(100)
  })
})

// -----------------------------------------------------------------------------
// redirect re-validation (the HTTP-specific SSRF teeth)
// -----------------------------------------------------------------------------

describe("redirect re-validation", () => {
  test("follows a redirect to a still-pinned host", async () => {
    const dest = serve(() => new Response("final destination"))
    const start = serve(
      () => new Response(null, { status: 302, headers: { location: `${dest.base}/final` } }),
    )
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true })
    const out = await tool.execute({ url: `${start.base}/go` }, CTX)
    expect(out.body).toBe("final destination")
    expect(out.redirected).toBe(true)
    expect(out.redirect_chain.length).toBe(2)
    expect(dest.received.count).toBe(1)
  })

  test("refuses to follow a redirect to a non-pinned host", async () => {
    // The Location host (127.0.0.2) is not pinned: the guard throws BEFORE any
    // socket to it — so it need not even exist.
    const start = serve(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.2:9/evil" } }),
    )
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true })
    await expect(tool.execute({ url: `${start.base}/go` }, CTX)).rejects.toThrow(
      /not in the operator-allowed hosts/,
    )
  })
})

// -----------------------------------------------------------------------------
// credentials (operator-supplied, host-bound, redacted)
// -----------------------------------------------------------------------------

describe("credentials", () => {
  const SECRET = "Bearer super-secret-token-123"

  test("injects the operator credential and redacts it from output", async () => {
    const s = serve((_req, r) => new Response(`echo:${r.authorization}`))
    const tool = makeHttpFetchTool({
      allowedHosts: PINNED,
      allowHttp: true,
      credentials: [{ host: "127.0.0.1", header: "Authorization", value: SECRET }],
    })
    const out = await tool.execute({ url: `${s.base}/p` }, CTX)
    // The server received the operator's token...
    expect(s.received.authorization).toBe(SECRET)
    // ...but the captured output (which echoes it) is redacted.
    expect(out.body).not.toContain("super-secret-token-123")
    expect(out.body).toContain("***")
    expect(out.authenticated).toBe(true)
  })

  test("an agent-supplied credential header cannot shadow the operator's", async () => {
    const s = serve((_req, r) => new Response(`auth=${r.authorization}`))
    const tool = makeHttpFetchTool({
      allowedHosts: PINNED,
      allowHttp: true,
      credentials: [{ host: "127.0.0.1", header: "Authorization", value: SECRET }],
    })
    // The agent tries to set its own Authorization; it is dropped and the
    // operator's value reaches the server.
    await tool.execute({ url: `${s.base}/p`, headers: { Authorization: "Bearer attacker" } }, CTX)
    expect(s.received.authorization).toBe(SECRET)
  })

  test("a resolver function is invoked per request", async () => {
    let calls = 0
    const s = serve((_req, r) => new Response(`key=${r.apiKey}`))
    const tool = makeHttpFetchTool({
      allowedHosts: PINNED,
      allowHttp: true,
      credentials: [
        {
          host: "127.0.0.1",
          header: "X-Api-Key",
          value: () => {
            calls += 1
            return "resolved-key"
          },
        },
      ],
    })
    await tool.execute({ url: `${s.base}/a` }, CTX)
    expect(s.received.apiKey).toBe("resolved-key")
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  test("applyRedactions replaces every occurrence", () => {
    expect(applyRedactions("a tok b tok c", ["tok"])).toBe("a *** b *** c")
  })
})

// -----------------------------------------------------------------------------
// http.request (L4 egress)
// -----------------------------------------------------------------------------

describe("http.request", () => {
  test("sends a POST body to a pinned host", async () => {
    const s = serve(() => new Response("ok"))
    const tool = makeHttpRequestTool({ allowedHosts: PINNED, allowHttp: true })
    const out = await tool.execute({ url: `${s.base}/submit`, body: '{"hi":true}' }, CTX)
    expect(out.status).toBe(200)
    expect(s.received.method).toBe("POST")
    expect(s.received.body).toBe('{"hi":true}')
  })

  test("rejects a method outside the operator allowlist", async () => {
    const tool = makeHttpRequestTool({
      allowedHosts: PINNED,
      allowHttp: true,
      allowedMethods: ["POST"],
    })
    await expect(
      tool.execute({ url: "http://127.0.0.1:9/x", method: "DELETE" }, CTX),
    ).rejects.toThrow(/not in the operator-allowed methods/)
  })

  test("declares the L4 egress contract", () => {
    const tool = makeHttpRequestTool({ allowedHosts: PINNED })
    expect(tool.required_trust_level).toBe(4)
    expect(tool.reversibility).toBe("irreversible")
    expect(tool.sandbox).toBe("controlled-network")
    expect(tool.permissions).toContain("network.egress")
    expect(tool.effects.some((e) => e.kind === "publication")).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// timeout (bounded capture)
// -----------------------------------------------------------------------------

describe("timeout", () => {
  test("aborts a slow request at the wall-clock deadline", async () => {
    const s = serve(async () => {
      await Bun.sleep(3000)
      return new Response("too late")
    })
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true, timeoutMs: 80 })
    await expect(tool.execute({ url: `${s.base}/slow` }, CTX)).rejects.toThrow(/timed out/)
  })
})
