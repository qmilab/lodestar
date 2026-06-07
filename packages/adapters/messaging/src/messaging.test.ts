import { afterEach, describe, expect, test } from "bun:test"
import type { ToolContext } from "@qmilab/lodestar-action-kernel"
import { applyRedactions, redactionVariants, resolveCredential } from "./credentials.js"
import {
  assertAllowedChannel,
  assertAllowedRecipients,
  compileChannelPolicy,
  compileRecipientPolicy,
  normalizeChannel,
} from "./destinations.js"
import { type EmailMessage, makeEmailSendTool, makeSlackPostTool } from "./tools.js"

const CTX: ToolContext = {
  session_id: "test-session",
  project_id: "test-project",
  actor_id: "test-actor",
  capabilities: new Map(),
}

// -----------------------------------------------------------------------------
// In-process fake provider (Bun.serve) that records what it received and lets a
// handler shape the response (Slack ok:false, oversized body, token echo, …).
// -----------------------------------------------------------------------------

interface Received {
  count: number
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

type Handler = (req: Request, body: string, received: Received) => Response | Promise<Response>

function startServer(handler: Handler): FakeServer {
  const received: Received = { count: 0, authorization: null, apiKey: null, body: null, paths: [] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text()
      received.count += 1
      received.authorization = req.headers.get("authorization")
      received.apiKey = req.headers.get("x-api-key")
      received.body = body
      received.paths.push(new URL(req.url).pathname)
      return handler(req, body, received)
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

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const BOT = { header: "Authorization", value: "Bearer xoxb-test-bot-token-9000" }
const slackOpts = (s: FakeServer, channels: string[]) => ({
  credential: BOT,
  allowedChannels: channels,
  apiBaseUrl: s.base,
  allowHttp: true,
})
const emailOpts = (s: FakeServer, recipients: string[]) => ({
  credential: { header: "Authorization", value: "Bearer re_test_email_key_42" },
  endpoint: `${s.base}/emails`,
  from: "agent@ops.example.com",
  allowedRecipients: recipients,
  allowHttp: true,
})

// -----------------------------------------------------------------------------
// destinations (pure) — the exfil guard
// -----------------------------------------------------------------------------

describe("channel allowlist", () => {
  test("normalizeChannel strips a leading # and lowercases", () => {
    expect(normalizeChannel("#General")).toBe("general")
    expect(normalizeChannel("alerts")).toBe("alerts")
    expect(normalizeChannel("  #Ops  ")).toBe("ops")
  })

  test("matches format-insensitively and sends the operator's canonical form", () => {
    const policy = compileChannelPolicy(["#alerts", "C0123ABC"])
    expect(assertAllowedChannel("alerts", policy, "t")).toBe("#alerts")
    expect(assertAllowedChannel("#ALERTS", policy, "t")).toBe("#alerts")
    expect(assertAllowedChannel("c0123abc", policy, "t")).toBe("C0123ABC")
  })

  test("rejects a non-pinned channel", () => {
    const policy = compileChannelPolicy(["#alerts"])
    expect(() => assertAllowedChannel("#random", policy, "t")).toThrow(
      /not in the operator-allowed/,
    )
  })
})

describe("recipient allowlist", () => {
  test("allows an exact address", () => {
    const policy = compileRecipientPolicy(["ops@company.com"])
    expect(assertAllowedRecipients(["ops@company.com"], policy, "t")).toEqual(["ops@company.com"])
    expect(assertAllowedRecipients(["OPS@Company.com"], policy, "t")).toEqual(["OPS@Company.com"])
  })

  test("allows any address under an allowlisted domain (@co or bare co)", () => {
    const policy = compileRecipientPolicy(["@company.com", "team.example"])
    expect(() => assertAllowedRecipients(["alice@company.com"], policy, "t")).not.toThrow()
    expect(() => assertAllowedRecipients(["bob@team.example"], policy, "t")).not.toThrow()
  })

  test("rejects an off-allowlist recipient — the exfil guard", () => {
    const policy = compileRecipientPolicy(["@company.com"])
    expect(() => assertAllowedRecipients(["attacker@evil.com"], policy, "t")).toThrow(
      /not operator-allowed/,
    )
  })

  test("a single bad recipient fails the whole list", () => {
    const policy = compileRecipientPolicy(["@company.com"])
    expect(() =>
      assertAllowedRecipients(["alice@company.com", "attacker@evil.com"], policy, "t"),
    ).toThrow(/not operator-allowed/)
  })

  test("rejects a malformed address", () => {
    const policy = compileRecipientPolicy(["@company.com"])
    expect(() => assertAllowedRecipients(["not-an-email"], policy, "t")).toThrow(/not a valid/)
  })

  test("rejects a comma-separated address string (multi-address exfil bypass)", () => {
    // The last `@`'s domain (company.com) is allowlisted, but the string also
    // carries attacker@evil.com — a provider that splits on the comma would
    // deliver to it. A single recipient must be one clean mailbox.
    const policy = compileRecipientPolicy(["@company.com"])
    expect(() =>
      assertAllowedRecipients(["attacker@evil.com, alice@company.com"], policy, "t"),
    ).toThrow(/not a valid single email/)
  })

  test("rejects display-name / angle-bracket and multi-@ recipient syntax", () => {
    const policy = compileRecipientPolicy(["@company.com"])
    expect(() => assertAllowedRecipients(['"Alice" <alice@company.com>'], policy, "t")).toThrow(
      /not a valid single email/,
    )
    expect(() => assertAllowedRecipients(["a@evil.com@company.com"], policy, "t")).toThrow(
      /not a valid single email/,
    )
  })
})

// -----------------------------------------------------------------------------
// credentials
// -----------------------------------------------------------------------------

describe("credentials", () => {
  test("applyRedactions replaces every occurrence", () => {
    expect(applyRedactions("a tok b tok c", ["tok"])).toBe("a *** b *** c")
  })

  test("applyRedactions redacts the longest of overlapping secrets first", () => {
    // "secret" is a prefix of "secret-extra-private"; insertion-order replacement
    // would leave "-extra-private". Longest-first replaces the whole token,
    // order-independently.
    expect(applyRedactions("secret-extra-private", ["secret", "secret-extra-private"])).toBe("***")
    expect(applyRedactions("secret-extra-private", ["secret-extra-private", "secret"])).toBe("***")
  })

  test("redactionVariants includes URL-encoded forms", () => {
    const v = redactionVariants("Bearer abc def")
    expect(v).toContain("Bearer abc def")
    expect(v).toContain("Bearer%20abc%20def")
  })

  test("redactionVariants also covers the bare token after a scheme prefix", () => {
    // A provider can echo just the token, not the whole `Bearer <token>` header.
    const v = redactionVariants("Bearer xoxb-abc-123-secret")
    expect(v).toContain("Bearer xoxb-abc-123-secret")
    expect(v).toContain("xoxb-abc-123-secret")
  })

  test("redactionVariants covers lowercase percent-escape re-encodings", () => {
    const v = redactionVariants("Bearer a/b c") // encodeURIComponent → %2F (upper)
    expect(v.some((x) => x.includes("%2f"))).toBe(true) // lowercase variant present
  })

  test("redactionVariants redacts the WHOLE token after the scheme (incl. spaces)", () => {
    // A multi-word token: the entire portion after `Bearer ` must redact, not just
    // its last whitespace segment.
    const v = redactionVariants("Bearer foo bar-secret")
    expect(v).toContain("foo bar-secret")
  })

  test("resolveCredential never propagates a throwing resolver's (secret-bearing) message", async () => {
    // The resolver fails with a message embedding the secret; we never obtained the
    // value, so cannot redact it — the error must be generic, not passed through.
    const cred = {
      header: "Authorization",
      value: () => {
        throw new Error("vault echoed xoxb-leaked-in-resolver-error")
      },
    }
    let msg = "NO ERROR"
    try {
      await resolveCredential(cred)
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).not.toBe("NO ERROR")
    expect(msg).not.toContain("xoxb-leaked-in-resolver-error")
    expect(msg).toBe("credential resolution failed")
  })
})

// -----------------------------------------------------------------------------
// slack.post (L4 egress)
// -----------------------------------------------------------------------------

describe("slack.post", () => {
  test("posts to a pinned channel and reports the provider message id", async () => {
    const s = serve(() => json({ ok: true, ts: "1700000000.000100" }))
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    const out = await tool.execute({ channel: "#alerts", text: "build is green" }, CTX)
    expect(out.delivered).toBe(true)
    expect(out.transport).toBe("slack")
    expect(out.message_id).toBe("1700000000.000100")
    expect(s.received.paths).toContain("/api/chat.postMessage")
    const sent = JSON.parse(s.received.body ?? "{}")
    expect(sent.channel).toBe("#alerts")
    expect(sent.text).toBe("build is green")
  })

  test("rejects a non-pinned channel before any request (exfil guard)", async () => {
    const s = serve(() => json({ ok: true, ts: "1.1" }))
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    await expect(tool.execute({ channel: "#secret-exfil", text: "data" }, CTX)).rejects.toThrow(
      /not in the operator-allowed channels/,
    )
    expect(s.received.count).toBe(0) // never reached the provider
  })

  test("a Slack ok:false (HTTP 200) is a delivery FAILURE", async () => {
    const s = serve(() => json({ ok: false, error: "channel_not_found" }))
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    await expect(tool.execute({ channel: "#alerts", text: "x" }, CTX)).rejects.toThrow(
      /delivery failed.*channel_not_found/,
    )
  })

  test("an unparseable HTTP 200 is a delivery FAILURE (no silent delivered)", async () => {
    // A 2xx with a non-JSON (or truncated) body cannot confirm ok:true, so it must
    // fail rather than silently report delivery.
    const s = serve(() => new Response("not json", { status: 200 }))
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    await expect(tool.execute({ channel: "#alerts", text: "x" }, CTX)).rejects.toThrow(
      /delivery failed/,
    )
  })

  test("redacts a bare-token echo (provider reflects just the token, no scheme)", async () => {
    const bareToken = "xoxb-test-bot-token-9000"
    const s = serve((req) =>
      json({
        ok: true,
        ts: "1.3",
        leaked: (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, ""),
      }),
    )
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    const out = await tool.execute({ channel: "#alerts", text: "hi" }, CTX)
    expect(out.response_excerpt).not.toContain(bareToken)
    expect(out.response_excerpt).toContain("***")
  })

  test("injects the bot token and redacts it from captured output", async () => {
    // The provider echoes the auth header into its JSON response — it must be
    // redacted before it reaches the output.
    const s = serve((_req, _body, r) => json({ ok: true, ts: "1.2", debug: r.authorization }))
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    const out = await tool.execute({ channel: "#alerts", text: "hi" }, CTX)
    expect(s.received.authorization).toBe(BOT.value) // provider saw the real token
    expect(out.response_excerpt).not.toContain("xoxb-test-bot-token-9000")
    expect(out.response_excerpt).toContain("***")
    expect(out.authenticated).toBe(true)
  })

  test("declares the L4 egress contract", () => {
    const s = serve(() => json({ ok: true }))
    const tool = makeSlackPostTool(slackOpts(s, ["#alerts"]))
    expect(tool.required_trust_level).toBe(4)
    expect(tool.reversibility).toBe("irreversible")
    expect(tool.sandbox).toBe("controlled-network")
    expect(tool.permissions).toContain("network.egress")
    expect(tool.effects.some((e) => e.kind === "publication")).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// email.send (L4 egress)
// -----------------------------------------------------------------------------

describe("email.send", () => {
  test("sends to an allowlisted recipient with the operator-fixed From", async () => {
    const s = serve(() => json({ id: "email_abc123" }, 200))
    const tool = makeEmailSendTool(emailOpts(s, ["@company.com"]))
    const out = await tool.execute({ to: "alice@company.com", subject: "hi", body: "hello" }, CTX)
    expect(out.delivered).toBe(true)
    expect(out.message_id).toBe("email_abc123")
    const sent = JSON.parse(s.received.body ?? "{}")
    expect(sent.from).toBe("agent@ops.example.com") // operator-fixed, NOT agent-chosen
    expect(sent.to).toEqual(["alice@company.com"])
    expect(sent.subject).toBe("hi")
    expect(sent.text).toBe("hello")
  })

  test("rejects an off-allowlist recipient (exfil guard) before any request", async () => {
    const s = serve(() => json({ id: "x" }))
    const tool = makeEmailSendTool(emailOpts(s, ["@company.com"]))
    await expect(
      tool.execute({ to: "attacker@evil.com", subject: "secrets", body: "..." }, CTX),
    ).rejects.toThrow(/not operator-allowed/)
    expect(s.received.count).toBe(0)
  })

  test("a non-2xx provider status is a delivery FAILURE", async () => {
    const s = serve(() => json({ message: "unauthorized" }, 401))
    const tool = makeEmailSendTool(emailOpts(s, ["@company.com"]))
    await expect(
      tool.execute({ to: "alice@company.com", subject: "x", body: "y" }, CTX),
    ).rejects.toThrow(/delivery failed \(status 401\)/)
  })

  test("honours a custom buildPayload (provider-agnostic shape)", async () => {
    const s = serve(() => json({ id: "sg_1" }))
    const calls: EmailMessage[] = []
    const tool = makeEmailSendTool({
      ...emailOpts(s, ["@company.com"]),
      buildPayload: (msg) => {
        calls.push(msg)
        return { personalizations: [{ to: msg.to }], from: { email: msg.from } }
      },
    })
    await tool.execute({ to: "alice@company.com", subject: "s", body: "b" }, CTX)
    const sent = JSON.parse(s.received.body ?? "{}")
    expect(sent.personalizations[0].to).toEqual(["alice@company.com"])
    expect(calls[0]?.from).toBe("agent@ops.example.com")
  })

  test("caps an oversized provider response and still reports delivered", async () => {
    // A 2xx with a huge body: delivered stays true (we got a 2xx), and the
    // captured excerpt is bounded + flagged truncated.
    const s = serve(() => new Response("X".repeat(50_000), { status: 200 }))
    const tool = makeEmailSendTool({ ...emailOpts(s, ["@company.com"]), maxBytes: 1024 })
    const out = await tool.execute({ to: "alice@company.com", subject: "s", body: "b" }, CTX)
    expect(out.delivered).toBe(true)
    expect(out.response_truncated).toBe(true)
    expect(out.response_excerpt.length).toBeLessThanOrEqual(1024)
  })

  test("a credential straddling the cap boundary leaves no partial-token prefix", async () => {
    // A hostile provider echoes the token positioned so the byte cap cuts THROUGH
    // it. If the cap were applied before redaction, a prefix ("xoxb-…") would
    // survive; redaction now runs on a window that reads past the cap first.
    const token = "xoxb-test-bot-token-9000"
    const maxBytes = 64
    const pad = "A".repeat(maxBytes - 5) // the boundary lands 5 chars into the token
    const s = serve(() => new Response(pad + token + "B".repeat(300), { status: 200 }))
    const tool = makeEmailSendTool({
      ...emailOpts(s, ["@company.com"]),
      credential: { header: "Authorization", value: `Bearer ${token}` },
      maxBytes,
    })
    const out = await tool.execute({ to: "alice@company.com", subject: "s", body: "b" }, CTX)
    expect(out.response_truncated).toBe(true)
    expect(out.response_excerpt).not.toContain("xoxb") // not even a prefix survives
    expect(out.response_excerpt).toContain("***")
    expect(Buffer.byteLength(out.response_excerpt, "utf8")).toBeLessThanOrEqual(maxBytes)
  })

  test("bounds the captured response by BYTES (UTF-8 safe), not chars", async () => {
    // The cap is a byte cap. maxBytes=63 is odd vs the 2-byte "é" so the cut lands
    // mid-sequence — it must back up to a char boundary, not emit a U+FFFD that
    // overshoots the cap.
    const maxBytes = 63
    const s = serve(() => new Response("é".repeat(500), { status: 200 }))
    const tool = makeEmailSendTool({ ...emailOpts(s, ["@company.com"]), maxBytes })
    const out = await tool.execute({ to: "alice@company.com", subject: "s", body: "b" }, CTX)
    expect(out.response_truncated).toBe(true)
    expect(Buffer.byteLength(out.response_excerpt, "utf8")).toBeLessThanOrEqual(maxBytes)
    expect(out.response_excerpt).not.toContain("�") // cut on a char boundary
  })
})

// -----------------------------------------------------------------------------
// transport — no redirect following, bounded by the wall-clock deadline
// -----------------------------------------------------------------------------

describe("transport", () => {
  test("refuses to follow a provider redirect (not the SSRF escape)", async () => {
    const s = serve(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.2:9/evil" } }),
    )
    const tool = makeEmailSendTool(emailOpts(s, ["@company.com"]))
    await expect(
      tool.execute({ to: "alice@company.com", subject: "s", body: "b" }, CTX),
    ).rejects.toThrow(/redirect, which is not followed/)
  })

  test("aborts a slow send at the wall-clock deadline", async () => {
    const s = serve(async () => {
      await Bun.sleep(3000)
      return json({ ok: true })
    })
    const tool = makeSlackPostTool({ ...slackOpts(s, ["#alerts"]), timeoutMs: 80 })
    await expect(tool.execute({ channel: "#alerts", text: "x" }, CTX)).rejects.toThrow(/timed out/)
  })

  test("the wall-clock deadline also covers a hung credential resolver", async () => {
    const s = serve(() => json({ ok: true, ts: "1" }))
    const tool = makeSlackPostTool({
      ...slackOpts(s, ["#alerts"]),
      credential: { header: "Authorization", value: () => new Promise<string>(() => {}) },
      timeoutMs: 80,
    })
    await expect(tool.execute({ channel: "#alerts", text: "x" }, CTX)).rejects.toThrow(/timed out/)
  })
})
