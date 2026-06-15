import { cp, mkdir, realpath, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import {
  type PackLockEntry,
  type PackSourceRef,
  type PinnedPublicKeys,
  canonicalProbePackManifestHash,
} from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { type LoadedProbePack, loadProbePack, loadProbePackFromSource } from "./loader.js"
import { upsertPackLockEntry } from "./lockfile.js"
import type { ResolvePackSourceOptions } from "./source.js"

/**
 * `addProbePack` — the consumer side of the registry flow (#90, ADR-0019).
 *
 * The whole sequence is **resolve → verify → install → record**, and the order is
 * the point: resolution is a non-executing fetch (#86) and verification is the #88
 * signature + content-digest check, both of which run **before** any pack-authored
 * code could (an `npm install` lifecycle script, a git hook) — that is what makes a
 * pack a trust artifact and not raw capability. Only a verified pack is installed
 * and recorded. Fail closed: an unverified or content-mismatched pack throws unless
 * `allowUnsigned` is set explicitly.
 */

export interface AddProbePackOptions {
  /** The immutable, pinned source descriptor to resolve (npm / git / local). */
  ref: PackSourceRef
  /** Operator-pinned author keys the manifest signature is verified against. */
  authorizedAuthorKeys?: PinnedPublicKeys
  /** Explicit opt-out: accept an unsigned pack. No silent default. */
  allowUnsigned?: boolean
  /**
   * Directory to install the verified pack into (a `<pack-name>/` subdir is
   * created beneath it). When set, the verified bytes are copied there and the
   * installed copy is re-loaded + re-verified (a TOCTOU closure). Skip install when
   * undefined.
   */
  installRoot?: string
  /** Lockfile path to record the verified pin into. Skip recording when undefined. */
  lockfilePath?: string
  /** When the pin was recorded (ISO 8601). Caller-supplied so add is deterministic. */
  at: string
  /** Cache root for the npm/git non-executing fetch. Defaults to an OS temp dir. */
  cacheRoot?: string
  /** Injection seam for tests — the npm resolver's `fetch`. */
  fetchImpl?: typeof fetch
}

export interface AddedProbePack {
  /** The verified pack, resolved to confined bytes (its `source` records the pin). */
  pack: LoadedProbePack
  /** Absolute path the pack was installed to, when `installRoot` was set. */
  installedRoot?: string
  /** The lockfile entry recorded, when `lockfilePath` was set. */
  lockEntry?: PackLockEntry
}

export async function addProbePack(options: AddProbePackOptions): Promise<AddedProbePack> {
  const { ref, authorizedAuthorKeys, allowUnsigned, installRoot, lockfilePath, at } = options

  // Resolve via the non-executing fetch, then verify on load (#86 + #88). No pack
  // code has run at this point — resolution downloads/extracts/checks-out at the
  // pin with install scripts and hooks disabled, and this returns only after the
  // signature + content digest verify over the fetched bytes.
  const resolveOpts: ResolvePackSourceOptions = {}
  if (options.cacheRoot !== undefined) resolveOpts.cacheRoot = options.cacheRoot
  if (options.fetchImpl !== undefined) resolveOpts.fetchImpl = options.fetchImpl

  const pack = await loadProbePackFromSource(ref, {
    authorizedAuthorKeys,
    allowUnsigned,
    ...resolveOpts,
  })

  let installedRoot: string | undefined
  if (installRoot !== undefined) {
    installedRoot = await installVerifiedPack(pack, resolve(installRoot), {
      authorizedAuthorKeys,
      allowUnsigned,
    })
  }

  let lockEntry: PackLockEntry | undefined
  if (lockfilePath !== undefined) {
    lockEntry = {
      name: pack.manifest.name,
      version: pack.manifest.version,
      // The validated pin from resolution (exact version + integrity, or full SHA),
      // falling back to the caller's ref for a local source resolved in place. Any
      // URL credentials are stripped — the lockfile is a durable artifact likely to
      // be committed/shared, and the pin's identity is url+commit, not the auth.
      source: lockfileSafeSource(pack.source?.ref ?? ref),
      manifest_hash: canonicalProbePackManifestHash(pack.manifest),
      added_at: at,
    }
    if (pack.manifest.author_id !== undefined) lockEntry.author_id = pack.manifest.author_id
    await upsertPackLockEntry(lockfilePath, lockEntry)
  }

  return { pack, installedRoot, lockEntry }
}

/**
 * Strip any credentials from a source descriptor before it is recorded in the
 * lockfile. A `git:https://user:token@host/repo.git` (or a credentialed npm
 * registry URL) carries a secret in its userinfo; the lockfile is a durable,
 * shareable artifact, so the recorded pin keeps the repo + commit identity but
 * never the auth — credentials are supplied out-of-band at fetch time, not from a
 * committed file. A non-URL git remote (scp-like `git@host:path`, a file path)
 * carries no userinfo secret and is left unchanged.
 */
export function lockfileSafeSource(ref: PackSourceRef): PackSourceRef {
  if (ref.type === "git") return { ...ref, url: stripUrlCredentials(ref.url) }
  if (ref.type === "npm" && ref.registry !== undefined) {
    return { ...ref, registry: stripUrlCredentials(ref.registry) }
  }
  return ref
}

/** Remove `user:password@` userinfo from a URL, leaving a non-URL string as-is. */
function stripUrlCredentials(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.username === "" && parsed.password === "") return url
  parsed.username = ""
  parsed.password = ""
  return parsed.toString()
}

/**
 * True when `a` and `b` are the same directory or one is a path-ancestor of the
 * other (a lexical comparison on resolved paths). Used to detect an install target
 * that overlaps its source: copying a directory into its own subtree fails, and
 * removing the destination first could delete the source.
 */
function pathsOverlap(a: string, b: string): boolean {
  const ar = resolve(a)
  const br = resolve(b)
  if (ar === br) return true
  const aPrefix = ar.endsWith(sep) ? ar : ar + sep
  const bPrefix = br.endsWith(sep) ? br : br + sep
  return br.startsWith(aPrefix) || ar.startsWith(bPrefix)
}

/**
 * Copy a verified pack into `<installRoot>/<pack-name>` and re-verify the installed
 * copy. The re-verification is a TOCTOU closure: it proves the installed bytes are
 * the ones that verified (and that the copy did not introduce a symlink that
 * escapes the pack root). A failed re-verify removes the partial install so a
 * broken pack is never left behind.
 *
 * When the install target **overlaps the source** — the same directory, or one
 * nested in the other — there is nothing to copy: the verified bytes already live
 * at a stable location (a local pack added from its own tree, e.g. `pack add .`
 * with the default `.lodestar/packs` install dir under it). Copying would mean
 * `fs.cp` recursing a directory into its own subtree (which fails), and the `rm`
 * below could delete the source first. In that case the source root *is* the
 * install — already verified by resolution — so it is returned without a copy.
 */
async function installVerifiedPack(
  pack: LoadedProbePack,
  installRoot: string,
  verifyOptions: { authorizedAuthorKeys?: PinnedPublicKeys; allowUnsigned?: boolean },
): Promise<string> {
  const dest = join(installRoot, pack.manifest.name)
  if (pathsOverlap(pack.root, dest)) {
    // The source is its own stable install location (verified by resolution); a
    // copy would be a self-copy. Leave the bytes in place.
    return pack.root
  }
  // Replace any existing install of this pack so a re-add is clean (no stale files
  // surviving alongside the new copy).
  await rm(dest, { recursive: true, force: true })
  await mkdir(installRoot, { recursive: true })
  // Resolve the source ROOT through symlinks so `dest` is a real directory copy.
  // Copying a symlinked root with dereference:false would make `dest` itself a
  // symlink back to the original bytes — not a stable install (later edits to the
  // source would silently change the "installed" pack without re-verification).
  // realpath resolves only links in the path TO the root; internal links are still
  // copied AS links (dereference:false), so the re-verify below rejects any that
  // escape the pack root (the loader's realpath containment check) — a malicious
  // link inside a local source cannot be laundered through the install copy.
  const realSource = await realpath(pack.root)
  await cp(realSource, dest, { recursive: true, dereference: false })

  try {
    await loadProbePack(dest, verifyOptions)
  } catch (cause) {
    await rm(dest, { recursive: true, force: true }).catch(() => {})
    throw new ProbePackError(
      `Pack '${pack.manifest.name}' verified on resolution but its installed copy at ${dest} failed re-verification; install removed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }
  return dest
}
