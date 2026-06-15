import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  PROBE_PACK_MANIFEST_FILENAME,
  type PackContentDigest,
  type ProbePackManifest,
  ProbePackManifestSchema,
} from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"

/**
 * Shared pack-resolution primitives (#90, ADR-0019). Factored out of the loader so
 * `loadProbePack` (verify path) and `publishProbePack` (sign path) resolve the
 * probe files and compute the content digest the **same** way — a publish that
 * computed the digest differently than the loader verifies it would be a latent
 * forgery hole. Core owns the wire format; this is the harness's I/O-bearing
 * resolution, kept identical across both producers and consumers of a pack.
 */

/** One probe from a pack, with its source resolved to an absolute path. */
export interface LoadedProbe {
  /** Stable identifier, unique within the pack. */
  name: string
  /** The path as written in the manifest, relative to the pack root. */
  file: string
  /** Absolute path to the probe source, guaranteed to exist and to live within the pack root. */
  path: string
}

// "file" means a *regular* file specifically. A FIFO/socket/device is
// neither a regular file nor a directory and comes back as "other" —
// reading a FIFO manifest could hang readFile(), and a non-regular
// probe source violates the loader's regular-file guarantee.
export async function pathKind(p: string): Promise<"file" | "dir" | "other" | "missing"> {
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
export function escapesRoot(rel: string): boolean {
  return (
    rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)
  )
}

/** The manifest's location: the manifest file and the pack root that contains it. */
export interface LocatedManifest {
  /** Absolute path to the manifest file itself. */
  manifestPath: string
  /** Absolute path to the directory containing the manifest (the pack root). */
  root: string
}

/**
 * Resolve a `target` (a pack directory, or a manifest file directly) to its
 * manifest path + pack root, raising {@link ProbePackError} when the target is
 * missing, is neither a regular file nor a directory, or is a directory without a
 * `lodestar.probe-pack.json`. Does not read the manifest — that is
 * {@link readManifest}.
 */
export async function locateManifest(target: string): Promise<LocatedManifest> {
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

  return { manifestPath, root: dirname(manifestPath) }
}

/**
 * Read and schema-validate a manifest file, raising {@link ProbePackError} with a
 * precise message on an unreadable file, invalid JSON, or a schema failure. Does
 * no signature verification — that is the loader's verify step.
 */
export async function readManifest(manifestPath: string): Promise<ProbePackManifest> {
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
  return result.data
}

/**
 * Resolve every probe `file` the manifest declares to an absolute path inside the
 * pack root, enforcing the untrusted-manifest boundary: a duplicate probe name, a
 * path that escapes the root (lexically or via a symlink), a missing file, or a
 * non-regular file each raise {@link ProbePackError}. Returns the resolved probes
 * in manifest order.
 *
 * This is the single resolution both the loader (which then verifies the content
 * digest over these files) and the publisher (which computes the digest over them)
 * share, so the digest is computed over exactly the bytes the loader later checks.
 */
export async function resolveProbeFiles(
  manifest: ProbePackManifest,
  root: string,
): Promise<LoadedProbe[]> {
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
  return probes
}

/**
 * Recompute the content digest over the resolved probe files: a sorted per-file
 * sha-256 list keyed by the path as declared in the manifest (relative, so the
 * digest is portable across machines). The loader compares this against the
 * manifest's signed `content_digest`; the publisher writes it as that digest.
 */
export async function computePackContentDigest(probes: LoadedProbe[]): Promise<PackContentDigest> {
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
 * Compare an on-disk content digest to a manifest's signed one, throwing a
 * {@link ProbePackError} that names the first offending file on any mismatch
 * (changed bytes, an added file, or a removed file).
 */
export function assertContentDigestMatches(
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
