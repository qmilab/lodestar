import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  PROBE_PACK_MANIFEST_FILENAME,
  type ProbePackManifest,
  ProbePackManifestSchema,
} from "@qmilab/lodestar-core"

/**
 * Raised for every failure mode of pack loading: missing manifest,
 * malformed JSON, schema-invalid manifest, an unsupported source type,
 * a probe file that escapes the pack root, a missing probe file, or a
 * duplicate probe name. A single typed error lets callers (the CLI, a
 * runner) distinguish "this pack is broken" from an unexpected crash.
 */
export class ProbePackError extends Error {
  override readonly name = "ProbePackError"
}

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
}

async function pathKind(p: string): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await stat(p)
    return s.isDirectory() ? "dir" : "file"
  } catch {
    return "missing"
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
 * and lives inside the pack root. It does NOT execute probes — running
 * is the runner's job (Batch 4 step 5). Passes for `source_type: "npm"`
 * are rejected: the v0 loader resolves `local` packs only.
 *
 * Throws {@link ProbePackError} on any failure.
 */
export async function loadProbePack(target: string): Promise<LoadedProbePack> {
  const absTarget = resolve(target)
  const kind = await pathKind(absTarget)

  if (kind === "missing") {
    throw new ProbePackError(`Probe pack path does not exist: ${absTarget}`)
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

  if (manifest.source_type === "npm") {
    throw new ProbePackError(
      `Pack '${manifest.name}' declares source_type "npm", which the v0 harness loader does not resolve. Use source_type "local" until npm pack resolution ships.`,
    )
  }

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
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
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
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
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

  return { manifest, root, manifestPath, probes }
}
