import { createHash } from "node:crypto"
import {
  type PinnedPublicKeys,
  type Signature,
  assertValidPublicKeys,
  generateEd25519KeyPair,
  signPayloadHash,
  stableStringify,
  verifyPayloadHashSignature,
} from "@qmilab/lodestar-core"

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
  // Delegates to the shared core primitive (ADR-0017); `makeError` keeps every
  // failure a typed ApprovalSignatureError rather than an opaque OpenSSL message.
  return signPayloadHash({
    payloadHash: canonicalApprovalResolutionHash(doc),
    signerId: doc.approver_id,
    privateKeyPem,
    at: doc.at,
    makeError: (m) => new ApprovalSignatureError(m),
  })
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
  return generateEd25519KeyPair()
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
  assertValidPublicKeys(keys, (m) => new ApprovalSignatureError(m))
}

/** Operator-pinned approver public keys: `approver_id → SPKI PEM public key`. */
export type AuthorizedApproverKeys = PinnedPublicKeys

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
  // Delegates the full reject set to the shared core primitive (ADR-0017),
  // binding the expected signer to the resolution's approver_id and keeping every
  // failure a typed ApprovalSignatureError.
  verifyPayloadHashSignature(signature, {
    expectedPayloadHash: canonicalApprovalResolutionHash(doc),
    expectedSignerId: doc.approver_id,
    authorizedKeys: options.authorizedKeys,
    allowUnsigned: options.allowUnsigned,
    subject: `approval resolution for action '${doc.action_id}'`,
    makeError: (m) => new ApprovalSignatureError(m),
  })
}
