import { type PackSourceRef, PackSourceRefSchema } from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { type ResolveGitOptions, resolveGitSource } from "./git-source.js"
import { type ResolveNpmOptions, resolveNpmSource } from "./npm-source.js"

/**
 * The record of what a {@link resolvePackSource} call loaded: the validated,
 * pinned descriptor (the immutable address) and the local directory the bytes
 * were resolved to. {@link loadProbePackFromSource} attaches this to its result
 * so the verified signature binds to a specific immutable artifact and #90's
 * `pack add` can write a lockfile entry.
 */
export interface ResolvedPackSource {
  /** The validated, pinned descriptor that produced this resolution. */
  ref: PackSourceRef
  /** Absolute path to the resolved pack directory (or the local manifest path). */
  root: string
}

export interface ResolvePackSourceOptions extends ResolveNpmOptions, ResolveGitOptions {}

/**
 * Resolve a pinned pack source descriptor to confined local bytes (#86 /
 * ADR-0018). `local` resolves in place; `npm` and `git` fetch to an immutable,
 * content-verified directory via a non-executing fetch. This does NOT verify the
 * manifest signature — that is {@link loadProbePack}'s job, run over the resolved
 * root; resolution only gets *some* bytes to disk, verification decides whether
 * to trust them.
 */
export async function resolvePackSource(
  ref: PackSourceRef,
  options: ResolvePackSourceOptions = {},
): Promise<ResolvedPackSource> {
  const parsed = PackSourceRefSchema.safeParse(ref)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new ProbePackError(`Invalid pack source descriptor:\n${issues}`)
  }
  const source = parsed.data

  switch (source.type) {
    case "local":
      return { ref: source, root: source.path }
    case "npm":
      return { ref: source, root: await resolveNpmSource(source, options) }
    case "git":
      return { ref: source, root: await resolveGitSource(source, options) }
  }
}
