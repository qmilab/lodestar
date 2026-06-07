import { describe, expect, test } from "bun:test"
import {
  type ApprovalResolutionDoc,
  ApprovalSignatureError,
  canonicalApprovalResolutionHash,
  generateApproverKeyPair,
  signApprovalResolution,
  verifyApprovalSignature,
} from "./approval-signature.js"

const DOC: ApprovalResolutionDoc = {
  request_id: "req-1",
  action_id: "act-1",
  kind: "granted",
  approver_id: "operator",
  at: "2026-06-07T00:00:00Z",
}

describe("canonicalApprovalResolutionHash", () => {
  test("is stable regardless of key order", () => {
    const reordered: ApprovalResolutionDoc = {
      at: DOC.at,
      approver_id: DOC.approver_id,
      kind: DOC.kind,
      action_id: DOC.action_id,
      request_id: DOC.request_id,
    }
    expect(canonicalApprovalResolutionHash(reordered)).toBe(canonicalApprovalResolutionHash(DOC))
  })

  test("omitted vs explicit-undefined reason hash identically (JSON round-trip safe)", () => {
    const withUndefined = { ...DOC, reason: undefined }
    expect(canonicalApprovalResolutionHash(withUndefined)).toBe(
      canonicalApprovalResolutionHash(DOC),
    )
  })

  test("a present reason changes the hash", () => {
    expect(canonicalApprovalResolutionHash({ ...DOC, reason: "ok" })).not.toBe(
      canonicalApprovalResolutionHash(DOC),
    )
  })

  test("ignores an incidental extra field (e.g. a carried signature)", () => {
    const sig = signApprovalResolution(DOC, generateApproverKeyPair().privateKeyPem)
    // The side-channel resolution carries a `signature`; it must not enter the hash.
    expect(
      canonicalApprovalResolutionHash({ ...DOC, signature: sig } as ApprovalResolutionDoc),
    ).toBe(canonicalApprovalResolutionHash(DOC))
  })
})

describe("signApprovalResolution / verifyApprovalSignature", () => {
  test("a valid signature from a pinned key verifies", () => {
    const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
    const sig = signApprovalResolution(DOC, privateKeyPem)
    expect(sig.signer_id).toBe("operator")
    expect(sig.algorithm).toBe("ed25519")
    expect(() =>
      verifyApprovalSignature(DOC, sig, {
        authorizedKeys: [{ actor_id: "operator", public_key: publicKeyPem }],
      }),
    ).not.toThrow()
  })

  test("accepts the pinned keys as a Map too", () => {
    const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
    const sig = signApprovalResolution(DOC, privateKeyPem)
    const keys = new Map([["operator", publicKeyPem]])
    expect(() => verifyApprovalSignature(DOC, sig, { authorizedKeys: keys })).not.toThrow()
  })

  test("rejects a signer that is not in the operator-pinned set", () => {
    const { privateKeyPem } = generateApproverKeyPair()
    const sig = signApprovalResolution(DOC, privateKeyPem)
    expect(() => verifyApprovalSignature(DOC, sig, { authorizedKeys: [] })).toThrow(
      ApprovalSignatureError,
    )
  })

  test("rejects a forged signature (attacker key claiming the approver's id)", () => {
    const pinned = generateApproverKeyPair()
    const attacker = generateApproverKeyPair()
    // Attacker signs the real doc with THEIR key but claims approver_id 'operator'.
    const forged = signApprovalResolution(DOC, attacker.privateKeyPem)
    expect(() =>
      verifyApprovalSignature(DOC, forged, {
        authorizedKeys: [{ actor_id: "operator", public_key: pinned.publicKeyPem }],
      }),
    ).toThrow(ApprovalSignatureError)
  })

  test("rejects a signature lifted onto a tampered document", () => {
    const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
    const sig = signApprovalResolution(DOC, privateKeyPem)
    // Same signature, but the action_id was swapped after signing.
    expect(() =>
      verifyApprovalSignature({ ...DOC, action_id: "act-EVIL" }, sig, {
        authorizedKeys: [{ actor_id: "operator", public_key: publicKeyPem }],
      }),
    ).toThrow(ApprovalSignatureError)
  })

  test("rejects a signature whose signer_id does not match approver_id", () => {
    const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
    const sig = signApprovalResolution({ ...DOC, approver_id: "someone-else" }, privateKeyPem)
    // sig.signer_id is 'someone-else'; verifying against a doc for 'operator' must fail
    // even though 'someone-else' might be pinned.
    expect(() =>
      verifyApprovalSignature(DOC, sig, {
        authorizedKeys: [{ actor_id: "someone-else", public_key: publicKeyPem }],
      }),
    ).toThrow(ApprovalSignatureError)
  })

  test("unsigned is rejected without allowUnsigned, accepted with it", () => {
    const { publicKeyPem } = generateApproverKeyPair()
    const keys = [{ actor_id: "operator", public_key: publicKeyPem }]
    expect(() => verifyApprovalSignature(DOC, undefined, { authorizedKeys: keys })).toThrow(
      ApprovalSignatureError,
    )
    expect(() =>
      verifyApprovalSignature(DOC, undefined, { authorizedKeys: keys, allowUnsigned: true }),
    ).not.toThrow()
  })

  test("a denied resolution signs and verifies the same way", () => {
    const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
    const denied: ApprovalResolutionDoc = { ...DOC, kind: "denied" }
    const sig = signApprovalResolution(denied, privateKeyPem)
    expect(() =>
      verifyApprovalSignature(denied, sig, {
        authorizedKeys: [{ actor_id: "operator", public_key: publicKeyPem }],
      }),
    ).not.toThrow()
    // The granted-vs-denied verdict is part of the signed content: a grant
    // signature cannot be replayed as a denial (or vice versa).
    expect(() =>
      verifyApprovalSignature(DOC, sig, {
        authorizedKeys: [{ actor_id: "operator", public_key: publicKeyPem }],
      }),
    ).toThrow(ApprovalSignatureError)
  })

  test("generateApproverKeyPair emits PEM blocks", () => {
    const { publicKeyPem, privateKeyPem } = generateApproverKeyPair()
    expect(publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----")
    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----")
  })

  test("a non-ed25519 private key is rejected at signing", () => {
    // An RSA key in PKCS#8 PEM — wrong asymmetric type.
    const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    expect(() => signApprovalResolution(DOC, rsaPem)).toThrow(ApprovalSignatureError)
  })
})
