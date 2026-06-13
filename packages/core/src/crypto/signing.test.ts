import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import type { Signature } from "../schemas/actor.js"
import {
  assertValidPublicKeys,
  generateEd25519KeyPair,
  lookupPinnedKey,
  signPayloadHash,
  verifyPayloadHashSignature,
} from "./signing.js"

class TestError extends Error {
  override readonly name = "TestError"
}
const makeError = (m: string) => new TestError(m)

const HASH = "a".repeat(64)
const AT = "2026-01-01T00:00:00.000Z"

function signFixture(): { signature: Signature; publicKeyPem: string; privateKeyPem: string } {
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
  const signature = signPayloadHash({
    payloadHash: HASH,
    signerId: "alice",
    privateKeyPem,
    at: AT,
    makeError,
  })
  return { signature, publicKeyPem, privateKeyPem }
}

describe("generateEd25519KeyPair", () => {
  test("mints a PEM keypair", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair()
    expect(publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----")
    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----")
  })
})

describe("signPayloadHash", () => {
  test("binds the signer, hash, algorithm, and time", () => {
    const { signature } = signFixture()
    expect(signature.signer_id).toBe("alice")
    expect(signature.payload_hash).toBe(HASH)
    expect(signature.algorithm).toBe("ed25519")
    expect(signature.at).toBe(AT)
    expect(signature.signature.length).toBeGreaterThan(0)
  })

  test("rejects a non-ed25519 private key via makeError", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    expect(() =>
      signPayloadHash({
        payloadHash: HASH,
        signerId: "alice",
        privateKeyPem: rsaPem,
        at: AT,
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("rejects an unparseable private key via makeError", () => {
    expect(() =>
      signPayloadHash({
        payloadHash: HASH,
        signerId: "alice",
        privateKeyPem: "not a key",
        at: AT,
        makeError,
      }),
    ).toThrow(TestError)
  })
})

describe("verifyPayloadHashSignature", () => {
  test("accepts an authentic signature from a pinned signer", () => {
    const { signature, publicKeyPem } = signFixture()
    expect(() =>
      verifyPayloadHashSignature(signature, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: [{ actor_id: "alice", public_key: publicKeyPem }],
        subject: "test doc",
        makeError,
      }),
    ).not.toThrow()
  })

  test("accepts via a Map of pinned keys", () => {
    const { signature, publicKeyPem } = signFixture()
    expect(() =>
      verifyPayloadHashSignature(signature, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: new Map([["alice", publicKeyPem]]),
        subject: "test doc",
        makeError,
      }),
    ).not.toThrow()
  })

  test("rejects an absent signature by default", () => {
    expect(() =>
      verifyPayloadHashSignature(undefined, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: [],
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("allows an absent signature only under allowUnsigned", () => {
    expect(() =>
      verifyPayloadHashSignature(undefined, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: [],
        allowUnsigned: true,
        subject: "test doc",
        makeError,
      }),
    ).not.toThrow()
  })

  test("a PRESENT signature is verified even under allowUnsigned (the flag does not weaken it)", () => {
    const { signature, publicKeyPem } = signFixture()
    const tampered: Signature = { ...signature, payload_hash: "b".repeat(64) }
    expect(() =>
      verifyPayloadHashSignature(tampered, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: [{ actor_id: "alice", public_key: publicKeyPem }],
        allowUnsigned: true,
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("rejects a payload_hash mismatch (tampered document)", () => {
    const { signature, publicKeyPem } = signFixture()
    expect(() =>
      verifyPayloadHashSignature(signature, {
        expectedPayloadHash: "c".repeat(64),
        expectedSignerId: "alice",
        authorizedKeys: [{ actor_id: "alice", public_key: publicKeyPem }],
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("rejects when signer_id != expected signer", () => {
    const { signature, publicKeyPem } = signFixture()
    expect(() =>
      verifyPayloadHashSignature(signature, {
        expectedPayloadHash: HASH,
        expectedSignerId: "bob",
        authorizedKeys: [{ actor_id: "alice", public_key: publicKeyPem }],
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("rejects a signer not in the pinned set", () => {
    const { signature } = signFixture()
    expect(() =>
      verifyPayloadHashSignature(signature, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: [],
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("rejects a signature made with a different key (the forgery property)", () => {
    const { signature } = signFixture()
    const attacker = generateEd25519KeyPair()
    expect(() =>
      verifyPayloadHashSignature(signature, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        // alice is pinned, but to the attacker's public key — the bytes won't verify.
        authorizedKeys: [{ actor_id: "alice", public_key: attacker.publicKeyPem }],
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })

  test("rejects a non-ed25519 algorithm", () => {
    const { signature, publicKeyPem } = signFixture()
    const wrongAlg = { ...signature, algorithm: "rsa" } as unknown as Signature
    expect(() =>
      verifyPayloadHashSignature(wrongAlg, {
        expectedPayloadHash: HASH,
        expectedSignerId: "alice",
        authorizedKeys: [{ actor_id: "alice", public_key: publicKeyPem }],
        subject: "test doc",
        makeError,
      }),
    ).toThrow(TestError)
  })
})

describe("assertValidPublicKeys", () => {
  test("passes valid ed25519 keys", () => {
    const { publicKeyPem } = generateEd25519KeyPair()
    expect(() =>
      assertValidPublicKeys([{ actor_id: "alice", public_key: publicKeyPem }], makeError),
    ).not.toThrow()
  })

  test("throws on an unparseable key", () => {
    expect(() =>
      assertValidPublicKeys([{ actor_id: "alice", public_key: "nope" }], makeError),
    ).toThrow(TestError)
  })

  test("throws on a non-ed25519 key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const rsaPem = publicKey.export({ type: "spki", format: "pem" }).toString()
    expect(() =>
      assertValidPublicKeys([{ actor_id: "alice", public_key: rsaPem }], makeError),
    ).toThrow(TestError)
  })
})

describe("lookupPinnedKey", () => {
  test("resolves from a list and a Map, undefined when absent", () => {
    expect(lookupPinnedKey([{ actor_id: "a", public_key: "PEM" }], "a")).toBe("PEM")
    expect(lookupPinnedKey(new Map([["a", "PEM"]]), "a")).toBe("PEM")
    expect(lookupPinnedKey([], "a")).toBeUndefined()
  })
})
