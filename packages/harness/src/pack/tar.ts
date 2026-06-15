import { isAbsolute } from "node:path"
import { assertNoSymlinksOrEscapes } from "./confinement.js"
import { ProbePackError } from "./errors.js"
import { spawnCaptured } from "./run.js"

/** A scoped env for `tar`: PATH only, plus `LC_ALL=C` for a stable, locale-independent listing. */
function tarEnv(): Record<string, string> {
  const env: Record<string, string> = { LC_ALL: "C" }
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  return env
}

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
 * **The archive is scanned BEFORE any bytes are written** ({@link assertSafeEntries}):
 * a symlink or hardlink entry is rejected outright, because `tar` can write
 * *through* a symlink to outside `destDir` during extraction (the tar-slip /
 * write-through vector) — a post-extraction check would run too late, and npm
 * resolution happens before signature verification, so the archive is fully
 * untrusted. {@link assertNoSymlinksOrEscapes} then re-checks on disk as
 * defence-in-depth. A pack ships regular probe files — it has no legitimate need
 * for a link.
 */
export async function extractTarball(
  tarballPath: string,
  destDir: string,
  options: { maxListingBytes?: number } = {},
): Promise<void> {
  await assertSafeEntries(tarballPath, options.maxListingBytes)

  const result = await spawnCaptured(
    "tar",
    ["-xzf", tarballPath, "-C", destDir, "--strip-components=1"],
    { env: tarEnv() },
  )
  if (result.code !== 0) {
    throw new ProbePackError(
      `Failed to extract pack tarball (tar exited ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
    )
  }

  await assertNoSymlinksOrEscapes(destDir)
}

/**
 * Inspect the archive's entry list and reject anything unsafe BEFORE extraction
 * writes a single byte: any symlink or hardlink entry (the write-through vector),
 * or any member whose name escapes the root (`..` segment or absolute path).
 *
 * Both GNU tar and libarchive/bsdtar render a `-tv` listing in `ls -l` style: the
 * first character is the entry type (`l` symlink, `h` hardlink), and link entries
 * carry a ` -> ` / ` link to ` marker. We check both the type char and the marker.
 */
async function assertSafeEntries(tarballPath: string, maxListingBytes?: number): Promise<void> {
  const typed = await spawnCaptured("tar", ["-tzvf", tarballPath], {
    env: tarEnv(),
    maxOutputBytes: maxListingBytes,
  })
  if (typed.code !== 0) {
    throw new ProbePackError(
      `Could not list pack tarball (tar exited ${typed.code}): ${typed.stderr.trim().slice(0, 500)}`,
    )
  }
  // Fail closed on a truncated listing: if the entry list hit the capture cap, an
  // unsafe entry could sit past the cut-off and go unchecked, and extraction could
  // then write through it before the on-disk re-check runs. A pack with a listing
  // this large is not a real probe pack.
  if (typed.stdoutTruncated) {
    throw new ProbePackError(
      "Pack tarball entry listing is too large to scan safely (exceeded the capture cap) — refusing to extract.",
    )
  }
  for (const line of typed.stdout.split("\n")) {
    if (line.trim() === "") continue
    const type = line[0]
    if (type === "l" || type === "h" || line.includes(" -> ") || line.includes(" link to ")) {
      throw new ProbePackError(
        "Pack tarball contains a symbolic or hard link entry, which is not allowed — a pack ships only regular files.",
      )
    }
  }

  // Names-only listing for the traversal check (clean member names, one per line).
  const names = await spawnCaptured("tar", ["-tzf", tarballPath], {
    env: tarEnv(),
    maxOutputBytes: maxListingBytes,
  })
  if (names.code !== 0) {
    throw new ProbePackError(
      `Could not list pack tarball (tar exited ${names.code}): ${names.stderr.trim().slice(0, 500)}`,
    )
  }
  if (names.stdoutTruncated) {
    throw new ProbePackError(
      "Pack tarball entry listing is too large to scan safely (exceeded the capture cap) — refusing to extract.",
    )
  }
  for (const raw of names.stdout.split("\n")) {
    const name = raw.trim()
    if (name === "") continue
    if (name.startsWith("/") || isAbsolute(name) || name.split(/[/\\]/).includes("..")) {
      throw new ProbePackError(
        `Pack tarball contains an entry that escapes the pack root ('${name}').`,
      )
    }
  }
}
