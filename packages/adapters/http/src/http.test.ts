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

  test("redacts a credential echoed into a redirect Location", async () => {
    // A token with no spaces so it survives verbatim in a URL query.
    const TOKEN = "sk_live_redirectleak_0099"
    const dest = serve(() => new Response("landed"))
    const start = serve(
      (req) =>
        new Response(null, {
          status: 302,
          headers: { location: `${dest.base}/cb?token=${req.headers.get("authorization") ?? ""}` },
        }),
    )
    const tool = makeHttpFetchTool({
      allowedHosts: PINNED,
      allowHttp: true,
      credentials: [{ host: "127.0.0.1", header: "Authorization", value: TOKEN }],
    })
    const out = await tool.execute({ url: `${start.base}/go` }, CTX)
    // The credential reached the host and was echoed into the redirect URL...
    expect(start.received.authorization).toBe(TOKEN)
    // ...but neither the final URL nor the redirect chain leaks it.
    expect(out.url).not.toContain(TOKEN)
    expect(out.url).toContain("***")
    expect(out.redirect_chain.join("|")).not.toContain(TOKEN)
  })

  test("does not inject a second host's credential on a cross-host redirect", async () => {
    // One loopback server addressed as two distinct pinned hosts. A request to
    // 127.0.0.1 redirects to `localhost`; the localhost credential must NOT be
    // injected on a target the first host chose (a confused-deputy guard).
    const TOKEN_A = "tok_host_a_111"
    const TOKEN_B = "tok_host_b_222"
    const seen: { path: string; auth: string | null }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url)
        seen.push({ path: u.pathname, auth: req.headers.get("authorization") })
        if (u.pathname === "/start") {
          return new Response(null, {
            status: 302,
            headers: { location: `http://localhost:${u.port}/landed` },
          })
        }
        return new Response("landed")
      },
    })
    try {
      const tool = makeHttpFetchTool({
        allowedHosts: ["127.0.0.1", "localhost"],
        allowHttp: true,
        credentials: [
          { host: "127.0.0.1", header: "Authorization", value: TOKEN_A },
          { host: "localhost", header: "Authorization", value: TOKEN_B },
        ],
      })
      await tool.execute({ url: `http://127.0.0.1:${server.port}/start` }, CTX)
      expect(seen.find((s) => s.path === "/start")?.auth).toBe(TOKEN_A)
      // cross-host redirect: the localhost credential is NOT injected.
      expect(seen.find((s) => s.path === "/landed")?.auth).toBeNull()
    } finally {
      server.stop(true)
    }
  })

  test("preserves HEAD across a 301/302/303 redirect (no silent GET downgrade)", async () => {
    const dest = serve(() => new Response("body"))
    const start = serve(
      () => new Response(null, { status: 302, headers: { location: `${dest.base}/d` } }),
    )
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true })
    await tool.execute({ url: `${start.base}/go`, method: "HEAD" }, CTX)
    expect(dest.received.method).toBe("HEAD")
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
// fetch header allowlist — an L1 read is not an arbitrary-header egress channel
// -----------------------------------------------------------------------------

describe("fetch header allowlist", () => {
  // The servers echo the headers they saw into the response body, so the
  // assertions read `out.body` rather than a closure-mutated capture variable.
  test("drops a non-allowlisted agent header by default (no L1 egress channel)", async () => {
    const s = serve((req) => new Response(`exfil=${req.headers.get("x-exfil")}`))
    const tool = makeHttpFetchTool({ allowedHosts: PINNED, allowHttp: true })
    const out = await tool.execute(
      { url: `${s.base}/p`, headers: { "X-Exfil": "stolen-bytes" } },
      CTX,
    )
    expect(out.body).toBe("exfil=null") // the agent header never left the process
  })

  test("sends only operator-allowlisted header names", async () => {
    const s = serve(
      (req) =>
        new Response(`accept=${req.headers.get("accept")};exfil=${req.headers.get("x-exfil")}`),
    )
    const tool = makeHttpFetchTool({
      allowedHosts: PINNED,
      allowHttp: true,
      allowedRequestHeaders: ["Accept"],
    })
    const out = await tool.execute(
      { url: `${s.base}/p`, headers: { Accept: "application/json", "X-Exfil": "stolen" } },
      CTX,
    )
    expect(out.body).toContain("accept=application/json") // allowlisted name passes
    expect(out.body).toContain("exfil=null") // a non-allowlisted name is still dropped
  })

  test("http.request (L4, human-approved) is not header-name restricted", async () => {
    const s = serve((req) => new Response(`custom=${req.headers.get("x-custom")}`))
    const tool = makeHttpRequestTool({ allowedHosts: PINNED, allowHttp: true })
    const out = await tool.execute(
      { url: `${s.base}/p`, body: "{}", headers: { "X-Custom": "v1" } },
      CTX,
    )
    expect(out.body).toBe("custom=v1")
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
