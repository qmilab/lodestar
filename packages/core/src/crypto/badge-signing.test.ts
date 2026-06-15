import { describe, expect, test } from "bun:test"
import {
  PACK_BADGE_SPEC_VERSION,
  type PackBadge,
  PackBadgeSchema,
  type ProbeResultsBadge,
} from "../schemas/pack-badge.js"
import {
  assertBadgeAppliesTo,
  canonicalBadgeDocument,
  canonicalBadgeHash,
  signPackBadge,
  verifyPackBadgeSignature,
} from "./badge-signing.js"
import { generateEd25519KeyPair } from "./signing.js"

class PackError extends Error {
  override readonly name = "PackError"
}
const makeError = (m: string) => new PackError(m)
const AT = "2026-01-01T00:00:00.000Z"
const ATTESTER = "acme-attester"
const MANIFEST_HASH = "a".repeat(64)

function baseUnsignedBadge(): Omit<ProbeResultsBadge, "signature"> {
  return {
    badge_version: PACK_BADGE_SPEC_VERSION,
    kind: "probe_results",
    subject: { pack: "demo-pack", version: "1.0.0", manifest_hash: MANIFEST_HASH },
    attester_id: ATTESTER,
    issued_at: AT,
    result: { ok: true, total: 3, passed: 3, failed: 0, harness_version: "0.3.0" },
  }
}

describe("canonicalBadgeDocument / hash", () => {
  test("drops the signature; hash is independent of the signature field", () => {
    const unsigned = baseUnsignedBadge()
    const hashUnsigned = canonicalBadgeHash(unsigned)
    const signed: PackBadge = {
      ...unsigned,
      signature: {
        signer_id: ATTESTER,
        payload_hash: hashUnsigned,
        algorithm: "ed25519",
        signature: "y",
        at: AT,
      },
    }
    const doc = canonicalBadgeDocument(signed) as Record<string, unknown>
    expect(doc.signature).toBeUndefined()
    expect(doc.attester_id).toBe(ATTESTER)
    expect(canonicalBadgeHash(signed)).toBe(hashUnsigned)
  })
})

describe("sign + verify round trip", () => {
  test("a badge signed by the pinned attester verifies and is schema-valid", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    // signer_id binds to the badge's own attester_id by construction.
    expect(signed.signature.signer_id).toBe(ATTESTER)
    // The signed badge is a valid PackBadge.
    expect(PackBadgeSchema.safeParse(signed).success).toBe(true)
    expect(() =>
      verifyPackBadgeSignature(signed, {
        authorizedAttesterKeys: [{ actor_id: ATTESTER, public_key: publicKeyPem }],
        makeError,
      }),
    ).not.toThrow()
  })

  test("an un-pinned attester is rejected (forged / unknown signer)", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    // Pin a DIFFERENT attester's key — the signer is not in the set.
    const { publicKeyPem: otherPub } = generateEd25519KeyPair()
    expect(() =>
      verifyPackBadgeSignature(signed, {
        authorizedAttesterKeys: [{ actor_id: "someone-else", public_key: otherPub }],
        makeError,
      }),
    ).toThrow(PackError)
  })

  test("a badge whose key does not match the pinned attester fails signature bytes", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    // The attester_id IS pinned, but with a wrong (different) public key.
    const { publicKeyPem: wrongPub } = generateEd25519KeyPair()
    expect(() =>
      verifyPackBadgeSignature(signed, {
        authorizedAttesterKeys: [{ actor_id: ATTESTER, public_key: wrongPub }],
        makeError,
      }),
    ).toThrow(PackError)
  })

  test("a badge tampered after signing fails on payload_hash", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    // Edit the result without re-signing — the canonical hash no longer matches.
    const tampered: PackBadge = { ...signed, result: { ...signed.result, ok: false, failed: 1 } }
    expect(() =>
      verifyPackBadgeSignature(tampered, {
        authorizedAttesterKeys: [{ actor_id: ATTESTER, public_key: publicKeyPem }],
        makeError,
      }),
    ).toThrow(PackError)
  })
})

describe("assertBadgeAppliesTo (mis-attach defence)", () => {
  test("matching subject applies", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    expect(() =>
      assertBadgeAppliesTo(
        signed,
        { packName: "demo-pack", packVersion: "1.0.0", manifestHash: MANIFEST_HASH },
        makeError,
      ),
    ).not.toThrow()
  })

  test("a different manifest_hash is a mis-attach and is rejected", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    expect(() =>
      assertBadgeAppliesTo(
        signed,
        { packName: "demo-pack", packVersion: "1.0.0", manifestHash: "b".repeat(64) },
        makeError,
      ),
    ).toThrow(/mis-attached/i)
  })

  test("a different pack name is rejected", () => {
    const { privateKeyPem } = generateEd25519KeyPair()
    const signed = signPackBadge(baseUnsignedBadge(), { privateKeyPem, at: AT })
    expect(() =>
      assertBadgeAppliesTo(
        signed,
        { packName: "other-pack", packVersion: "1.0.0", manifestHash: MANIFEST_HASH },
        makeError,
      ),
    ).toThrow(PackError)
  })
})
