import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"
import type { Signature } from "@qmilab/lodestar-core"
import { stableStringify } from "./hash.js"

/**
 * Signed approval resolutions — the cryptographic boundary the separate-process
 * resolver path was missing.
 *
 * ## Why this exists
 *
 * The MCP proxy parks a held L4 action and promotes whatever resolution it finds
 * in the side-channel (`@qmilab/lodestar-guard-mcp`'s `approvals-channel`). The
 * `approver_id` on that file is a *plain string*: anything that can write the
 * `.approvals/` directory can claim to be an authorised approver and un-park the
 * action. The `lodestar approve` authority check (`authorizeResolution`) runs in
 * the *writer* process, so a hostile writer simply skips it. That is
 * honest-mistake protection, not a boundary against a malicious local writer.
 *
 * This module closes that hole. A resolution is signed with the approver's
 * Ed25519 private key; the proxy verifies the signature against an
 * operator-pinned set of approver public keys before promoting. The trust root
 * moves from "can write the file" to "holds the approver private key".
 *
 * ## Real crypto, not the injected placeholder
 *
 * Unlike the policy-signature path — where the cryptographic check is a
 * host-injected `verifySignature` seam (the policy doc is loaded by the trusted
 * host, so the in-repo reference uses a base64 placeholder) — the approval
 * side-channel is a genuine cross-process forgery surface, so the verification
 * must be real. We use Node's native Ed25519 (`node:crypto`), the same
 * dependency-free primitive `hash.ts` already relies on. The `payload_hash`
 * alone is *not* a forgery defence: an attacker recomputes the canonical hash of
 * their own forged resolution. The anti-forgery property comes from the
 * signature bytes verifying against a public key whose private half the attacker
 * does not hold.
 */

/**
 * The signable content of a resolution: the verdict-bearing fields, with `kind`
 * explicit. The side-channel `ApprovalResolution` carries `kind` directly; the
 * canonical `approval.granted@1` / `approval.denied@1` *event* payloads do not
 * (the verdict is the event type), so a log reader re-deriving the hash supplies
 * `kind` from the event type. `reason` is omitted when unset, matching the
 * omit-never-undefined discipline the wire formats hold — so `stableStringify`
 * (which drops undefined keys) reproduces the signer's bytes byte-for-byte.
 */
export interface ApprovalResolutionDoc {
  request_id: string
  action_id: string
  kind: "granted" | "denied"
  approver_id: string
  reason?: string
  at: string
}

/** Reduce any resolution-shaped value to exactly the canonical, signable fields. */
export function canonicalApprovalResolutionDocument(
  doc: ApprovalResolutionDoc,
): ApprovalResolutionDoc {
  // Build the object key-by-key so an incidental extra field on the input (e.g.
  // a side-channel resolution carrying a `signature`) can never enter the hash.
  const canonical: ApprovalResolutionDoc = {
    request_id: doc.request_id,
    action_id: doc.action_id,
    kind: doc.kind,
    approver_id: doc.approver_id,
    at: doc.at,
  }
  if (doc.reason !== undefined) canonical.reason = doc.reason
  return canonical
}

/** sha-256 hex of the canonical resolution document. */
export function canonicalApprovalResolutionHash(doc: ApprovalResolutionDoc): string {
  return createHash("sha256")
    .update(stableStringify(canonicalApprovalResolutionDocument(doc)))
    .digest("hex")
}

/** Raised when an approval resolution signature is absent, malformed, or invalid. */
export class ApprovalSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalSignatureError"
  }
}

/**
 * Sign a resolution with an approver's Ed25519 private key. Produces the
 * detached `Signature` the side-channel file (and the promoted event) carries.
 *
 * `signer_id` is bound to `doc.approver_id` — the same actor the resolver
 * authorised — so a verifier can reject a signature whose claimed signer does
 * not match the resolution it signs. The signature `at` reuses the resolution's
 * decision time, keeping this function pure (no clock) and deterministic.
 *
 * `privateKeyPem` is a PKCS#8 PEM (the format `lodestar approve keygen` emits).
 * The bytes signed are the canonical hash hex, binding signature → hash →
 * document.
 */
export function signApprovalResolution(
  doc: ApprovalResolutionDoc,
  privateKeyPem: string,
): Signature {
  const payloadHash = canonicalApprovalResolutionHash(doc)
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(privateKeyPem)
  } catch (err) {
    // Wrap the raw node:crypto PEM-parse error in the module's typed error, so
    // every caller (not just the CLI, which already catches) gets a consistent
    // ApprovalSignatureError rather than an opaque OpenSSL message.
    throw new ApprovalSignatureError(`approver private key could not be parsed: ${String(err)}`)
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ApprovalSignatureError(
      `approver private key is ${key.asymmetricKeyType ?? "an unknown type"}, expected ed25519`,
    )
  }
  // Ed25519 signs the message directly — the algorithm argument is null.
  const sig = sign(null, Buffer.from(payloadHash, "utf8"), key)
  return {
    signer_id: doc.approver_id,
    payload_hash: payloadHash,
    algorithm: "ed25519",
    signature: sig.toString("base64"),
    at: doc.at,
  }
}

/**
 * Mint a fresh Ed25519 approver keypair. The private half (`privateKeyPem`,
 * PKCS#8) goes to the approver and feeds {@link signApprovalResolution}; the
 * public half (`publicKeyPem`, SPKI) is what the operator pins in the proxy's
 * authorized-approver set. `lodestar approve keygen` is the host that writes
 * these to disk — the generation primitive lives here next to sign/verify so
 * the three stay in lock-step on key format.
 */
export function generateApproverKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}

/**
 * Validate that every operator-pinned approver public key is a parseable Ed25519
 * SPKI PEM, throwing {@link ApprovalSignatureError} on the first bad one. Call
 * this once at config load / proxy construction: a corrupt pinned key would
 * otherwise surface only at verification time as a *rejected* resolution
 * (indistinguishable from a forgery), silently timing out every real approval. A
 * misconfiguration should fail loudly at startup, not masquerade as an attack.
 */
export function assertValidApproverKeys(
  keys: ReadonlyArray<{ actor_id: string; public_key: string }>,
): void {
  for (const k of keys) {
    let key: ReturnType<typeof createPublicKey>
    try {
      key = createPublicKey(k.public_key)
    } catch (err) {
      throw new ApprovalSignatureError(
        `authorized approver '${k.actor_id}' has an unparseable public key: ${String(err)}`,
      )
    }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new ApprovalSignatureError(
        `authorized approver '${k.actor_id}' public key is ${key.asymmetricKeyType ?? "an unknown type"}, expected ed25519`,
      )
    }
  }
}

/** Operator-pinned approver public keys: `approver_id → SPKI PEM public key`. */
export type AuthorizedApproverKeys =
  | Map<string, string>
  | ReadonlyArray<{ actor_id: string; public_key: string }>

export interface VerifyApprovalSignatureOptions {
  /**
   * The operator-pinned approver public keys. A resolution whose signer is not
   * in this set is rejected — this is the trust root.
   */
  authorizedKeys: AuthorizedApproverKeys
  /**
   * Allow an unsigned resolution through (development / the legacy in-process
   * path). Security-relevant, so it is an explicit, caller-supplied opt-out —
   * never a silent default. Mirrors the policy `allow_unsigned` discipline.
   */
  allowUnsigned?: boolean
}

function lookupApproverKey(keys: AuthorizedApproverKeys, approverId: string): string | undefined {
  if (keys instanceof Map) return keys.get(approverId)
  return keys.find((k) => k.actor_id === approverId)?.public_key
}

/**
 * Verify a resolution's signature against the operator-pinned approver keys.
 * Throws an {@link ApprovalSignatureError} on any failure; returns normally when
 * the resolution is authentic (or unsigned under an explicit `allowUnsigned`).
 *
 * Reject set (mirrors `verifyPolicySignature`, plus the pinned-key check that is
 * the whole point):
 *   - signature absent and `allowUnsigned` not set;
 *   - `payload_hash` ≠ the recomputed canonical hash (tampered / stale);
 *   - `signer_id` ≠ the resolution's `approver_id` (a signature lifted onto a
 *     different approver's resolution);
 *   - the signer is not in the operator-pinned set (the trust root);
 *   - a non-ed25519 algorithm;
 *   - the Ed25519 signature bytes fail verification.
 */
export function verifyApprovalSignature(
  doc: ApprovalResolutionDoc,
  signature: Signature | undefined,
  options: VerifyApprovalSignatureOptions,
): void {
  if (signature === undefined) {
    if (options.allowUnsigned === true) return
    throw new ApprovalSignatureError(
      `approval resolution for action '${doc.action_id}' is unsigned; a cross-process approval must be signed (set allow_unsigned: true only for a trusted in-process / development path)`,
    )
  }
  const expected = canonicalApprovalResolutionHash(doc)
  if (signature.payload_hash !== expected) {
    throw new ApprovalSignatureError(
      `approval resolution for action '${doc.action_id}' signature payload_hash does not match the canonical document — the resolution was tampered with or the signature is stale`,
    )
  }
  if (signature.signer_id !== doc.approver_id) {
    throw new ApprovalSignatureError(
      `approval resolution signature signer_id '${signature.signer_id}' does not match approver_id '${doc.approver_id}'`,
    )
  }
  if (signature.algorithm !== "ed25519") {
    throw new ApprovalSignatureError(
      `approval resolution signature algorithm '${signature.algorithm}' is not ed25519`,
    )
  }
  const publicKeyPem = lookupApproverKey(options.authorizedKeys, signature.signer_id)
  if (publicKeyPem === undefined) {
    throw new ApprovalSignatureError(
      `approver '${signature.signer_id}' is not in the operator-pinned authorized-approver set`,
    )
  }
  let ok: boolean
  try {
    ok = verify(
      null,
      Buffer.from(expected, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.signature, "base64"),
    )
  } catch (err) {
    throw new ApprovalSignatureError(
      `approval resolution signature could not be verified: ${String(err)}`,
    )
  }
  if (!ok) {
    throw new ApprovalSignatureError(
      `approval resolution for action '${doc.action_id}' failed Ed25519 signature verification`,
    )
  }
}
