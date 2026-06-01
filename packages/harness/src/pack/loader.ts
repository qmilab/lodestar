import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  PROBE_PACK_MANIFEST_FILENAME,
  type ProbePackManifest,
  ProbePackManifestSchema,
} from "@qmilab/lodestar-core"
import { FIRST_PARTY_SENTINELS, type SentinelFactory } from "../sentinels/registry.js"

/**
 * Raised for every failure mode of pack loading: missing manifest,
 * malformed JSON, schema-invalid manifest, an unsupported source type,
 * a probe file that escapes the pack root, a missing probe file, a
 * duplicate probe name, or a sentinel that is unknown or declared twice.
 * A single typed error lets callers (the CLI, a runner) distinguish
 * "this pack is broken" from an unexpected crash.
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
 * host's (it calls the resolved `create` factory). Passes for
 * `source_type: "npm"` are rejected: the v0 loader resolves `local`
 * packs only.
 *
 * Throws {@link ProbePackError} on any failure.
 */
export async function loadProbePack(target: string): Promise<LoadedProbePack> {
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

  return { manifest, root, manifestPath, probes, sentinels }
}
