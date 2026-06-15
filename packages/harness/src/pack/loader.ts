import type { PackSourceRef, PinnedPublicKeys, ProbePackManifest } from "@qmilab/lodestar-core"
import { verifyProbePackManifestSignature } from "@qmilab/lodestar-core"
import { FIRST_PARTY_SENTINELS, type SentinelFactory } from "../sentinels/registry.js"
import { ProbePackError } from "./errors.js"
import {
  type LoadedProbe,
  assertContentDigestMatches,
  computePackContentDigest,
  locateManifest,
  readManifest,
  resolveProbeFiles,
} from "./resolve.js"
import {
  type ResolvePackSourceOptions,
  type ResolvedPackSource,
  resolvePackSource,
} from "./source.js"

// ProbePackError lives in ./errors.js (so the source resolvers can raise it
// without an import cycle); re-exported here because it has always been part of
// the loader's public surface.
export { ProbePackError } from "./errors.js"

// LoadedProbe moved to ./resolve.js alongside the resolution it describes;
// re-exported here because it has always been part of the loader's public surface.
export type { LoadedProbe } from "./resolve.js"

/**
 * One sentinel from a loaded pack, resolved to its first-party factory.
 *
 * A sentinel is referenced by id, not by file: it is a stateful class the
 * {@link SentinelRunner} instantiates, not a script the runner spawns. The
 * loader resolves the id against the built-in registry and exposes the
 * factory; a host turns these into a runner with
 * `new SentinelRunner(pack.sentinels.map((s) => s.create()))`.
 */
export interface LoadedSentinel {
  /** Stable sentinel id, as written in the manifest and unique within the pack. */
  id: string
  /** Constructs a fresh instance of the sentinel with its default options. */
  create: SentinelFactory
}

/**
 * A validated, filesystem-resolved probe pack. This is the harness's
 * runtime representation; the on-disk contract is `ProbePackManifest`
 * in `@qmilab/lodestar-core`. The split is deliberate — core owns the
 * wire format and does no I/O; the harness owns resolution.
 */
export interface LoadedProbePack {
  manifest: ProbePackManifest
  /** Absolute path to the directory containing the manifest. */
  root: string
  /** Absolute path to the manifest file itself. */
  manifestPath: string
  probes: LoadedProbe[]
  /** Sentinels the pack declares, each resolved to its first-party factory. */
  sentinels: LoadedSentinel[]
  /**
   * What was resolved to produce this pack — present only when loaded via
   * {@link loadProbePackFromSource} (the npm/git/local source-resolution path,
   * #86). A direct {@link loadProbePack} over a path leaves it undefined. Records
   * the immutable pin (exact version + integrity, or full commit SHA) the
   * verified signature binds to.
   */
  source?: ResolvedPackSource
}

/**
 * Options for {@link loadProbePack} — the verify-on-load trust controls (#88,
 * ADR-0017). Both default to the secure stance: with neither supplied, a signed
 * pack cannot be verified (no pinned author) and an unsigned pack is rejected, so
 * a caller must consciously declare how it trusts the pack.
 */
export interface LoadProbePackOptions {
  /**
   * Operator-pinned author public keys (`author_id → SPKI PEM`). A signed pack
   * whose author is not in this set is rejected — the trust root. An external
   * pack must be loaded with its author pinned here.
   */
  authorizedAuthorKeys?: PinnedPublicKeys
  /**
   * Explicit opt-out: load a pack that carries no signature (a trusted first-party
   * in-repo pack, or local dev). No silent default — an external pack does not get
   * this. A *signed* pack is always fully verified regardless of this flag.
   */
  allowUnsigned?: boolean
}

/**
 * Load and validate a probe pack.
 *
 * `target` may be either the pack directory (the manifest is looked up
 * at `<dir>/lodestar.probe-pack.json`) or the manifest file directly.
 *
 * The loader validates the manifest against the core schema, resolves
 * every probe file to an absolute path, and verifies each one exists
 * and lives inside the pack root. It also resolves every declared
 * sentinel id against the built-in first-party registry (failing on an
 * unknown or duplicated id). It does NOT execute anything — neither
 * running a probe nor constructing a sentinel; running is the runner's
 * job (`runPack` in `../runner.ts`) and constructing a sentinel is the
 * host's (it calls the resolved `create` factory).
 *
 * This entry loads from a path whose bytes are already on disk and accepts any
 * declared `source_type` — a `local` pack directly, or an `npm`/`git` pack after
 * {@link loadProbePackFromSource} has fetched it to a confined directory. To
 * resolve an `npm`/`git` pack from its pinned source, call
 * {@link loadProbePackFromSource}, which fetches then delegates here.
 *
 * ## Verify-on-load (#88, ADR-0017)
 *
 * The manifest signature is the registry trust root. After schema validation the
 * loader verifies the manifest's Ed25519 signature against the operator-pinned
 * author keys in `options.authorizedAuthorKeys`, and — for a signed pack —
 * recomputes the `content_digest` over the resolved probe files and rejects a
 * mismatch, so a swapped probe byte is caught even under a valid signature. An
 * *unsigned* pack is rejected unless the caller passes an explicit
 * `options.allowUnsigned: true` (first-party in-repo packs / local dev); a
 * *signed* pack is always fully verified regardless. The reject set is: signature
 * absent (unless `allowUnsigned`), tampered manifest (`payload_hash` mismatch),
 * signer ≠ declared `author_id`, signer not pinned, non-ed25519, bad signature
 * bytes, and on-disk content-digest mismatch.
 *
 * Throws {@link ProbePackError} on any failure.
 */
export async function loadProbePack(
  target: string,
  options: LoadProbePackOptions = {},
): Promise<LoadedProbePack> {
  const { manifestPath, root } = await locateManifest(target)
  const manifest = await readManifest(manifestPath)

  // No source_type gate here: by the time this function has a path, the bytes
  // are on disk. `npm`/`git` packs are fetched to a confined directory by the
  // source resolvers (loadProbePackFromSource, #86); once resolved every source
  // type loads identically — the security work is the verify-on-load below, which
  // applies to whatever bytes are present.

  // Verify-on-load trust root (#88): the manifest signature, against the
  // operator-pinned author keys. Pure (signature half only); the content-digest
  // half follows once the probe files are resolved. Fail fast — before any fs
  // work on a forged or unsigned pack.
  verifyProbePackManifestSignature(manifest, {
    authorizedAuthorKeys: options.authorizedAuthorKeys ?? [],
    allowUnsigned: options.allowUnsigned,
    makeError: (m) => new ProbePackError(m),
  })

  // Resolve every probe file to an absolute path inside the pack root (the
  // untrusted-manifest escape + symlink containment checks live in resolve.ts,
  // shared verbatim with the publisher so the digest binds the same bytes).
  const probes = await resolveProbeFiles(manifest, root)

  // Resolve declared sentinels against the built-in first-party registry.
  // A sentinel is referenced by id (not file): it is an in-process class,
  // not a spawnable script. Resolution looks the id up to its factory; it
  // does not construct the sentinel (that stays the host's call), keeping
  // loading side-effect-free like the probe path above.
  const seenSentinels = new Set<string>()
  const sentinels: LoadedSentinel[] = []
  for (const entry of manifest.sentinels ?? []) {
    if (seenSentinels.has(entry.id)) {
      throw new ProbePackError(
        `Pack '${manifest.name}' declares sentinel id '${entry.id}' more than once.`,
      )
    }
    seenSentinels.add(entry.id)

    // Own-property lookup at the untrusted boundary (invariant 3). A
    // kebab-case id like `constructor` would otherwise read an inherited
    // Object.prototype member and pass the existence check below, yielding a
    // non-Sentinel that crashes the runner. The registry is also
    // null-prototype as a second line of defence — see registry.ts.
    const create = Object.hasOwn(FIRST_PARTY_SENTINELS, entry.id)
      ? FIRST_PARTY_SENTINELS[entry.id]
      : undefined
    if (!create) {
      const known = Object.keys(FIRST_PARTY_SENTINELS).join(", ")
      throw new ProbePackError(
        `Pack '${manifest.name}' declares unknown sentinel id '${entry.id}'. The v0 harness resolves first-party sentinels only; known ids: ${known}.`,
      )
    }
    sentinels.push({ id: entry.id, create })
  }

  // Content-binding half of verify-on-load: a signed pack must carry a
  // content_digest, and the bytes on disk must match it. The signature above
  // bound the *declared* digest; this proves the resolved files ARE those bytes,
  // closing the re-pointed-ref / re-published-artifact hole (ADR-0016 §2). An
  // unsigned (allow_unsigned) pack skips this — nothing signed it, so a declared
  // digest would carry no trust anyway.
  if (manifest.signature !== undefined) {
    if (manifest.content_digest === undefined) {
      throw new ProbePackError(
        `Pack '${manifest.name}' is signed but carries no content_digest; the signature would bind only the probe names, not their bytes. Re-publish with a content digest.`,
      )
    }
    const recomputed = await computePackContentDigest(probes)
    assertContentDigestMatches(manifest.name, manifest.content_digest, recomputed)
  }

  return { manifest, root, manifestPath, probes, sentinels }
}

/**
 * Resolve a pinned pack source to confined local bytes, then load and fully
 * verify it (#86 / ADR-0018).
 *
 * For a `local` ref this resolves in place; for `npm`/`git` it performs a
 * **non-executing fetch** to an immutable, content-verified directory (an exact
 * npm version + SRI integrity, or a full git commit SHA — a mutable branch/tag is
 * rejected) and runs no pack-authored code (no `npm install`, no git hooks)
 * before verification. It then delegates to {@link loadProbePack} over the
 * resolved root, so the #88 signature + content-digest verify-on-load applies to
 * the *fetched bytes*: a swapped artifact under a re-pointed ref fails the
 * content-digest check even if the old signature still verifies (ADR-0016 §2).
 *
 * As a consistency gate, a pack resolved via an `npm`/`git` ref must self-declare
 * the matching `source_type`; a mismatch (e.g. an npm-fetched pack whose manifest
 * claims `local`) is rejected. The returned pack carries a {@link ResolvedPackSource}
 * recording the exact pin loaded.
 *
 * Throws {@link ProbePackError} on any resolution or verification failure.
 */
export async function loadProbePackFromSource(
  ref: PackSourceRef,
  options: LoadProbePackOptions & ResolvePackSourceOptions = {},
): Promise<LoadedProbePack> {
  const resolved = await resolvePackSource(ref, options)
  const pack = await loadProbePack(resolved.root, options)

  if (resolved.ref.type !== "local" && pack.manifest.source_type !== resolved.ref.type) {
    throw new ProbePackError(
      `Pack '${pack.manifest.name}' was resolved via a '${resolved.ref.type}' source but its manifest declares source_type '${pack.manifest.source_type}'.`,
    )
  }

  return { ...pack, source: resolved }
}
