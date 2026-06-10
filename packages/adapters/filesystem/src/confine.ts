import { lstat, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

/**
 * Shared path-confinement core for every tool in this package.
 *
 * The lexical escape check and the real-root containment assertion are
 * security-critical and used by fs.read, doc.read, and fs.write — they live
 * here exactly once so a fix cannot land in one tool and miss another.
 *
 * This is a TS-level governance boundary, not an OS sandbox (ADR-0004 /
 * ADR-0012): none of these checks claim syscall-level race (TOCTOU)
 * containment — a path component swapped for a symlink *between* a check here
 * and the caller's subsequent filesystem operation is out of scope.
 */

/**
 * A confinement root fixed at construction. `realRoot()` resolves the root's
 * physical path once and memoizes it — the root is immutable for the tool's
 * lifetime, so repeated writes don't pay a realpath syscall each. A failed
 * resolution is NOT cached, so a root created after construction is picked up
 * on the next call.
 */
export interface ConfinedRoot {
  readonly root: string
  realRoot(): Promise<string>
}

export function confineToRoot(rootInput: string): ConfinedRoot {
  const root = resolve(rootInput)
  let cached: Promise<string> | undefined
  return {
    root,
    realRoot() {
      cached ??= realpath(root).catch((err) => {
        cached = undefined
        throw err
      })
      return cached
    },
  }
}

/** Containment assertion both checks share: equal to the root, or under it. */
function isWithin(realRoot: string, realPath: string): boolean {
  return realPath === realRoot || realPath.startsWith(realRoot + sep)
}

export interface ConfineContext {
  /** Tool name for error messages, e.g. "fs.write". */
  tool: string
  /** Root description for error messages, e.g. "writable root". */
  rootLabel: string
}

/**
 * Lexical confinement: resolve `inputPath` against the root and refuse
 * anything that escapes it (`..` traversal, absolute paths outside the root).
 * Purely string-level — it cannot see through symlinks, so callers pair it
 * with one of the realpath checks below. `allowRoot` permits resolving to the
 * root itself (the read tools accept it and fail later on the is-a-file
 * check; writes refuse it outright).
 */
export function confineLexically(
  cr: ConfinedRoot,
  inputPath: string,
  ctx: ConfineContext & { allowRoot?: boolean },
): string {
  const requested = resolve(cr.root, inputPath)
  const rel = relative(cr.root, requested)
  if (
    (rel === "" && ctx.allowRoot !== true) ||
    rel.startsWith("..") ||
    resolve(cr.root, rel) !== requested
  ) {
    throw new Error(`${ctx.tool}: path '${inputPath}' escapes ${ctx.rootLabel}`)
  }
  return requested
}

/**
 * Read-side confinement: lexical check, then realpath the (existing) target
 * and confirm it is still inside the real root — a symlink under the root
 * must not redirect the read outside it. Both sides are realpath'd so
 * platform symlinks (e.g. macOS /tmp → /private/tmp) resolve consistently.
 * Returns the real target path to operate on.
 */
export async function confineReadTarget(
  cr: ConfinedRoot,
  inputPath: string,
  ctx: ConfineContext,
): Promise<string> {
  const requested = confineLexically(cr, inputPath, { ...ctx, allowRoot: true })
  const [realRoot, realTarget] = await Promise.all([cr.realRoot(), realpath(requested)])
  if (!isWithin(realRoot, realTarget)) {
    throw new Error(`${ctx.tool}: path '${inputPath}' resolves outside ${ctx.rootLabel}`)
  }
  return realTarget
}

export interface WriteTargetConfinement {
  /** The physical destination to write (verified-ancestor real path + remainder). */
  realTarget: string
  /** True when one or more parent directories of the destination do not exist. */
  parentMissing: boolean
}

/**
 * Write-side confinement: lexical check, then walk up to the deepest EXISTING
 * ancestor of the destination (the destination — and, under createDirs, some
 * parents — may not exist yet), realpath it, and confirm it is still inside
 * the real root. A symlinked directory anywhere in the existing chain
 * resolves here and is caught (the walk's lstat stops AT a symlink, so a
 * symlink component becomes the ancestor itself and its realpath is checked).
 *
 * The remainder below the verified ancestor did not exist when the walk
 * observed it, so re-rooting it on the ancestor's real path gives the
 * physical destination — as of that observation. A component racing into
 * existence as a symlink between this check and the caller's mkdir/write can
 * still redirect the operation: that syscall-level TOCTOU window is the
 * boundary this package does not claim (see module note above). Closing it
 * needs O_NOFOLLOW/openat-style syscalls, deferred with the OS-sandbox work.
 */
export async function confineWriteTarget(
  cr: ConfinedRoot,
  inputPath: string,
  ctx: ConfineContext,
): Promise<WriteTargetConfinement> {
  const requested = confineLexically(cr, inputPath, ctx)
  let ancestor = dirname(requested)
  for (;;) {
    try {
      await lstat(ancestor)
      break
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err
      if (ancestor === cr.root) break // root must exist; realpath below throws if not
      ancestor = dirname(ancestor)
    }
  }
  const [realRoot, realAncestor] = await Promise.all([cr.realRoot(), realpath(ancestor)])
  if (!isWithin(realRoot, realAncestor)) {
    throw new Error(`${ctx.tool}: path '${inputPath}' resolves outside ${ctx.rootLabel}`)
  }
  // The remainder is purely lexical (no `..`, already confined above).
  const realTarget = join(realAncestor, relative(ancestor, requested))
  return { realTarget, parentMissing: ancestor !== dirname(requested) }
}
