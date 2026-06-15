import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitPackSource } from "@qmilab/lodestar-core"
import { ProbePackError } from "./errors.js"
import { spawnCaptured } from "./run.js"

/**
 * A scoped git environment — mirrors `@qmilab/lodestar-adapter-git`'s `baseGitEnv`
 * discipline (ADR-0006): no host-config or host-env passthrough, terminal prompts
 * off, and a throwaway `HOME` so no user `~/.gitconfig` (or its `core.hooksPath`)
 * leaks in. The harness does NOT depend on the adapter — it replicates the
 * discipline so source resolution stays self-contained.
 */
function scopedGitEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  return env
}

/**
 * `core.hooksPath=/dev/null` on every invocation: no repo, global, or system hook
 * (`post-checkout` and friends) can fire. Combined with the scoped env and the
 * `.git` removal below, git resolution runs NO pack-authored code (ADR-0016 §1).
 */
const HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"]

export interface ResolveGitOptions {
  /** Directory to clone beneath; a fresh subdir is created. Defaults to an OS temp dir. */
  cacheRoot?: string
}

/**
 * Resolve a pinned git pack source to a confined local directory (ADR-0016 §1,
 * #86 / ADR-0018).
 *
 * Clones the repository without a working tree (so no checkout hook runs on
 * clone), checks out exactly the pinned full commit SHA with hooks disabled,
 * verifies `HEAD` is that SHA, then removes `.git` so the resolved root is pack
 * content only and no later git operation can touch it. The pinned SHA is an
 * immutable artifact (a branch/tag is rejected by the schema). Returns the
 * checkout root; the caller runs {@link loadProbePack} over it.
 */
export async function resolveGitSource(
  source: GitPackSource,
  options: ResolveGitOptions = {},
): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(source.commit)) {
    // Defence in depth — the schema already enforces a full 40-hex SHA.
    throw new ProbePackError(
      `git pack source must pin a full 40-hex commit SHA; got '${source.commit}'.`,
    )
  }

  const cacheRoot = options.cacheRoot ?? (await mkdtemp(join(tmpdir(), "lodestar-pack-git-")))
  await mkdir(cacheRoot, { recursive: true })
  const home = await mkdtemp(join(cacheRoot, "home-"))
  const dest = await mkdtemp(join(cacheRoot, "repo-"))
  const env = scopedGitEnv(home)
  const short = source.commit.slice(0, 12)

  // Clone without a working tree — no checkout, so no checkout hook runs here. A
  // full clone (not --depth): fetching an arbitrary SHA shallowly is not
  // universally supported by remotes.
  const clone = await spawnCaptured(
    "git",
    [...HOOKS_OFF, "clone", "--no-checkout", "--quiet", source.url, dest],
    { env },
  )
  if (clone.code !== 0) {
    throw new ProbePackError(
      `git clone failed for '${source.url}': ${clone.stderr.trim().slice(0, 500)}`,
    )
  }

  // Check out exactly the pinned SHA, detached, with hooks off.
  const checkout = await spawnCaptured(
    "git",
    [...HOOKS_OFF, "-C", dest, "checkout", "--quiet", "--detach", source.commit],
    { env },
  )
  if (checkout.code !== 0) {
    throw new ProbePackError(
      `git checkout of commit ${short}… failed for '${source.url}': ${checkout.stderr.trim().slice(0, 500)}. Is the commit present in the repository?`,
    )
  }

  // Verify HEAD really is the pinned SHA (a remote could resolve a ref oddly).
  const head = await spawnCaptured("git", [...HOOKS_OFF, "-C", dest, "rev-parse", "HEAD"], { env })
  if (head.code !== 0 || head.stdout.trim() !== source.commit) {
    throw new ProbePackError(
      `Resolved git HEAD (${head.stdout.trim().slice(0, 12)}…) does not match the pinned commit ${short}….`,
    )
  }

  // Drop .git: the resolved root is pack content only.
  await rm(join(dest, ".git"), { recursive: true, force: true })
  return dest
}
