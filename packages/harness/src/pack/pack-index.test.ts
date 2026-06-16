import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PACK_INDEX_SPEC_VERSION,
  type PackIndex,
  generateEd25519KeyPair,
  signPackIndex,
} from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { fetchPackIndex, loadPackIndex, searchPackIndexes } from "./pack-index.js"

const AT = "2026-01-01T00:00:00.000Z"
const PUBLISHER = "acme-index"
const publisher = generateEd25519KeyPair()
const pinned = [{ actor_id: PUBLISHER, public_key: publisher.publicKeyPem }]

function unsignedIndex(): PackIndex {
  return {
    index_version: PACK_INDEX_SPEC_VERSION,
    description: "demo index",
    packs: [
      {
        name: "core-pack",
        version: "1.0.0",
        source: { type: "git", url: "https://example.test/core.git", commit: "a".repeat(40) },
        author_id: "acme",
        description: "core safety probes",
        coverage_areas: ["pack_registry", "memory_firewall"],
        invariants: ["index_signature_required"],
      },
      {
        name: "net-pack",
        version: "2.1.0",
        source: { type: "git", url: "https://example.test/net.git", commit: "b".repeat(40) },
        coverage_areas: ["egress"],
        invariants: ["ssrf_guard"],
      },
    ],
  }
}

function sign(index: PackIndex): PackIndex {
  return {
    ...index,
    publisher_id: PUBLISHER,
    generated_at: AT,
    signature: signPackIndex(
      { ...index, publisher_id: PUBLISHER, generated_at: AT },
      { publisherId: PUBLISHER, privateKeyPem: publisher.privateKeyPem, at: AT },
    ),
  }
}

let workspace: string
async function writeIndex(name: string, index: PackIndex): Promise<string> {
  const path = join(workspace, name)
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8")
  return path
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "lodestar-pack-index-"))
})
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
})

describe("loadPackIndex — verification", () => {
  test("a signed index verifies against a pinned publisher", async () => {
    const path = await writeIndex("good.json", sign(unsignedIndex()))
    const loaded = await loadPackIndex(path, { authorizedIndexPublisherKeys: pinned })
    expect(loaded.signed).toBe(true)
    expect(loaded.publisherId).toBe(PUBLISHER)
    expect(loaded.index.packs).toHaveLength(2)
  })

  test("a tampered index entry fails verification", async () => {
    const signed = sign(unsignedIndex())
    // Re-point a source AFTER signing — the listing differs from the signed bytes.
    const tampered: PackIndex = {
      ...signed,
      packs: [
        {
          ...(signed.packs[0] as PackIndex["packs"][number]),
          source: { type: "git", url: "https://evil.test/x.git", commit: "c".repeat(40) },
        },
        signed.packs[1] as PackIndex["packs"][number],
      ],
    }
    const path = await writeIndex("tampered.json", tampered)
    await expect(loadPackIndex(path, { authorizedIndexPublisherKeys: pinned })).rejects.toThrow(
      ProbePackError,
    )
  })

  test("an unsigned index is rejected without allowUnsigned, accepted with it", async () => {
    const path = await writeIndex("unsigned.json", unsignedIndex())
    await expect(loadPackIndex(path, { authorizedIndexPublisherKeys: pinned })).rejects.toThrow(
      ProbePackError,
    )
    const loaded = await loadPackIndex(path, { allowUnsigned: true })
    expect(loaded.signed).toBe(false)
    expect(loaded.publisherId).toBeUndefined()
  })

  test("an unsigned index cannot claim a publisher it never signed for", async () => {
    // A publisher_id present WITHOUT a signature must not be surfaced as attribution.
    const claiming: PackIndex = { ...unsignedIndex(), publisher_id: "evil-claims-acme" }
    const path = await writeIndex("claiming.json", claiming)
    const loaded = await loadPackIndex(path, { allowUnsigned: true })
    expect(loaded.signed).toBe(false)
    expect(loaded.publisherId).toBeUndefined()
  })

  test("a signed index from an un-pinned publisher is rejected", async () => {
    const path = await writeIndex("unpinned.json", sign(unsignedIndex()))
    await expect(loadPackIndex(path, { authorizedIndexPublisherKeys: [] })).rejects.toThrow(
      ProbePackError,
    )
  })
})

describe("fetchPackIndex — remote", () => {
  test("fetches over an injected fetch and validates the schema", async () => {
    const signed = sign(unsignedIndex())
    const fetchImpl = (async () =>
      new Response(JSON.stringify(signed), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const index = await fetchPackIndex("https://registry.test/index.json", { fetchImpl })
    expect(index.packs).toHaveLength(2)
  })

  test("a non-2xx response throws", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    await expect(
      fetchPackIndex("https://registry.test/missing.json", { fetchImpl }),
    ).rejects.toThrow(ProbePackError)
  })

  test("an oversized index is rejected", async () => {
    const path = await writeIndex("big.json", sign(unsignedIndex()))
    await expect(
      loadPackIndex(path, { authorizedIndexPublisherKeys: pinned, maxBytes: 10 }),
    ).rejects.toThrow(/cap/)
  })

  test("a streamed remote body with no Content-Length is capped mid-stream", async () => {
    // No Content-Length → the fast-path is skipped and the streaming reader must abort
    // once the running byte count exceeds the cap (defends against a lying/absent length).
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8)))
        controller.enqueue(new TextEncoder().encode("x".repeat(8)))
        controller.close()
      },
    })
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch
    await expect(
      fetchPackIndex("https://registry.test/stream", { fetchImpl, maxBytes: 10 }),
    ).rejects.toThrow(/cap/)
  })
})

describe("searchPackIndexes — local query", () => {
  test("no query returns every listing (pack list)", async () => {
    const a = await loadPackIndex(await writeIndex("a.json", sign(unsignedIndex())), {
      authorizedIndexPublisherKeys: pinned,
    })
    expect(searchPackIndexes([a])).toHaveLength(2)
  })

  test("filters by coverage area, invariant, and text (AND)", async () => {
    const a = await loadPackIndex(await writeIndex("b.json", sign(unsignedIndex())), {
      authorizedIndexPublisherKeys: pinned,
    })
    expect(searchPackIndexes([a], { coverageArea: "egress" }).map((h) => h.entry.name)).toEqual([
      "net-pack",
    ])
    expect(searchPackIndexes([a], { invariant: "ssrf_guard" }).map((h) => h.entry.name)).toEqual([
      "net-pack",
    ])
    expect(searchPackIndexes([a], { text: "CORE" }).map((h) => h.entry.name)).toEqual(["core-pack"])
    // AND: a text + coverage that no single entry satisfies returns nothing.
    expect(searchPackIndexes([a], { text: "core", coverageArea: "egress" })).toHaveLength(0)
  })

  test("multiple indexes compose; each hit is attributed to its index", async () => {
    const a = await loadPackIndex(await writeIndex("c.json", sign(unsignedIndex())), {
      authorizedIndexPublisherKeys: pinned,
    })
    const b = await loadPackIndex(await writeIndex("d.json", sign(unsignedIndex())), {
      authorizedIndexPublisherKeys: pinned,
    })
    const hits = searchPackIndexes([a, b], { coverageArea: "egress" })
    expect(hits).toHaveLength(2)
    expect(new Set(hits.map((h) => h.indexSource)).size).toBe(2)
    expect(hits.every((h) => h.indexPublisherId === PUBLISHER)).toBe(true)
  })
})
