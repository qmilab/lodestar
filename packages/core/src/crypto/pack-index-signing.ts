import type { Signature } from "../schemas/actor.js"
import type { PackIndex } from "../schemas/pack-index.js"
import { canonicalHashHex } from "./canonical.js"
import {
  type PinnedPublicKeys,
  type SignatureErrorFactory,
  signPayloadHash,
  verifyPayloadHashSignature,
} from "./signing.js"

/**
 * Discovery-index signing (ADR-0021, #87) — the registry's read-side trust seam.
 *
 * Structurally identical to `probe-pack-signing.ts` and `badge-signing.ts`: the
 * signature is computed over the **canonical index** (every field except the detached
 * `signature`), reusing the one audited Ed25519 primitive in `signing.ts`. Nothing
 * new cryptographically — an index is just another canonical document signed by a key
 * the consumer pins, this time under the separate `index_publisher_keys` trust root.
 *
 * An index signature authenticates the *advertisement* (the listing was published by
 * a pinned publisher and not edited since), not the *packs* it lists: a verified index
 * still only advertises, and choosing a pack routes through #86/#88 against pinned
 * author keys. So this verifier is the gate on whether to trust the listing, never on
 * whether a pack is safe to install.
 */

/**
 * The signable view of an index: the whole document minus the detached `signature`
 * (a document cannot sign over its own signature). `publisher_id` and `generated_at`
 * are retained — they are ordinary fields the signature binds.
 */
export function canonicalPackIndexDocument(index: PackIndex): Omit<PackIndex, "signature"> {
  const { signature: _signature, ...rest } = index
  return rest
}

/** sha-256 hex of the canonical index document. */
export function canonicalPackIndexHash(index: PackIndex): string {
  return canonicalHashHex(canonicalPackIndexDocument(index))
}

/**
 * Sign an index with the publisher's Ed25519 private key, returning the detached
 * `Signature`. The index must already carry its `publisher_id` (the producer sets it
 * before calling this). `at` is caller-supplied, keeping this pure.
 */
export function signPackIndex(
  index: PackIndex,
  args: {
    publisherId: string
    privateKeyPem: string
    at: string
    makeError?: SignatureErrorFactory
  },
): Signature {
  const makeError = args.makeError ?? ((m: string) => new Error(m))
  return signPayloadHash({
    payloadHash: canonicalPackIndexHash(index),
    signerId: args.publisherId,
    privateKeyPem: args.privateKeyPem,
    at: args.at,
    makeError,
  })
}

export interface VerifyPackIndexOptions {
  /** Operator-pinned index-publisher public keys: `publisher_id → SPKI PEM`. The trust root. */
  authorizedIndexPublisherKeys: PinnedPublicKeys
  /**
   * Allow an *unsigned* index (a local dev / private listing). Explicit opt-out, never
   * a silent default. A *signed* index is always fully verified regardless of this flag.
   */
  allowUnsigned?: boolean
  /** Domain-typed error factory (the harness passes its `ProbePackError`). */
  makeError: SignatureErrorFactory
}

/**
 * Verify an index's signature against operator-pinned publisher keys (the tamper +
 * forgery defence). Throws via `makeError` on any failure — signed but no
 * `publisher_id` to bind, signer ≠ declared `publisher_id`, publisher not pinned,
 * non-ed25519, tampered (`payload_hash` mismatch), bad signature bytes, or unsigned
 * without `allowUnsigned`. Returns normally when authentic (or unsigned under an
 * explicit opt-out).
 *
 * The expected signer is the index's declared `publisher_id`; a signed index with no
 * `publisher_id` is rejected (nothing to bind the signer to), mirroring the manifest
 * verifier's `author_id` guard.
 */
export function verifyPackIndexSignature(index: PackIndex, options: VerifyPackIndexOptions): void {
  const subject = "discovery index"
  if (index.signature !== undefined && index.publisher_id === undefined) {
    throw options.makeError(
      `${subject} is signed but declares no publisher_id to bind the signature to.`,
    )
  }
  verifyPayloadHashSignature(index.signature, {
    expectedPayloadHash: canonicalPackIndexHash(index),
    // Unused for an unsigned index (signature undefined); for a signed one
    // publisher_id is guaranteed present by the guard above.
    expectedSignerId: index.publisher_id ?? "",
    authorizedKeys: options.authorizedIndexPublisherKeys,
    allowUnsigned: options.allowUnsigned,
    subject,
    makeError: options.makeError,
  })
}
