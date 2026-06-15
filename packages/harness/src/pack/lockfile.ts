import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  PACK_LOCKFILE_VERSION,
  type PackLockEntry,
  type PackLockfile,
  PackLockfileSchema,
} from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"

/**
 * Pack lockfile IO (#90, ADR-0019). The lockfile records what `lodestar pack add`
 * resolved, verified, and installed — the immutable source pin plus the canonical
 * manifest hash that verified — so an install is reproducible and auditable. It is
 * a record, not a trust boundary: a consumer re-verifies on every load rather than
 * trusting the lockfile's word.
 */

/** Default lockfile location, relative to the cwd. */
export const DEFAULT_PACK_LOCKFILE_PATH = ".lodestar/packs.lock.json"

function emptyLockfile(): PackLockfile {
  return { lockfile_version: PACK_LOCKFILE_VERSION, packs: [] }
}

/**
 * Read and validate the lockfile at `path`, returning an empty lockfile when the
 * file is absent (a first `pack add` writes it). A malformed or unknown-version
 * lockfile raises {@link ProbePackError} rather than being silently overwritten.
 */
export async function readPackLockfile(path: string): Promise<PackLockfile> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLockfile()
    throw new ProbePackError(`Could not read pack lockfile: ${path}`, { cause: err })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ProbePackError(`Pack lockfile is not valid JSON: ${path}`, { cause })
  }

  const result = PackLockfileSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Pack lockfile failed validation: ${path}\n${issues}`)
  }
  return result.data
}

/**
 * Insert or replace the entry for `entry.name` and write the lockfile atomically.
 * The file lists at most one pin per pack name, sorted by name for a stable diff;
 * a re-add of the same pack replaces its previous pin.
 */
export async function upsertPackLockEntry(
  path: string,
  entry: PackLockEntry,
): Promise<PackLockfile> {
  const current = await readPackLockfile(path)
  const packs = current.packs.filter((p) => p.name !== entry.name)
  packs.push(entry)
  packs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const next: PackLockfile = { lockfile_version: PACK_LOCKFILE_VERSION, packs }

  // Atomic write: a torn lockfile (interrupted mid-write) would fail to parse and
  // brick every later `pack add`. Write to a fresh temp then rename into place.
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw new ProbePackError(`Could not write pack lockfile: ${path}`, { cause: err })
  }
  return next
}
