import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  PROBE_PACK_MANIFEST_FILENAME,
  type PackContentDigest,
  type PackSourceRef,
  type PinnedPublicKeys,
  type ProbePackManifest,
  ProbePackManifestSchema,
  verifyProbePackManifestSignature,
} from "@qmilab/lodestar-core"
import { FIRST_PARTY_SENTINELS, type SentinelFactory } from "../sentinels/registry.js"
import { ProbePackError } from "./errors.js"
import {
  type ResolvePackSourceOptions,
  type ResolvedPackSource,
  resolvePackSource,
} from "./source.js"

// ProbePackError lives in ./errors.js (so the source resolvers can raise it
// without an import cycle); re-exported here because it has always been part of
// the loader's public surface.
export { ProbePackError } from "./errors.js"

/** One probe from a loaded pack, with its source resolved to an absolute path. */
export interface LoadedProbe {
  /** Stable identifier, unique within the pack. */
  name: string
  /** The path as written in the manifest, relative to the pack root. */
  file: string
  /** Absolute path to the probe source, guaranteed to exist and to live within the pack root. */
  path: string
}

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

// "file" means a *regular* file specifically. A FIFO/socket/device is
// neither a regular file nor a directory and comes back as "other" —
// reading a FIFO manifest could hang readFile(), and a non-regular
// probe source violates the loader's regular-file guarantee.
async function pathKind(p: string): Promise<"file" | "dir" | "other" | "missing"> {
  try {
    const s = await stat(p)
    if (s.isDirectory()) return "dir"
    if (s.isFile()) return "file"
    return "other"
  } catch {
    return "missing"
  }
}

// Given a path relative to the pack root, does it point at or outside
// the root? Escape means a leading `..` *segment* or an absolute path.
// Test the segment, not a bare "..": "..fixtures/p.ts" is a legitimate
// in-pack name whose relative form merely starts with two dots.
function escapesRoot(rel: string): boolean {
  return (
    rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)
  )
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
 * Recompute the content digest over the resolved probe files: a sorted per-file
 * sha-256 list keyed by the path as declared in the manifest (relative, so the
 * digest is portable across machines). Compared against the manifest's signed
 * `content_digest` so a swapped probe byte is caught even under a valid signature.
 */
async function computePackContentDigest(probes: LoadedProbe[]): Promise<PackContentDigest> {
  const files = await Promise.all(
    probes.map(async (p) => ({
      path: p.file,
      sha256: createHash("sha256")
        .update(await readFile(p.path))
        .digest("hex"),
    })),
  )
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { algorithm: "sha256", files }
}

/**
 * Compare the on-disk content digest to the manifest's signed one, throwing a
 * {@link ProbePackError} that names the first offending file on any mismatch
 * (changed bytes, an added file, or a removed file).
 */
function assertContentDigestMatches(
  packName: string,
  declared: PackContentDigest,
  recomputed: PackContentDigest,
): void {
  const declaredMap = new Map(declared.files.map((f) => [f.path, f.sha256]))
  const recomputedMap = new Map(recomputed.files.map((f) => [f.path, f.sha256]))
  for (const [path, sha256] of recomputedMap) {
    const expected = declaredMap.get(path)
    if (expected === undefined) {
      throw new ProbePackError(
        `Pack '${packName}' content digest mismatch: file '${path}' is present on disk but not in the signed content_digest.`,
      )
    }
    if (expected !== sha256) {
      throw new ProbePackError(
        `Pack '${packName}' content digest mismatch: file '${path}' has been modified since it was signed (on-disk sha256 ${sha256.slice(0, 12)}… ≠ signed ${expected.slice(0, 12)}…).`,
      )
    }
  }
  for (const path of declaredMap.keys()) {
    if (!recomputedMap.has(path)) {
      throw new ProbePackError(
        `Pack '${packName}' content digest mismatch: signed file '${path}' is missing from the resolved pack.`,
      )
    }
  }
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
  const absTarget = resolve(target)
  const kind = await pathKind(absTarget)

  if (kind === "missing") {
    throw new ProbePackError(`Probe pack path does not exist: ${absTarget}`)
  }
  if (kind === "other") {
    throw new ProbePackError(
      `Probe pack path is neither a regular file nor a directory: ${absTarget}`,
    )
  }

  const manifestPath = kind === "dir" ? join(absTarget, PROBE_PACK_MANIFEST_FILENAME) : absTarget

  if (kind === "dir" && (await pathKind(manifestPath)) !== "file") {
    throw new ProbePackError(
      `No ${PROBE_PACK_MANIFEST_FILENAME} found in pack directory: ${absTarget}`,
    )
  }

  let raw: string
  try {
    raw = await readFile(manifestPath, "utf8")
  } catch (cause) {
    throw new ProbePackError(`Could not read manifest: ${manifestPath}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ProbePackError(`Manifest is not valid JSON: ${manifestPath}`, { cause })
  }

  const result = ProbePackManifestSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Manifest failed validation: ${manifestPath}\n${issues}`)
  }
  const manifest = result.data

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

  const root = dirname(manifestPath)
  // Canonical pack root, used for the post-symlink containment check.
  const realRoot = await realpath(root)

  const seen = new Set<string>()
  const probes: LoadedProbe[] = []
  for (const entry of manifest.probes) {
    if (seen.has(entry.name)) {
      throw new ProbePackError(
        `Pack '${manifest.name}' declares probe name '${entry.name}' more than once.`,
      )
    }
    seen.add(entry.name)

    const probePath = resolve(root, entry.file)
    // Security boundary: a pack manifest is potentially third-party. A
    // probe file must stay within the pack root — reject any `file` that
    // escapes it (e.g. "../../etc/passwd") before we ever touch the path.
    const rel = relative(root, probePath)
    if (escapesRoot(rel)) {
      throw new ProbePackError(
        `Probe '${entry.name}' resolves outside the pack root: '${entry.file}' (pack root ${root}).`,
      )
    }

    // The lexical check above is not enough: the probe file (or a
    // directory along the way) may be a symlink whose real target lives
    // outside the pack root. realpath follows every link; re-check
    // containment against the canonical root so a symlinked escape
    // (e.g. probes/p.ts -> /etc/passwd) is rejected. realpath also
    // throws if the path does not exist — that is the "not found" case.
    let realProbe: string
    try {
      realProbe = await realpath(probePath)
    } catch (cause) {
      throw new ProbePackError(
        `Probe '${entry.name}' file not found: ${probePath} (declared as '${entry.file}').`,
        { cause },
      )
    }

    const realRel = relative(realRoot, realProbe)
    if (escapesRoot(realRel)) {
      throw new ProbePackError(
        `Probe '${entry.name}' resolves outside the pack root via a symlink: '${entry.file}' -> ${realProbe} (pack root ${realRoot}).`,
      )
    }

    if ((await pathKind(realProbe)) !== "file") {
      throw new ProbePackError(
        `Probe '${entry.name}' is not a regular file: ${probePath} (declared as '${entry.file}').`,
      )
    }

    probes.push({ name: entry.name, file: entry.file, path: probePath })
  }

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
