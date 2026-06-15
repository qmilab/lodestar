import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import type { Signature } from "../schemas/actor.js"

/**
 * The shared Ed25519 signing primitive (ADR-0017).
 *
 * ## Why this exists
 *
 * ADR-0010 put real `node:crypto` Ed25519 in `policy-kernel/approval-signature.ts`
 * to close the approval side-channel forgery hole. The registry epic (#88, #89)
 * needs the *same* primitive to sign and verify pack manifests and badges. Rather
 * than copy the approval-specific `signApprovalResolution` / `verifyApprovalSignature`,
 * the mechanism is factored here: one audited implementation of "sign a payload
 * hash with an Ed25519 private key" / "verify a {@link Signature} against an
 * operator-pinned public-key set", shared by every domain.
 *
 * Each domain (approval resolution, pack manifest, badge) computes its OWN
 * canonical document and its own payload hash, then calls these functions. What
 * differs per domain — the typed error class and the human label in the message —
 * is injected via `makeError` and `subject`, so the approval path keeps throwing
 * `ApprovalSignatureError` and the loader keeps throwing `ProbePackError`.
 *
 * Lives in core because it is pure compute (`node:crypto`, no I/O, no state) over
 * core's own {@link Signature} type, and core is the one package both
 * `policy-kernel` and `harness` already depend on — sharing from here adds no new
 * cross-package edge (ADR-0017). The `payload_hash` alone is *not* a forgery
 * defence: an attacker recomputes the canonical hash of their own forged document.
 * The anti-forgery property is the signature bytes verifying against a pinned
 * public key whose private half the attacker does not hold.
 */

/**
 * A factory the caller supplies so failures surface as its own domain-typed error
 * (`ApprovalSignatureError`, `ProbePackError`, …) with a consistent message.
 */
export type SignatureErrorFactory = (message: string) => Error

/** Operator-pinned public keys: `signer_id → SPKI PEM`, as a map or an actor list. */
export type PinnedPublicKeys =
  | Map<string, string>
  | ReadonlyArray<{ actor_id: string; public_key: string }>

/** Resolve a signer id to its pinned SPKI PEM, or `undefined` if not pinned. */
export function lookupPinnedKey(keys: PinnedPublicKeys, signerId: string): string | undefined {
  if (keys instanceof Map) return keys.get(signerId)
  return keys.find((k) => k.actor_id === signerId)?.public_key
}

/**
 * Mint a fresh Ed25519 keypair. The private half (PKCS#8 PEM) signs; the public
 * half (SPKI PEM) is what an operator pins. The CLIs that write these to disk
 * (`lodestar approve keygen`, the future pack-publish keygen) are the hosts; the
 * generation primitive lives next to sign/verify so the three stay in lock-step
 * on key format.
 */
export function generateEd25519KeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}

/**
 * Derive the SPKI PEM public key from a PKCS#8 PEM private key. Used by the pack
 * publisher: it holds only the author's private key but needs the matching public
 * key to (a) self-verify the freshly signed manifest and (b) print the pin a
 * consumer adds to their trust config. Pure compute over `node:crypto`; throws via
 * `makeError` on a key that is unparseable or not Ed25519.
 */
export function publicKeyPemFromPrivate(
  privateKeyPem: string,
  makeError: SignatureErrorFactory = (m) => new Error(m),
): string {
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(privateKeyPem)
  } catch (err) {
    throw makeError(`private key could not be parsed: ${String(err)}`)
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw makeError(
      `private key is ${key.asymmetricKeyType ?? "an unknown type"}, expected ed25519`,
    )
  }
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString()
}

/**
 * Validate that every pinned public key is a parseable Ed25519 SPKI PEM, throwing
 * on the first bad one. Call this once at config load: a corrupt pinned key would
 * otherwise surface only at verification time as a *rejected* signature
 * (indistinguishable from a forgery). A misconfiguration should fail loudly at
 * startup, not masquerade as an attack.
 */
export function assertValidPublicKeys(
  keys: PinnedPublicKeys,
  makeError: SignatureErrorFactory,
): void {
  const list =
    keys instanceof Map
      ? [...keys].map(([actor_id, public_key]) => ({ actor_id, public_key }))
      : keys
  for (const k of list) {
    let parsed: ReturnType<typeof createPublicKey>
    try {
      parsed = createPublicKey(k.public_key)
    } catch (err) {
      throw makeError(`unparseable public key for pinned signer '${k.actor_id}': ${String(err)}`)
    }
    if (parsed.asymmetricKeyType !== "ed25519") {
      throw makeError(
        `pinned public key for '${k.actor_id}' is ${parsed.asymmetricKeyType ?? "an unknown type"}, expected ed25519`,
      )
    }
  }
}

/**
 * Sign a precomputed canonical `payloadHash` (sha-256 hex) with an Ed25519
 * private key, producing the detached {@link Signature}. The bytes signed are the
 * hash hex, binding signature → hash → document. `at` is supplied by the caller
 * (no clock here — keeps this pure and deterministic).
 */
export function signPayloadHash(args: {
  payloadHash: string
  signerId: string
  privateKeyPem: string
  at: string
  makeError: SignatureErrorFactory
}): Signature {
  const { payloadHash, signerId, privateKeyPem, at, makeError } = args
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(privateKeyPem)
  } catch (err) {
    throw makeError(`signing private key could not be parsed: ${String(err)}`)
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw makeError(
      `signing private key is ${key.asymmetricKeyType ?? "an unknown type"}, expected ed25519`,
    )
  }
  // Ed25519 signs the message directly — the algorithm argument is null.
  const sig = sign(null, Buffer.from(payloadHash, "utf8"), key)
  return {
    signer_id: signerId,
    payload_hash: payloadHash,
    algorithm: "ed25519",
    signature: sig.toString("base64"),
    at,
  }
}

export interface VerifyPayloadHashOptions {
  /** The canonical hash the verifier independently recomputed from the document. */
  expectedPayloadHash: string
  /** The signer id the document declares (e.g. an approver_id / author_id). */
  expectedSignerId: string
  /** Operator-pinned public keys. A signer not in this set is rejected — the trust root. */
  authorizedKeys: PinnedPublicKeys
  /**
   * Allow an *absent* signature through (a trusted in-process / development path).
   * Security-relevant, so it is an explicit, caller-supplied opt-out — never a
   * silent default. A *present* signature is always fully verified regardless.
   */
  allowUnsigned?: boolean
  /** Human label for the signed subject in error messages, e.g. "probe pack 'x'". */
  subject: string
  makeError: SignatureErrorFactory
}

/**
 * Verify a detached {@link Signature} against the operator-pinned public keys.
 * Throws via `makeError` on any failure; returns normally when authentic (or
 * unsigned under an explicit `allowUnsigned`).
 *
 * Reject set:
 *   - signature absent and `allowUnsigned` not set;
 *   - `payload_hash` ≠ `expectedPayloadHash` (tampered / stale document);
 *   - `signer_id` ≠ `expectedSignerId` (a signature lifted onto another's document);
 *   - the signer is not in the pinned set (the trust root);
 *   - a non-ed25519 algorithm;
 *   - the Ed25519 signature bytes fail verification.
 */
export function verifyPayloadHashSignature(
  signature: Signature | undefined,
  options: VerifyPayloadHashOptions,
): void {
  const { expectedPayloadHash, expectedSignerId, authorizedKeys, subject, makeError } = options
  if (signature === undefined) {
    if (options.allowUnsigned === true) return
    throw makeError(
      `${subject} is unsigned; it must carry an Ed25519 signature (set allow_unsigned: true only for a trusted in-process / development path)`,
    )
  }
  if (signature.payload_hash !== expectedPayloadHash) {
    throw makeError(
      `${subject} signature payload_hash does not match the canonical document — it was tampered with or the signature is stale`,
    )
  }
  if (signature.signer_id !== expectedSignerId) {
    throw makeError(
      `${subject} signature signer_id '${signature.signer_id}' does not match the declared signer '${expectedSignerId}'`,
    )
  }
  if (signature.algorithm !== "ed25519") {
    throw makeError(`${subject} signature algorithm '${signature.algorithm}' is not ed25519`)
  }
  const publicKeyPem = lookupPinnedKey(authorizedKeys, signature.signer_id)
  if (publicKeyPem === undefined) {
    throw makeError(
      `${subject} signer '${signature.signer_id}' is not in the operator-pinned key set`,
    )
  }
  let ok: boolean
  try {
    ok = verify(
      null,
      Buffer.from(expectedPayloadHash, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.signature, "base64"),
    )
  } catch (err) {
    throw makeError(`${subject} signature could not be verified: ${String(err)}`)
  }
  if (!ok) {
    throw makeError(`${subject} failed Ed25519 signature verification`)
  }
}
