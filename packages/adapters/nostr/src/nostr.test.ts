import { describe, expect, test } from "bun:test"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import type { ToolContext } from "@qmilab/lodestar-action-kernel"
import { type NostrCredential, prepareSigner } from "./credentials.js"
import {
  computeEventId,
  decodeBech32,
  noteIdFromHex,
  npubFromHex,
  serializeEvent,
  signEvent,
  verifyEvent,
} from "./event.js"
import { applyRedactions, fetchFromRelay } from "./relay.js"
import { makeNostrFetchTool, makeNostrPublishTool } from "./tools.js"

// A throwaway-but-valid secret key for tests (NOT a real identity).
const TEST_SK_HEX = "0000000000000000000000000000000000000000000000000000000000000001"
const TEST_SK = hexToBytes(TEST_SK_HEX)
// BIP-340 x-only public key for secret key = 1 is the curve generator's
// x-coordinate. This is a fixed, independently-known vector: if it matches, the
// curve, the key handling, and the x-only encoding are all correct.
const GENERATOR_X = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"

const CTX: ToolContext = {
  session_id: "test-session",
  project_id: "test-project",
  actor_id: "test-actor",
  capabilities: new Map(),
}

// -----------------------------------------------------------------------------
// In-process fake relay (Bun WebSocket server) speaking enough of NIP-01/42.
// -----------------------------------------------------------------------------

interface FakeRelayOptions {
  requireAuth?: boolean
  /** With requireAuth: stay SILENT on a pre-auth EVENT (no auth-required OK) —
   * the relay gates EVENT on the connect-time challenge and waits for AUTH. */
  silentUntilAuth?: boolean
  storedEvents?: unknown[]
}

interface FakeRelay {
  url: string
  received: { notes: unknown[]; authEvents: unknown[]; raw: string[] }
  stop: () => void
}

function startRelay(opts: FakeRelayOptions = {}): FakeRelay {
  const received = { notes: [] as unknown[], authEvents: [] as unknown[], raw: [] as string[] }
  const server = Bun.serve<{ authed: boolean }>({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { authed: false } })) return undefined
      return new Response("nostr relay", { status: 200 })
    },
    websocket: {
      open(ws) {
        if (opts.requireAuth) ws.send(JSON.stringify(["AUTH", "challenge-xyz"]))
      },
      message(ws, raw) {
        const text = String(raw)
        received.raw.push(text)
        const frame = JSON.parse(text)
        const type = frame[0]
        if (type === "EVENT") {
          const ev = frame[1]
          if (opts.requireAuth && !ws.data.authed) {
            if (opts.silentUntilAuth) return // gate on the connect-time challenge; no ack
            ws.send(JSON.stringify(["OK", ev.id, false, "auth-required: authenticate first"]))
            return
          }
          received.notes.push(ev)
          ws.send(JSON.stringify(["OK", ev.id, true, ""]))
        } else if (type === "AUTH") {
          const ev = frame[1]
          received.authEvents.push(ev)
          ws.data.authed = true
          ws.send(JSON.stringify(["OK", ev.id, true, ""]))
        } else if (type === "REQ") {
          const subId = frame[1]
          for (const e of opts.storedEvents ?? []) {
            ws.send(JSON.stringify(["EVENT", subId, e]))
          }
          ws.send(JSON.stringify(["EOSE", subId]))
        }
      },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) }
}

// -----------------------------------------------------------------------------
// Crypto + serialization (NIP-01)
// -----------------------------------------------------------------------------

describe("event crypto (NIP-01 / BIP-340)", () => {
  test("x-only pubkey for sk=1 is the generator x-coordinate (known vector)", () => {
    const ev = signEvent(TEST_SK, { created_at: 1, kind: 1, tags: [], content: "x" })
    expect(ev.pubkey).toBe(GENERATOR_X)
  })

  test("serialization is the exact NIP-01 array form", () => {
    const unsigned = {
      pubkey: GENERATOR_X,
      created_at: 1700000000,
      kind: 1,
      tags: [["t", "nostr"]],
      content: 'hi "there"\nline2',
    }
    expect(serializeEvent(unsigned)).toBe(
      `[0,"${GENERATOR_X}",1700000000,1,[["t","nostr"]],"hi \\"there\\"\\nline2"]`,
    )
  })

  test("sign → verify roundtrip; id 64-hex, sig 128-hex", () => {
    const ev = signEvent(TEST_SK, { created_at: 1700000000, kind: 1, tags: [], content: "hello" })
    expect(ev.id).toMatch(/^[0-9a-f]{64}$/)
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/)
    expect(verifyEvent(ev)).toBe(true)
  })

  test("event id is deterministic for the same content", () => {
    const draft = { created_at: 42, kind: 1, tags: [["t", "a"]], content: "same" }
    expect(signEvent(TEST_SK, draft).id).toBe(signEvent(TEST_SK, draft).id)
  })

  test("tampered content fails verification", () => {
    const ev = signEvent(TEST_SK, { created_at: 1, kind: 1, tags: [], content: "real" })
    expect(verifyEvent({ ...ev, content: "tampered" })).toBe(false)
  })

  test("tampered signature fails verification", () => {
    const ev = signEvent(TEST_SK, { created_at: 1, kind: 1, tags: [], content: "real" })
    const flipped = `${ev.sig.slice(0, -2)}${ev.sig.endsWith("00") ? "11" : "00"}`
    expect(verifyEvent({ ...ev, sig: flipped })).toBe(false)
  })
})

describe("NIP-19 bech32", () => {
  test("note/npub round-trip back to the hex", () => {
    const idHex = computeEventId({
      pubkey: GENERATOR_X,
      created_at: 1,
      kind: 1,
      tags: [],
      content: "x",
    })
    expect(decodeBech32(noteIdFromHex(idHex))).toEqual({ prefix: "note", hex: idHex })
    expect(decodeBech32(npubFromHex(GENERATOR_X))).toEqual({ prefix: "npub", hex: GENERATOR_X })
  })
})

// -----------------------------------------------------------------------------
// Credential model
// -----------------------------------------------------------------------------

describe("credentials", () => {
  test("hex and nsec forms resolve to the same key + pubkey", async () => {
    const nsec = (() => {
      // build the nsec for TEST_SK via the same bech32 path the adapter decodes
      const { encodeBech32 } = require("./event.js") as typeof import("./event.js")
      return encodeBech32("nsec", TEST_SK_HEX)
    })()
    const fromHex = await prepareSigner({ kind: "secret-key", key: TEST_SK_HEX }).resolve()
    const fromNsec = await prepareSigner({ kind: "secret-key", key: nsec }).resolve()
    expect(fromHex.pubkey).toBe(GENERATOR_X)
    expect(fromNsec.pubkey).toBe(GENERATOR_X)
    expect(bytesToHex(fromNsec.secretKey)).toBe(TEST_SK_HEX)
  })

  test("redactions cover the supplied key in every form", async () => {
    const resolved = await prepareSigner({ kind: "secret-key", key: TEST_SK_HEX }).resolve()
    expect(resolved.redactions).toContain(TEST_SK_HEX)
  })

  test("resolver function is honoured", async () => {
    const resolved = await prepareSigner({
      kind: "secret-key",
      key: async () => TEST_SK_HEX,
    }).resolve()
    expect(resolved.pubkey).toBe(GENERATOR_X)
  })

  test("rejects a malformed key", async () => {
    await expect(
      prepareSigner({ kind: "secret-key", key: "not-a-key" }).resolve(),
    ).rejects.toThrow()
  })

  test("applyRedactions redacts the longest of overlapping secrets first", () => {
    // A shorter secret that is a substring of a longer one (e.g. a trimmed key
    // inside its untrimmed form) must not be replaced first, or the longer
    // secret's unique remainder would survive. Longest-first is order-independent.
    expect(applyRedactions("secret-extra-private", ["secret", "secret-extra-private"])).toBe("***")
    expect(applyRedactions("secret-extra-private", ["secret-extra-private", "secret"])).toBe("***")
  })

  test("applyRedactions skips empty strings", () => {
    expect(applyRedactions("abc", ["", "abc"])).toBe("***")
  })

  test("applyRedactions scrubs the actual resolved key (hex + nsec forms)", async () => {
    // Drive the real toSecretKey-derived redaction set: an nsec input yields the
    // nsec string AND the decoded hex; both must be scrubbed from captured output.
    const { encodeBech32 } = require("./event.js") as typeof import("./event.js")
    const nsec = encodeBech32("nsec", TEST_SK_HEX)
    const resolved = await prepareSigner({ kind: "secret-key", key: nsec }).resolve()
    const echoed = `relay closed: saw key ${TEST_SK_HEX} (${nsec})`
    const out = applyRedactions(echoed, resolved.redactions)
    expect(out).not.toContain(TEST_SK_HEX)
    expect(out).not.toContain(nsec)
  })
})

// -----------------------------------------------------------------------------
// nostr.publish (egress)
// -----------------------------------------------------------------------------

describe("nostr.publish", () => {
  const credential: NostrCredential = { kind: "secret-key", key: TEST_SK_HEX }

  test("publishes a signed, verifiable note and reports per-relay OK", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential })
      const out = await tool.execute({ content: "governed note" }, CTX)
      expect(out.published).toBe(true)
      expect(out.relay_results[0]?.accepted).toBe(true)
      expect(out.pubkey).toBe(GENERATOR_X)
      // The relay received exactly one note, and it verifies.
      expect(relay.received.notes.length).toBe(1)
      // biome-ignore lint/suspicious/noExplicitAny: test introspection of the wire event
      expect(verifyEvent(relay.received.notes[0] as any)).toBe(true)
    } finally {
      relay.stop()
    }
  })

  test("relay pinning: a non-pinned target is rejected before any send", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential })
      await expect(
        tool.execute({ content: "x", relays: ["ws://evil.invalid"] }, CTX),
      ).rejects.toThrow(/not in the operator-pinned relays/)
      expect(relay.received.raw.length).toBe(0)
    } finally {
      relay.stop()
    }
  })

  test("kind allowlist: a non-allowed kind is rejected", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential, allowedKinds: [1] })
      await expect(tool.execute({ content: "delete", kind: 5 }, CTX)).rejects.toThrow(
        /kind 5 is not in the operator-allowed kinds/,
      )
    } finally {
      relay.stop()
    }
  })

  test("the secret key never appears in the output or on the wire", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential })
      const out = await tool.execute({ content: "secret-safe" }, CTX)
      expect(JSON.stringify(out)).not.toContain(TEST_SK_HEX)
      expect(relay.received.raw.join("\n")).not.toContain(TEST_SK_HEX)
    } finally {
      relay.stop()
    }
  })

  test("NIP-42 AUTH: authenticates with the same key on auth-required, then publishes", async () => {
    const relay = startRelay({ requireAuth: true })
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential })
      const out = await tool.execute({ content: "needs auth" }, CTX)
      expect(out.published).toBe(true)
      expect(out.relay_results[0]?.authenticated).toBe(true)
      // The relay saw one auth event: kind 22242, correct tags, and it verifies.
      expect(relay.received.authEvents.length).toBe(1)
      // biome-ignore lint/suspicious/noExplicitAny: test introspection of the wire event
      const auth = relay.received.authEvents[0] as any
      expect(auth.kind).toBe(22242)
      expect(verifyEvent(auth)).toBe(true)
      expect(auth.tags).toContainEqual(["relay", relay.url])
      expect(auth.tags).toContainEqual(["challenge", "challenge-xyz"])
      expect(relay.received.notes.length).toBe(1)
    } finally {
      relay.stop()
    }
  })

  test("NIP-42 AUTH: authenticates proactively when the relay gates EVENT on a connect-time challenge", async () => {
    // The relay sends an AUTH challenge on connect and never acks the pre-auth
    // EVENT (no `auth-required` OK to react to). Without proactive auth this would
    // hang until timeout; the publish must authenticate off the challenge alone.
    const relay = startRelay({ requireAuth: true, silentUntilAuth: true })
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential })
      const out = await tool.execute({ content: "proactive auth" }, CTX)
      expect(out.published).toBe(true)
      expect(out.relay_results[0]?.authenticated).toBe(true)
      expect(relay.received.authEvents.length).toBe(1)
      expect(relay.received.notes.length).toBe(1)
    } finally {
      relay.stop()
    }
  })

  test("duplicate pinned relays are deduplicated (one socket, one publish)", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrPublishTool({ relays: [relay.url], credential })
      const out = await tool.execute({ content: "dedupe", relays: [relay.url, relay.url] }, CTX)
      expect(out.published).toBe(true)
      expect(out.relay_results.length).toBe(1) // collapsed to one target
      expect(relay.received.notes.length).toBe(1) // one socket, one EVENT
    } finally {
      relay.stop()
    }
  })
})

// -----------------------------------------------------------------------------
// nostr.fetch (untrusted inbound)
// -----------------------------------------------------------------------------

describe("nostr.fetch", () => {
  test("returns events with a correct signature_valid flag (good, forged, malformed)", async () => {
    const good = signEvent(TEST_SK, { created_at: 1, kind: 1, tags: [], content: "authentic" })
    // A forged event: valid shape, but the signature does not match the id/pubkey.
    const forged = { ...good, id: good.id, content: "forged", sig: good.sig }
    const malformed = { id: "abc", pubkey: "def" } // missing required fields
    const relay = startRelay({ storedEvents: [good, forged, malformed] })
    try {
      const tool = makeNostrFetchTool({ relays: [relay.url] })
      const out = await tool.execute({}, CTX)
      expect(out.event_count).toBe(2) // good + forged are well-shaped; malformed dropped
      expect(out.malformed_count).toBe(1)
      const authentic = out.events.find((e) => e.content === "authentic")
      const tampered = out.events.find((e) => e.content === "forged")
      expect(authentic?.signature_valid).toBe(true)
      expect(tampered?.signature_valid).toBe(false)
      expect(out.relay_results[0]?.eose).toBe(true)
    } finally {
      relay.stop()
    }
  })

  test("relay pinning (SSRF guard) applies to reads too", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrFetchTool({ relays: [relay.url] })
      await expect(tool.execute({ relays: ["ws://internal.invalid"] }, CTX)).rejects.toThrow(
        /not in the operator-pinned relays/,
      )
      expect(relay.received.raw.length).toBe(0)
    } finally {
      relay.stop()
    }
  })

  test("an oversized relay frame is dropped (not parsed/recorded) and reported truncated", async () => {
    // A single frame larger than the 256 KiB per-frame cap must be dropped before
    // JSON.parse — an untrusted relay can't exhaust memory or inflate the result.
    const huge = signEvent(TEST_SK, {
      created_at: 1,
      kind: 1,
      tags: [],
      content: "x".repeat(300 * 1024),
    })
    const relay = startRelay({ storedEvents: [huge] })
    try {
      const tool = makeNostrFetchTool({ relays: [relay.url] })
      const out = await tool.execute({}, CTX)
      expect(out.event_count).toBe(0) // the giant frame was never parsed or kept
      expect(out.truncated).toBe(true) // results are incomplete — reported honestly
    } finally {
      relay.stop()
    }
  })

  test("top-level truncated reflects a relay cut off below maxEvents by malformed drops", async () => {
    // maxEvents=2: the relay client stops after 2 raw frames (truncated). If one of
    // those is malformed and dropped, the valid count (1) never reaches maxEvents,
    // yet the fetch IS incomplete — the top-level flag must say so. (Codex P3.)
    const good = signEvent(TEST_SK, { created_at: 1, kind: 1, tags: [], content: "kept" })
    const malformed = { id: "abc", pubkey: "def" }
    const extra = signEvent(TEST_SK, { created_at: 2, kind: 1, tags: [], content: "never-reached" })
    const relay = startRelay({ storedEvents: [good, malformed, extra] })
    try {
      const tool = makeNostrFetchTool({ relays: [relay.url], maxEvents: 2 })
      const out = await tool.execute({}, CTX)
      expect(out.event_count).toBe(1) // only `good` is valid
      expect(out.malformed_count).toBe(1)
      expect(out.truncated).toBe(true) // incomplete despite valid count < maxEvents
    } finally {
      relay.stop()
    }
  })

  test("multi-relay fetch bounds the total budget across relays (not maxEvents × relays)", async () => {
    // The overall cap must be shared across relays up front, not applied only
    // after each relay buffered the full maxEvents. With 2 relays + maxEvents=2,
    // each gets a share of ceil(2/2)=1, so neither buffers the full cap. (Codex P2.)
    const mk = (c: string) => signEvent(TEST_SK, { created_at: 1, kind: 1, tags: [], content: c })
    const relayA = startRelay({ storedEvents: [mk("a1"), mk("a2"), mk("a3")] })
    const relayB = startRelay({ storedEvents: [mk("b1"), mk("b2"), mk("b3")] })
    try {
      const tool = makeNostrFetchTool({ relays: [relayA.url, relayB.url], maxEvents: 2 })
      const out = await tool.execute({}, CTX)
      expect(out.event_count).toBeLessThanOrEqual(2) // overall cap honoured
      for (const rr of out.relay_results) expect(rr.event_count).toBeLessThanOrEqual(1) // per-relay share
      expect(out.truncated).toBe(true)
    } finally {
      relayA.stop()
      relayB.stop()
    }
  })

  test("an over-broad / free-form fetch filter is rejected before anything leaves the process", async () => {
    const relay = startRelay()
    try {
      const tool = makeNostrFetchTool({ relays: [relay.url] })
      // A non-hex `authors` value would be free-form data smuggled out in the REQ.
      await expect(
        tool.execute({ filters: [{ authors: ["not-hex-payload-smuggled-out"] }] }, CTX),
      ).rejects.toThrow(/64-char hex/)
      // An over-long tag filter value is likewise rejected.
      await expect(
        tool.execute({ filters: [{ tags: { t: ["x".repeat(300)] } }] }, CTX),
      ).rejects.toThrow(/exceeds/)
      expect(relay.received.raw.length).toBe(0) // nothing was sent
    } finally {
      relay.stop()
    }
  })

  test("collection never exceeds the bound even when extra frames are already queued", async () => {
    // The relay bursts 6 events before EOSE; with maxEvents=2 the client finishes
    // at 2, and the `settled` guard must drop the queued remainder rather than
    // appending past the bound (into the already-resolved array).
    const evs = Array.from({ length: 6 }, (_, i) =>
      signEvent(TEST_SK, { created_at: i + 1, kind: 1, tags: [], content: `e${i}` }),
    )
    const relay = startRelay({ storedEvents: evs })
    try {
      const res = await fetchFromRelay(relay.url, [{ kinds: [1] }], {
        timeoutMs: 5000,
        maxEvents: 2,
        redactions: [],
      })
      expect(res.events.length).toBe(2)
      expect(res.truncated).toBe(true)
    } finally {
      relay.stop()
    }
  })
})
