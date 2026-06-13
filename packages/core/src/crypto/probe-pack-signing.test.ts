import { describe, expect, test } from "bun:test"
import type { ProbePackManifest } from "../schemas/probe-pack.js"
import {
  canonicalProbePackManifestDocument,
  canonicalProbePackManifestHash,
  signProbePackManifest,
  verifyProbePackManifestSignature,
} from "./probe-pack-signing.js"
import { generateEd25519KeyPair } from "./signing.js"

class PackError extends Error {
  override readonly name = "PackError"
}
const makeError = (m: string) => new PackError(m)
const AT = "2026-01-01T00:00:00.000Z"

function baseManifest(): ProbePackManifest {
  return {
    name: "demo-pack",
    version: "1.0.0",
    spec_version: "1",
    source_type: "local",
    coverage_areas: ["x"],
    invariants: ["y"],
    probes: [{ name: "p", file: "p.ts" }],
    author_id: "author",
    content_digest: {
      algorithm: "sha256",
      files: [{ path: "p.ts", sha256: "e".repeat(64) }],
    },
  }
}

describe("canonicalProbePackManifestDocument", () => {
  test("drops the signature but keeps author_id and content_digest", () => {
    const m = baseManifest()
    const signed: ProbePackManifest = {
      ...m,
      signature: {
        signer_id: "author",
        payload_hash: "x",
        algorithm: "ed25519",
        signature: "y",
        at: AT,
      },
    }
    const doc = canonicalProbePackManifestDocument(signed) as Record<string, unknown>
    expect(doc.signature).toBeUndefined()
    expect(doc.author_id).toBe("author")
    expect(doc.content_digest).toBeDefined()
  })

  test("the hash is independent of the (absent vs present) signature field", () => {
    const m = baseManifest()
    const hashUnsigned = canonicalProbePackManifestHash(m)
    const signed: ProbePackManifest = {
      ...m,
      signature: {
        signer_id: "author",
        payload_hash: hashUnsigned,
        algorithm: "ed25519",
        signature: "y",
        at: AT,
      },
    }
    expect(canonicalProbePackManifestHash(signed)).toBe(hashUnsigned)
  })
})

describe("sign + verify round trip", () => {
  test("a manifest signed by the pinned author verifies", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const m = baseManifest()
    const signature = signProbePackManifest(m, {
      authorId: "author",
      privateKeyPem,
      at: AT,
      makeError,
    })
    const signed: ProbePackManifest = { ...m, signature }
    expect(() =>
      verifyProbePackManifestSignature(signed, {
        authorizedAuthorKeys: [{ actor_id: "author", public_key: publicKeyPem }],
        makeError,
      }),
    ).not.toThrow()
  })

  test("an unsigned manifest is rejected unless allowUnsigned", () => {
    const m = baseManifest()
    expect(() =>
      verifyProbePackManifestSignature(m, { authorizedAuthorKeys: [], makeError }),
    ).toThrow(PackError)
    expect(() =>
      verifyProbePackManifestSignature(m, {
        authorizedAuthorKeys: [],
        allowUnsigned: true,
        makeError,
      }),
    ).not.toThrow()
  })

  test("a signed manifest with no author_id is rejected", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair()
    const m = baseManifest()
    const signature = signProbePackManifest(m, {
      authorId: "author",
      privateKeyPem,
      at: AT,
      makeError,
    })
    const { author_id: _drop, ...withoutAuthor } = m
    const signed: ProbePackManifest = { ...withoutAuthor, signature }
    expect(() =>
      verifyProbePackManifestSignature(signed, {
        authorizedAuthorKeys: [{ actor_id: "author", public_key: publicKeyPem }],
        makeError,
      }),
    ).toThrow(PackError)
  })

  test("a tampered manifest (edited after signing) is rejected", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const m = baseManifest()
    const signature = signProbePackManifest(m, {
      authorId: "author",
      privateKeyPem,
      at: AT,
      makeError,
    })
    const edited: ProbePackManifest = { ...m, version: "9.9.9", signature }
    expect(() =>
      verifyProbePackManifestSignature(edited, {
        authorizedAuthorKeys: [{ actor_id: "author", public_key: publicKeyPem }],
        makeError,
      }),
    ).toThrow(PackError)
  })
})
