import type { Signature } from "../schemas/actor.js"
import type { ProbePackManifest } from "../schemas/probe-pack.js"
import { canonicalHashHex } from "./canonical.js"
import {
  type PinnedPublicKeys,
  type SignatureErrorFactory,
  signPayloadHash,
  verifyPayloadHashSignature,
} from "./signing.js"

/**
 * Pack-manifest signing (ADR-0017, #88) — the registry trust root.
 *
 * The signature is computed over the **canonical manifest**: every field except
 * the detached `signature` itself. Because `content_digest` and `author_id` are
 * ordinary manifest fields, they are inside the signed document automatically — so
 * signing the manifest transitively authenticates the declared probe bytes (via
 * `content_digest`) and pins the author. A verifier reproduces the exact signed
 * bytes from the rest of the manifest.
 *
 * Pure compute: the canonical hash and the Ed25519 sign/verify live here in core
 * over core's own types. Computing `content_digest` over the on-disk probe files
 * requires fs and lives in the harness loader, which calls
 * {@link verifyProbePackManifestSignature} for the signature half and then
 * recomputes + compares the content digest itself.
 */

/**
 * The signable view of a manifest: the whole manifest minus the detached
 * `signature` (a document cannot sign over its own signature). `content_digest`
 * and `author_id` are retained — they are what bind contents and author.
 */
export function canonicalProbePackManifestDocument(
  manifest: ProbePackManifest,
): Omit<ProbePackManifest, "signature"> {
  const { signature: _signature, ...rest } = manifest
  return rest
}

/** sha-256 hex of the canonical manifest document. */
export function canonicalProbePackManifestHash(manifest: ProbePackManifest): string {
  return canonicalHashHex(canonicalProbePackManifestDocument(manifest))
}

/**
 * Sign a manifest with the author's Ed25519 private key, returning the detached
 * `Signature`. The manifest must already carry its `author_id` and
 * `content_digest` (the producer — the future publish CLI, #90 — computes the
 * content digest over frozen files before calling this). `at` is supplied by the
 * caller, keeping this pure.
 */
export function signProbePackManifest(
  manifest: ProbePackManifest,
  args: { authorId: string; privateKeyPem: string; at: string; makeError?: SignatureErrorFactory },
): Signature {
  const makeError = args.makeError ?? ((m: string) => new Error(m))
  return signPayloadHash({
    payloadHash: canonicalProbePackManifestHash(manifest),
    signerId: args.authorId,
    privateKeyPem: args.privateKeyPem,
    at: args.at,
    makeError,
  })
}

export interface VerifyProbePackManifestOptions {
  /** Operator-pinned author public keys: `author_id → SPKI PEM`. The trust root. */
  authorizedAuthorKeys: PinnedPublicKeys
  /**
   * Allow an *unsigned* manifest (a trusted first-party in-repo pack / local dev).
   * Explicit opt-out, never a silent default. A *signed* manifest is always fully
   * verified regardless of this flag.
   */
  allowUnsigned?: boolean
  /** Domain-typed error factory (the harness passes its `ProbePackError`). */
  makeError: SignatureErrorFactory
}

/**
 * Verify a manifest's signature against operator-pinned author keys (pure — the
 * signature half only). Throws via `makeError` on any failure; returns normally
 * when authentic (or unsigned under an explicit `allowUnsigned`).
 *
 * The expected signer is the manifest's declared `author_id`; a signed manifest
 * with no `author_id` is rejected (nothing to bind the signer to). The caller
 * (the harness loader) separately recomputes the `content_digest` from the
 * resolved files and compares it to the declared one — together the two checks
 * make the on-disk bytes authentic.
 */
export function verifyProbePackManifestSignature(
  manifest: ProbePackManifest,
  options: VerifyProbePackManifestOptions,
): void {
  const subject = `probe pack '${manifest.name}'`
  if (manifest.signature !== undefined && manifest.author_id === undefined) {
    throw options.makeError(
      `${subject} is signed but declares no author_id to bind the signature to.`,
    )
  }
  verifyPayloadHashSignature(manifest.signature, {
    expectedPayloadHash: canonicalProbePackManifestHash(manifest),
    // For an unsigned manifest this value is unused (the signature is undefined);
    // for a signed one author_id is guaranteed present by the guard above.
    expectedSignerId: manifest.author_id ?? "",
    authorizedKeys: options.authorizedAuthorKeys,
    allowUnsigned: options.allowUnsigned,
    subject,
    makeError: options.makeError,
  })
}
