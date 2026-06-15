import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { ProbePackError } from "./errors.js"

/**
 * Recursively reject any symlink in a resolved pack tree, and any entry whose real
 * path escapes `rootDir`. Shared by both the npm extraction path
 * ({@link extractTarball}) and the git checkout path ({@link resolveGitSource}).
 *
 * This must run **before** the resolved root is handed to `loadProbePack`: the
 * loader reads `<root>/lodestar.probe-pack.json` before establishing any realpath
 * containment, so a symlinked manifest (or any symlinked file) would otherwise be
 * followed outside the root *before verification*. A pack ships regular files —
 * it has no legitimate need for a symlink.
 */
export async function assertNoSymlinksOrEscapes(rootDir: string): Promise<void> {
  const realRoot = await realpath(rootDir)

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const stats = await lstat(abs)
      if (stats.isSymbolicLink()) {
        throw new ProbePackError(
          `Resolved pack contains a symlink ('${relative(rootDir, abs)}'), which is not allowed — a pack ships only regular files.`,
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
          `Resolved pack entry escapes the pack root: '${relative(rootDir, abs)}' -> ${real}.`,
        )
      }
      if (stats.isDirectory()) await walk(abs)
    }
  }

  await walk(rootDir)
}
