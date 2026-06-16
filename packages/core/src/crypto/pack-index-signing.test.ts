import { describe, expect, test } from "bun:test"
import { PACK_INDEX_SPEC_VERSION, type PackIndex, PackIndexSchema } from "../schemas/pack-index.js"
import {
  canonicalPackIndexDocument,
  canonicalPackIndexHash,
  signPackIndex,
  verifyPackIndexSignature,
} from "./pack-index-signing.js"
import { generateEd25519KeyPair } from "./signing.js"

class PackError extends Error {
  override readonly name = "PackError"
}
const makeError = (m: string) => new PackError(m)
const AT = "2026-01-01T00:00:00.000Z"
const PUBLISHER = "acme-index"

function baseIndex(): PackIndex {
  return {
    index_version: PACK_INDEX_SPEC_VERSION,
    description: "demo index",
    packs: [
      {
        name: "demo-pack",
        version: "1.0.0",
        source: { type: "git", url: "https://example.test/demo.git", commit: "a".repeat(40) },
        coverage_areas: ["pack_registry"],
        invariants: ["index_signature_required"],
      },
    ],
    publisher_id: PUBLISHER,
    generated_at: AT,
  }
}

function signed(index: PackIndex, privateKeyPem: string): PackIndex {
  return {
    ...index,
    signature: signPackIndex(index, { publisherId: PUBLISHER, privateKeyPem, at: AT }),
  }
}

describe("canonicalPackIndexDocument / hash", () => {
  test("drops the signature; hash is independent of the signature field", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const idx = baseIndex()
    const hashUnsigned = canonicalPackIndexHash(idx)
    const withSig = signed(idx, privateKeyPem)
    const doc = canonicalPackIndexDocument(withSig) as Record<string, unknown>
    expect(doc.signature).toBeUndefined()
    expect(doc.publisher_id).toBe(PUBLISHER)
    expect(canonicalPackIndexHash(withSig)).toBe(hashUnsigned)
  })
})

describe("sign + verify round trip", () => {
  test("an index signed by the pinned publisher verifies and is schema-valid", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const withSig = signed(baseIndex(), privateKeyPem)
    expect(withSig.signature?.signer_id).toBe(PUBLISHER)
    expect(PackIndexSchema.safeParse(withSig).success).toBe(true)
    expect(() =>
      verifyPackIndexSignature(withSig, {
        authorizedIndexPublisherKeys: [{ actor_id: PUBLISHER, public_key: publicKeyPem }],
        makeError,
      }),
    ).not.toThrow()
  })

  test("an un-pinned publisher is rejected (forged / unknown signer)", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const withSig = signed(baseIndex(), privateKeyPem)
    const { publicKeyPem: otherPub } = generateEd25519KeyPair()
    expect(() =>
      verifyPackIndexSignature(withSig, {
        authorizedIndexPublisherKeys: [{ actor_id: "someone-else", public_key: otherPub }],
        makeError,
      }),
    ).toThrow(PackError)
  })

  test("a wrong pinned key for the right publisher fails signature bytes", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const withSig = signed(baseIndex(), privateKeyPem)
    const { publicKeyPem: wrongPub } = generateEd25519KeyPair()
    expect(() =>
      verifyPackIndexSignature(withSig, {
        authorizedIndexPublisherKeys: [{ actor_id: PUBLISHER, public_key: wrongPub }],
        makeError,
      }),
    ).toThrow(PackError)
  })

  test("an index tampered after signing fails on payload_hash", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const withSig = signed(baseIndex(), privateKeyPem)
    // Re-point a listing's source after signing — the canonical hash no longer matches.
    const tampered: PackIndex = {
      ...withSig,
      packs: [
        {
          ...(withSig.packs[0] as PackIndex["packs"][number]),
          source: { type: "git", url: "https://evil.test/x.git", commit: "b".repeat(40) },
        },
      ],
    }
    expect(() =>
      verifyPackIndexSignature(tampered, {
        authorizedIndexPublisherKeys: [{ actor_id: PUBLISHER, public_key: publicKeyPem }],
        makeError,
      }),
    ).toThrow(PackError)
  })
})

describe("unsigned handling", () => {
  test("an unsigned index is rejected without allowUnsigned", () => {
    const idx = baseIndex()
    idx.publisher_id = undefined
    expect(() =>
      verifyPackIndexSignature(idx, { authorizedIndexPublisherKeys: [], makeError }),
    ).toThrow(PackError)
  })

  test("an unsigned index passes under an explicit allowUnsigned", () => {
    const idx = baseIndex()
    idx.publisher_id = undefined
    expect(() =>
      verifyPackIndexSignature(idx, {
        authorizedIndexPublisherKeys: [],
        allowUnsigned: true,
        makeError,
      }),
    ).not.toThrow()
  })

  test("a signed index with no publisher_id to bind is rejected", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const withSig = signed(baseIndex(), privateKeyPem)
    withSig.publisher_id = undefined
    expect(() =>
      verifyPackIndexSignature(withSig, {
        authorizedIndexPublisherKeys: [],
        allowUnsigned: true,
        makeError,
      }),
    ).toThrow(/publisher_id/)
  })
})
