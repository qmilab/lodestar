import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { ProbePackError } from "./errors.js"
import { spawnCaptured } from "./run.js"

/**
 * Extract a gzipped npm tarball (`.tgz`) into `destDir` using the system `tar`,
 * then enforce confinement over the result.
 *
 * This is a NON-EXECUTING fetch step (ADR-0016 §1): it only unpacks bytes. It
 * never runs `npm install` or any lifecycle script (`preinstall`/`postinstall`),
 * so a pack is treated as a trust artifact, not capability — no pack-authored
 * code runs before the signature and content digest verify.
 *
 * We shell out to the system `tar` (the same posture as the git adapter shelling
 * to system `git`) rather than take a `node-tar` dependency: `tar` handles every
 * archive format variant (ustar / GNU / PAX long names) correctly, and we layer
 * our own confinement on top. The conventional npm `package/` top-level prefix
 * is stripped so `destDir` directly contains the manifest and probe files.
 *
 * `tar` itself refuses absolute paths and `..` components, and we extract into a
 * fresh empty directory; afterwards {@link assertNoSymlinksOrEscapes} rejects the
 * whole pack if any extracted entry is a symlink or resolves outside `destDir`
 * (the tar-slip boundary). A pack ships regular probe files — it has no
 * legitimate need for a symlink.
 */
export async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  const env: Record<string, string> = {}
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH

  const result = await spawnCaptured(
    "tar",
    ["-xzf", tarballPath, "-C", destDir, "--strip-components=1"],
    { env },
  )
  if (result.code !== 0) {
    throw new ProbePackError(
      `Failed to extract pack tarball (tar exited ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
    )
  }

  await assertNoSymlinksOrEscapes(destDir)
}

/**
 * Recursively reject any symlink in the extracted tree, and any entry whose real
 * path escapes `destDir`. Closes the residual tar-slip vector — a symlink written
 * during extraction that a later read could follow outside the pack root.
 */
async function assertNoSymlinksOrEscapes(destDir: string): Promise<void> {
  const realRoot = await realpath(destDir)

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const stats = await lstat(abs)
      if (stats.isSymbolicLink()) {
        throw new ProbePackError(
          `Extracted pack contains a symlink ('${relative(destDir, abs)}'), which is not allowed — a pack ships only regular files.`,
        )
      }
      const real = await realpath(abs)
      const rel = relative(realRoot, real)
      if (
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${"/"}`) ||
        rel.startsWith("..\\") ||
        isAbsolute(rel)
      ) {
        throw new ProbePackError(
          `Extracted pack entry escapes the pack root: '${relative(destDir, abs)}' -> ${real}.`,
        )
      }
      if (stats.isDirectory()) await walk(abs)
    }
  }

  await walk(destDir)
}
