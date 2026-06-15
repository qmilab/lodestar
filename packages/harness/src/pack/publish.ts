import { writeFile } from "node:fs/promises"
import {
  type PackContentDigest,
  type ProbePackManifest,
  ProbePackManifestSchema,
  type ProbePackSourceType,
  canonicalProbePackManifestHash,
  publicKeyPemFromPrivate,
  signProbePackManifest,
} from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { loadProbePack } from "./loader.js"
import {
  computePackContentDigest,
  locateManifest,
  readManifest,
  resolveProbeFiles,
} from "./resolve.js"

/**
 * `publishProbePack` — the author side of the registry flow (#90, ADR-0019).
 *
 * Freezes a pack's declared probe files, computes the `content_digest` over the
 * frozen bytes, assembles the signed manifest (`author_id` + `content_digest`),
 * signs the canonical document with the author's Ed25519 key, writes it back in
 * place, then **self-verifies** by re-loading the written pack through the same
 * `loadProbePack` a consumer uses — so a pack that would not verify on a consumer's
 * machine fails here, at publish, not theirs.
 *
 * The order is the ADR-0016 §2 consequence: the digest is computed over the *final*
 * files and the signature covers that digest, so tooling cannot sign a manifest and
 * then mutate the files it covers. This signs the manifest in place; pushing the
 * artifact to npm/git is the author's own subsequent step.
 */

export interface PublishProbePackOptions {
  /** Pack directory (or its manifest file) to sign in place. */
  target: string
  /** The author signer id — written as `author_id` and bound to the signature. */
  authorId: string
  /**
   * The author's Ed25519 PKCS#8 PEM private key. The matching public key is
   * derived from it (to self-verify and to print the consumer pin); the key
   * material is never logged or returned.
   */
  privateKeyPem: string
  /** Signature timestamp (ISO 8601). Caller-supplied, keeping publish deterministic. */
  at: string
  /**
   * Override the manifest's declared `source_type` — e.g. set `npm` on a pack
   * authored with `source_type: "local"` before publishing it to npm, so the
   * consumer's source-resolution cross-check passes. Absent leaves it unchanged.
   */
  sourceType?: ProbePackSourceType
}

export interface PublishedProbePack {
  /** The signed manifest as written to disk. */
  manifest: ProbePackManifest
  /** Absolute path of the manifest that was signed in place. */
  manifestPath: string
  /** The content digest the signature binds. */
  contentDigest: PackContentDigest
  /** Canonical hash of the signed manifest (the value `pack add` records in the lockfile). */
  manifestHash: string
  /**
   * The author's SPKI PEM public key, derived from the private key — the pin a
   * consumer adds to their trust config to verify packs from this author.
   */
  publicKeyPem: string
}

export async function publishProbePack(
  options: PublishProbePackOptions,
): Promise<PublishedProbePack> {
  const { target, authorId, privateKeyPem, at, sourceType } = options

  // Derive the public key first: it fails fast on a bad/non-Ed25519 key (before any
  // file is touched), and it is what we self-verify with and print as the pin.
  const publicKeyPem = publicKeyPemFromPrivate(privateKeyPem, (m) => new ProbePackError(m))

  const { manifestPath, root } = await locateManifest(target)
  const source = await readManifest(manifestPath)

  // Freeze the files, THEN digest, THEN sign (ADR-0016 §2). resolveProbeFiles is the
  // exact resolution the loader verifies against, so the digest binds the same bytes.
  const probes = await resolveProbeFiles(source, root)
  const contentDigest = await computePackContentDigest(probes)

  // Assemble the signable manifest: drop any stale signature, set the author +
  // digest, and optionally rewrite source_type. author_id and content_digest are
  // ordinary fields, so they sit inside the canonical document the signature covers.
  const { signature: _staleSignature, ...rest } = source
  const signable: ProbePackManifest = {
    ...rest,
    source_type: sourceType ?? source.source_type,
    author_id: authorId,
    content_digest: contentDigest,
  }

  const signature = signProbePackManifest(signable, {
    authorId,
    privateKeyPem,
    at,
    makeError: (m) => new ProbePackError(m),
  })
  const signed: ProbePackManifest = { ...signable, signature }

  // Belt + suspenders: the assembled manifest must still satisfy the schema before
  // it is written. (Catches an over-long field or an out-of-range value the source
  // manifest somehow carried that the signature would otherwise bless.)
  const reparsed = ProbePackManifestSchema.safeParse(signed)
  if (!reparsed.success) {
    const issues = reparsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Signed manifest failed schema validation:\n${issues}`)
  }

  await writeFile(manifestPath, `${JSON.stringify(reparsed.data, null, 2)}\n`, "utf8")

  // Self-verify the written pack through the consumer's exact load path, with the
  // author pinned and allow_unsigned OFF. If the publisher and loader ever disagree
  // (a digest drift, a schema gap), it surfaces HERE rather than on a consumer's
  // machine. The pack is already on disk; a failure means a real bug to fix.
  try {
    await loadProbePack(root, {
      authorizedAuthorKeys: [{ actor_id: authorId, public_key: publicKeyPem }],
      allowUnsigned: false,
    })
  } catch (cause) {
    throw new ProbePackError(
      `Pack '${signed.name}' was signed and written to ${manifestPath} but failed self-verification: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }

  return {
    manifest: reparsed.data,
    manifestPath,
    contentDigest,
    manifestHash: canonicalProbePackManifestHash(reparsed.data),
    publicKeyPem,
  }
}
