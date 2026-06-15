import type { Signature } from "../schemas/actor.js"
import type { PackBadge, UnsignedPackBadge } from "../schemas/pack-badge.js"
import { canonicalHashHex } from "./canonical.js"
import {
  type PinnedPublicKeys,
  type SignatureErrorFactory,
  signPayloadHash,
  verifyPayloadHashSignature,
} from "./signing.js"

/**
 * Badge signing (ADR-0020, #89) — the registry's second trust axis.
 *
 * Structurally identical to `probe-pack-signing.ts`: the signature is computed over
 * the **canonical badge** (every field except the detached `signature`), reusing
 * the one audited Ed25519 primitive in `signing.ts`. Nothing new cryptographically —
 * a badge is just another canonical document signed by a key the consumer pins.
 *
 * Two checks make a badge trustworthy, and they are deliberately separate:
 *  - {@link verifyPackBadgeSignature} — the signature verifies against an
 *    operator-pinned **attester** key (the forgery defence).
 *  - {@link assertBadgeAppliesTo} — the badge's `subject.manifest_hash` matches the
 *    pack actually being verified (the mis-attach defence).
 *
 * Both *throw* on failure (consistent with the manifest verifier). The harness's
 * `verifyPackBadges` wraps them in try/catch to classify into the advisory
 * verified / unverified / not-applicable surface — because badges are advisory
 * signal, never a fail-closed gate (ADR-0016 §3). Pure compute over core's own
 * types; the filesystem read of `badges/` lives in the harness.
 */

/**
 * The signable view of a badge: the whole badge minus the detached `signature` (a
 * document cannot sign over its own signature). Accepts a signed badge or an
 * already-unsigned one (the producer's pre-sign assembly).
 */
export function canonicalBadgeDocument(badge: PackBadge | UnsignedPackBadge): UnsignedPackBadge {
  const { signature: _signature, ...rest } = badge as PackBadge
  return rest as UnsignedPackBadge
}

/** sha-256 hex of the canonical badge document. */
export function canonicalBadgeHash(badge: PackBadge | UnsignedPackBadge): string {
  return canonicalHashHex(canonicalBadgeDocument(badge))
}

/**
 * Sign an assembled (unsigned) badge with the attester's Ed25519 private key,
 * returning the badge with its `signature` attached. The signer id is the badge's
 * own `attester_id` — so `signature.signer_id === attester_id` by construction, the
 * binding the verifier checks. `at` is caller-supplied, keeping this pure.
 *
 * Generic over the badge kind so a `probe_results` badge in yields a signed
 * `probe_results` badge out (the discriminated `result` typing survives).
 */
export function signPackBadge<B extends UnsignedPackBadge>(
  badge: B,
  args: { privateKeyPem: string; at: string; makeError?: SignatureErrorFactory },
): B & { signature: Signature } {
  const makeError = args.makeError ?? ((m: string) => new Error(m))
  const signature = signPayloadHash({
    payloadHash: canonicalBadgeHash(badge),
    signerId: badge.attester_id,
    privateKeyPem: args.privateKeyPem,
    at: args.at,
    makeError,
  })
  return { ...badge, signature }
}

export interface VerifyPackBadgeOptions {
  /** Operator-pinned **attester** public keys: `attester_id → SPKI PEM`. The trust root. */
  authorizedAttesterKeys: PinnedPublicKeys
  /** Domain-typed error factory (the harness passes its `ProbePackError`). */
  makeError: SignatureErrorFactory
}

/**
 * Verify a badge's signature against operator-pinned attester keys (the forgery
 * defence). Throws via `makeError` on any failure — signer ≠ declared `attester_id`,
 * attester not pinned, non-ed25519, tampered (`payload_hash` mismatch), or bad
 * signature bytes. A badge always carries a signature (required by the schema), so
 * there is no `allowUnsigned` path here — an unsigned document is not a badge.
 *
 * This does NOT check that the badge applies to the pack — that is
 * {@link assertBadgeAppliesTo}, kept separate so a mis-attach and a forgery are
 * distinguishable in the surfaced result.
 */
export function verifyPackBadgeSignature(badge: PackBadge, options: VerifyPackBadgeOptions): void {
  verifyPayloadHashSignature(badge.signature, {
    expectedPayloadHash: canonicalBadgeHash(badge),
    expectedSignerId: badge.attester_id,
    authorizedKeys: options.authorizedAttesterKeys,
    subject: `${badge.kind} badge for pack '${badge.subject.pack}'`,
    makeError: options.makeError,
  })
}

/** The pack identity a badge is checked against — recomputed by the consumer. */
export interface BadgeSubjectExpectation {
  /** The verified pack's manifest name. */
  packName: string
  /** The verified pack's manifest version. */
  packVersion: string
  /** The verified pack's canonical manifest hash — the load-bearing binding. */
  manifestHash: string
}

/**
 * Assert a badge's `subject` applies to the pack being verified (the mis-attach
 * defence), throwing via `makeError` otherwise. The authoritative check is
 * `manifest_hash` — it binds the exact signed bytes — with `pack` / `version`
 * cross-checked for a consistent, human-legible subject. A badge whose subject hash
 * does not match was attached to a different pack (or version) than the one on disk.
 */
export function assertBadgeAppliesTo(
  badge: PackBadge,
  expected: BadgeSubjectExpectation,
  makeError: SignatureErrorFactory,
): void {
  const label = `${badge.kind} badge`
  if (badge.subject.manifest_hash !== expected.manifestHash) {
    throw makeError(
      `${label} does not apply to this pack: its subject manifest_hash ${badge.subject.manifest_hash.slice(
        0,
        12,
      )}… ≠ the pack's ${expected.manifestHash.slice(0, 12)}… — it was issued over different bytes (a mis-attached badge).`,
    )
  }
  if (badge.subject.pack !== expected.packName) {
    throw makeError(
      `${label} names pack '${badge.subject.pack}', but this pack is '${expected.packName}'.`,
    )
  }
  if (badge.subject.version !== expected.packVersion) {
    throw makeError(
      `${label} names version '${badge.subject.version}', but this pack is version '${expected.packVersion}'.`,
    )
  }
}
