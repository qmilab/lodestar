import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"
import { type Credential, type PreparedCredential, prepareCredential } from "./credentials.js"
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  baseGitEnv,
  redactUrl,
  runGit,
  urlSecretRedactions,
} from "./run.js"

/**
 * Native git *transport* tools — `git.commit`, `git.push`, `git.clone`.
 *
 * These are forge-agnostic: they speak the git protocol against ANY remote
 * (GitHub, GitLab, Gitea, Forgejo, Bitbucket, self-hosted, or a bare repo over
 * SSH). The remote is just a URL plus a credential — nothing here is
 * GitHub-specific. The GitHub-only *API* surface (PRs, issues, releases) is a
 * separate, future `adapter-github` behind a provider seam (see ADR-0006).
 *
 * Governance, not OS sandboxing (carried over from the shell adapter, ADR-0004):
 * `git.push` is the first native tool that moves data *out* — `blast_radius:
 * external`, L4, held until a human approves. The teeth are:
 *
 *   - **Remote pinning.** The agent names a remote; the operator pins name → URL.
 *     The push targets the pinned URL *explicitly*, bypassing the workspace's
 *     (possibly poisoned) `.git/config` — the agent cannot redirect a push.
 *   - **Credential scoping.** The token is operator-supplied, flows via
 *     `GIT_ASKPASS` (never argv), and is redacted from all captured output.
 *   - **Clone source allowlist + destination pin.** A clone URL must pass the
 *     operator's allowlist; the destination is confined under a pinned root.
 *     Cloned content is untrusted external input.
 */

// -----------------------------------------------------------------------------
// Output schemas (registered like git.status@1; guarded so a double import is a
// harmless no-op rather than a "schema already registered" crash).
// -----------------------------------------------------------------------------

export const GitCommitOutputSchema = z
  .object({
    committed: z.boolean().describe("false if there was nothing to commit or the commit failed"),
    sha: z.string().describe("the new commit SHA, or '' if nothing was committed"),
    branch: z.string(),
    files_changed: z.number().int().nonnegative(),
    summary: z.string().describe("combined git output (redacted)"),
    exit_code: z.number().int(),
    timed_out: z.boolean(),
  })
  .describe("git.commit tool output")

export const GitPushOutputSchema = z
  .object({
    pushed: z.boolean(),
    remote: z.string().describe("the remote NAME the agent requested"),
    remote_url: z.string().describe("the operator-pinned URL the push targeted (redacted)"),
    branch: z.string(),
    updated_refs: z.array(z.string()),
    summary: z.string().describe("combined git output (redacted)"),
    exit_code: z.number().int(),
    timed_out: z.boolean(),
  })
  .describe("git.push tool output")

export const GitCloneOutputSchema = z
  .object({
    cloned: z.boolean(),
    source_url: z.string().describe("the cloned URL (redacted)"),
    destination: z.string().describe("destination path relative to the clone root"),
    head_sha: z.string(),
    branch: z.string(),
    summary: z.string().describe("combined git output (redacted)"),
    exit_code: z.number().int(),
    timed_out: z.boolean(),
  })
  .describe("git.clone tool output")

if (!registry.has("git.commit@1")) registry.register("git.commit@1", GitCommitOutputSchema)
if (!registry.has("git.push@1")) registry.register("git.push@1", GitPushOutputSchema)
if (!registry.has("git.clone@1")) registry.register("git.clone@1", GitCloneOutputSchema)

const GitCommitInputSchema = z.object({
  message: z.string().min(1).describe("the commit message"),
})
const GitPushInputSchema = z.object({
  remote: z
    .string()
    .min(1)
    .optional()
    .describe("remote NAME (must be operator-pinned); default origin"),
  branch: z.string().min(1).optional().describe("branch to push; default the current branch"),
})
const GitCloneInputSchema = z.object({
  url: z.string().min(1).describe("source repository URL (must pass the operator allowlist)"),
  destination: z.string().min(1).describe("destination subdirectory under the clone root"),
})

export type GitCommitOutput = z.infer<typeof GitCommitOutputSchema>
export type GitPushOutput = z.infer<typeof GitPushOutputSchema>
export type GitCloneOutput = z.infer<typeof GitCloneOutputSchema>

// -----------------------------------------------------------------------------
// Shared run context
// -----------------------------------------------------------------------------

interface SharedRun {
  env: Record<string, string>
  /** Scratch dir the adapter controls (askpass helper lives here). */
  scratch: string
  maxOutputBytes: number
  timeoutMs: number
}

interface SharedOptions {
  env?: Record<string, string>
  maxOutputBytes?: number
  timeoutMs?: number
}

function resolveShared(opts: SharedOptions): SharedRun {
  const scratch = mkdtempSync(join(tmpdir(), "lodestar-git-home-"))
  return {
    env: opts.env ?? baseGitEnv(scratch),
    scratch,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  }
}

function runOpts(
  shared: SharedRun,
  cwd: string,
  env: Record<string, string>,
  redactions: string[],
) {
  return {
    cwd,
    env,
    timeoutMs: shared.timeoutMs,
    maxOutputBytes: shared.maxOutputBytes,
    redactions,
  }
}

/** Confine a clone destination under the pinned root; throw on any escape. */
function resolveCloneTarget(cloneRoot: string, destination: string): string {
  if (isAbsolute(destination)) {
    throw new Error(`git.clone: destination '${destination}' must be relative to the clone root`)
  }
  const root = resolve(cloneRoot)
  const target = resolve(root, destination)
  const rel = relative(root, target)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`git.clone: destination '${destination}' escapes the clone root`)
  }
  // Symlink-aware confinement. The string check above only constrains the textual
  // path; a symlink placed under the root (by an untrusted prior setup) could still
  // redirect the clone outside it. Ensure the root exists, then require the REAL
  // path of the target's nearest existing ancestor to stay within the real root,
  // and reject a symlink at the target leaf itself — git follows it (even a dangling
  // one) and would write outside the root.
  mkdirSync(root, { recursive: true })
  const realRoot = realpathSync(root)
  let ancestor = target
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const realAncestor = realpathSync(ancestor)
  const realRel = relative(realRoot, realAncestor)
  if (
    realRel !== "" &&
    (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel))
  ) {
    throw new Error(
      `git.clone: destination '${destination}' resolves outside the clone root via a symlink`,
    )
  }
  let leaf: ReturnType<typeof lstatSync> | undefined
  try {
    leaf = lstatSync(target)
  } catch {
    leaf = undefined
  }
  if (leaf?.isSymbolicLink()) {
    throw new Error(`git.clone: destination '${destination}' is a symlink`)
  }
  return target
}

/**
 * Validate a git branch name. Rejects refspec syntax (a colon) and other unsafe
 * forms so a caller-supplied branch cannot become an arbitrary refspec like
 * `main:refs/heads/other` (touch another ref) or `:refs/heads/main` (delete one)
 * on the pinned remote. The push then builds a fixed `refs/heads/X:refs/heads/X`.
 */
const BRANCH_METACHARS = "~^:?*[\\" // git's special chars; the colon blocks refspec injection
function assertSafeBranchName(branch: string): void {
  // Reject control chars + space (code <= 0x20), DEL (0x7f), and git metacharacters,
  // so a caller-supplied branch cannot become an arbitrary refspec.
  const hasUnsafeChar = [...branch].some((ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code <= 0x20 || code === 0x7f || BRANCH_METACHARS.includes(ch)
  })
  if (
    branch.length === 0 ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    hasUnsafeChar
  ) {
    throw new Error(
      `git.push: '${branch}' is not a valid branch name (refspec syntax and metacharacters are rejected)`,
    )
  }
}

// Local git config keys that can redirect a transport, run code, or rewrite URLs.
// The scoped env neutralises GLOBAL/SYSTEM config, but the workspace's own
// `.git/config` is still honoured by git — and a poisoned one could:
//   - `url.<x>.insteadOf` / `pushInsteadOf` → rewrite the operator-pinned URL,
//   - `credential.helper` → run a helper / divert credentials,
//   - `filter.*` (clean/smudge/process), `core.fsmonitor`, `core.sshCommand` → exec,
//   - `gpg.program` / `gpg.<fmt>.program` → exec a "signer" (signing enablement is
//     also force-disabled with `-c` on commit/push, but reject the exec pointer too),
//   - `http.*.proxy` → divert/MITM egress,
//   - `include.path` / `includeIf` → pull in arbitrary config.
// We reject (fail closed) rather than override, since `insteadOf`/`filter` can't be
// cleanly cleared with `-c`. Names are matched lowercased (git lowercases section/key).
const HOSTILE_LOCAL_CONFIG: RegExp[] = [
  /^url\..*\.insteadof$/,
  /^url\..*\.pushinsteadof$/,
  /^credential\..*helper$/,
  /^core\.sshcommand$/,
  /^core\.fsmonitor$/,
  /^core\.hookspath$/,
  /^core\.pager$/,
  /^filter\..*\.(process|clean|smudge)$/,
  /^gpg\.program$/,
  /^gpg\..*\.program$/,
  /^http\..*proxy$/,
  /^https\..*proxy$/,
  /^include\.path$/,
  /^includeif\..*\.path$/,
  /^protocol\..*allow$/,
]

/**
 * Reject the transport if the repo discovered at `dir` has a local git config
 * setting any hostile key. A non-repo (or no local config) is fine — git exits
 * non-zero and we treat it as nothing to reject.
 */
async function assertSafeLocalConfig(dir: string, shared: SharedRun): Promise<void> {
  const res = await runGit(
    ["config", "--local", "--list", "--name-only", "-z"],
    runOpts(shared, dir, shared.env, []),
  )
  if (res.exit_code !== 0) return
  const names = res.stdout
    .split("\0")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
  const bad = [...new Set(names.filter((n) => HOSTILE_LOCAL_CONFIG.some((re) => re.test(n))))]
  if (bad.length > 0) {
    throw new Error(
      `git: refusing to run — the workspace's local git config sets keys that can redirect the remote, run helpers/filters, or rewrite URLs: ${bad.join(", ")}`,
    )
  }
}

// -----------------------------------------------------------------------------
// Tool builders
// -----------------------------------------------------------------------------

const DEFAULT_IDENTITY = { name: "Lodestar Agent", email: "lodestar-agent@users.noreply.invalid" }

export interface GitCommitToolOptions extends SharedOptions {
  /** The repo working tree. Pinned: the agent cannot redirect it. */
  workspaceRoot: string
  /** Commit identity. Pinned so the commit does not depend on host config. */
  identity?: { name: string; email: string }
  /** Trust floor. Default L3 (local, reversible-with-notification). */
  trust?: TrustLevel
}

export function makeGitCommitTool(
  opts: GitCommitToolOptions,
): Tool<z.infer<typeof GitCommitInputSchema>, GitCommitOutput> {
  const root = resolve(opts.workspaceRoot)
  const identity = opts.identity ?? DEFAULT_IDENTITY
  const shared = resolveShared(opts)
  const effects: Effect[] = [
    { kind: "world_state_change", description: "create a git commit in the workspace" },
  ]
  return {
    name: "git.commit",
    inputs: GitCommitInputSchema,
    output_schema_key: "git.commit@1",
    effects,
    reversibility: "compensable",
    // Spawns `git` (a subprocess), so it honestly needs shell.exec + the
    // controlled-shell sandbox — a policy composing enforcement from these must
    // grant process execution, not just fs.write.
    permissions: ["shell.exec", "fs.write"] as Permission[],
    required_trust_level: opts.trust ?? 3,
    sandbox: "controlled-shell",
    preconditions: () => [],
    execute: async (inputs) => {
      // `git add` runs clean filters; reject a poisoned local config first.
      await assertSafeLocalConfig(root, shared)
      const env = shared.env
      const add = await runGit(["add", "-A"], runOpts(shared, root, env, []))
      if (add.exit_code !== 0) {
        return {
          committed: false,
          sha: "",
          branch: "",
          files_changed: 0,
          summary: `${add.stdout}${add.stderr}`,
          exit_code: add.exit_code,
          timed_out: add.timed_out,
        }
      }
      // Hooks disabled, signing force-disabled, and identity pinned with -c flags so
      // neither a planted repo hook, a poisoned signing config (commit.gpgsign +
      // gpg.program would spawn a signer), nor (now-neutralised) host config can
      // influence the commit.
      const commit = await runGit(
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          `user.email=${identity.email}`,
          "-c",
          `user.name=${identity.name}`,
          "commit",
          "--no-verify",
          "-m",
          inputs.message,
        ],
        runOpts(shared, root, env, []),
      )
      const committed = commit.exit_code === 0
      let sha = ""
      let branch = ""
      let filesChanged = 0
      if (committed) {
        sha = (await runGit(["rev-parse", "HEAD"], runOpts(shared, root, env, []))).stdout.trim()
        branch = (
          await runGit(["rev-parse", "--abbrev-ref", "HEAD"], runOpts(shared, root, env, []))
        ).stdout.trim()
        const names = await runGit(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
          runOpts(shared, root, env, []),
        )
        filesChanged = names.stdout.split("\n").filter((l) => l.trim().length > 0).length
      }
      return {
        committed,
        sha,
        branch,
        files_changed: filesChanged,
        summary: `${commit.stdout}${commit.stderr}`,
        exit_code: commit.exit_code,
        timed_out: commit.timed_out,
      }
    },
  }
}

export interface GitPushToolOptions extends SharedOptions {
  /** The repo working tree. Pinned. */
  workspaceRoot: string
  /** Operator-pinned remote name → URL. The agent picks a NAME, never a URL. */
  remotes: Record<string, string>
  /** Credential strategy. Explicit, no default (security-relevant). */
  credential: Credential
  /** Trust floor. Default L4 — egress, held until approved. */
  trust?: TrustLevel
}

export function makeGitPushTool(
  opts: GitPushToolOptions,
): Tool<z.infer<typeof GitPushInputSchema>, GitPushOutput> {
  const root = resolve(opts.workspaceRoot)
  const shared = resolveShared(opts)
  const prepared: PreparedCredential = prepareCredential(opts.credential, shared.scratch)
  const remotes = { ...opts.remotes }
  const effects: Effect[] = [
    { kind: "external_call", description: "push commits to a remote repository" },
    { kind: "publication", description: "publish local commits to a shared remote" },
  ]
  return {
    name: "git.push",
    inputs: GitPushInputSchema,
    output_schema_key: "git.push@1",
    effects,
    reversibility: "irreversible",
    permissions: ["shell.exec", "network.egress", "fs.read"] as Permission[],
    required_trust_level: opts.trust ?? 4,
    sandbox: "controlled-shell",
    preconditions: () => [],
    execute: async (inputs) => {
      // A poisoned local `.git/config` could rewrite the pinned URL
      // (`url.*.pushInsteadOf`) or run a credential helper; reject before pushing.
      await assertSafeLocalConfig(root, shared)
      const remoteName = inputs.remote ?? "origin"
      const url = remotes[remoteName]
      if (url === undefined) {
        throw new Error(
          `git.push: remote '${remoteName}' is not in the operator-pinned remotes (${Object.keys(remotes).join(", ") || "none"})`,
        )
      }
      let branch = inputs.branch
      if (branch === undefined) {
        const head = await runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          runOpts(shared, root, shared.env, []),
        )
        branch = head.stdout.trim()
        if (branch.length === 0 || branch === "HEAD") {
          throw new Error(
            "git.push: cannot determine current branch (detached HEAD); specify a branch",
          )
        }
      }
      assertSafeBranchName(branch)
      const cred = await prepared.resolve()
      const env = { ...shared.env, ...prepared.baseEnv, ...cred.env }
      // Redact the askpass token AND any credential embedded in the pinned URL —
      // git can echo a failing remote URL verbatim into stderr.
      const redactions = [...cred.redactions, ...urlSecretRedactions(url)]
      // Push to the pinned URL explicitly (not the remote name) so a poisoned
      // `.git/config` cannot redirect the push. The refspec is fixed from the
      // validated branch name so the agent cannot inject arbitrary refspec syntax
      // (touch or delete other refs on the remote). Hooks disabled.
      const refspec = `refs/heads/${branch}:refs/heads/${branch}`
      const push = await runGit(
        // Force-disable signed push (push.gpgSign + gpg.program would spawn a signer).
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "push.gpgSign=false",
          "push",
          "--porcelain",
          url,
          refspec,
        ],
        runOpts(shared, root, env, redactions),
      )
      const combined = `${push.stdout}${push.stderr}`
      const updated_refs = push.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("refs/"))
      return {
        pushed: push.exit_code === 0,
        remote: remoteName,
        remote_url: redactUrl(url),
        branch,
        updated_refs,
        summary: combined,
        exit_code: push.exit_code,
        timed_out: push.timed_out,
      }
    },
  }
}

export interface GitCloneToolOptions extends SharedOptions {
  /** Pinned parent directory; every clone lands in a subdir under this. */
  cloneRoot: string
  /** Operator allowlist: returns true iff this source URL may be cloned. */
  allowSource: (url: string) => boolean
  /** Optional credential for private sources. Omit for public-only clone roots. */
  credential?: Credential
  /** Trust floor. Default L3 — local write of untrusted external content. */
  trust?: TrustLevel
}

export function makeGitCloneTool(
  opts: GitCloneToolOptions,
): Tool<z.infer<typeof GitCloneInputSchema>, GitCloneOutput> {
  const cloneRoot = resolve(opts.cloneRoot)
  const shared = resolveShared(opts)
  const prepared: PreparedCredential | undefined =
    opts.credential !== undefined ? prepareCredential(opts.credential, shared.scratch) : undefined
  const effects: Effect[] = [
    { kind: "external_call", description: "fetch a repository from a remote" },
    { kind: "world_state_change", description: "create a working tree under the clone root" },
  ]
  return {
    name: "git.clone",
    inputs: GitCloneInputSchema,
    output_schema_key: "git.clone@1",
    effects,
    reversibility: "reversible",
    permissions: ["shell.exec", "network.egress", "fs.write"] as Permission[],
    required_trust_level: opts.trust ?? 3,
    sandbox: "controlled-shell",
    preconditions: () => [],
    execute: async (inputs) => {
      if (!opts.allowSource(inputs.url)) {
        throw new Error(
          `git.clone: source '${redactUrl(inputs.url)}' is not permitted by the operator source allowlist`,
        )
      }
      // If the clone root sits inside a repo, that repo's local config could carry
      // `url.*.insteadOf` to rewrite the source URL; reject a poisoned one. (A
      // non-repo clone root has no local config and is fine.)
      await assertSafeLocalConfig(cloneRoot, shared)
      const target = resolveCloneTarget(cloneRoot, inputs.destination)
      if (existsSync(target) && readdirSync(target).length > 0) {
        throw new Error(
          `git.clone: destination '${inputs.destination}' already exists and is not empty`,
        )
      }
      const cred = prepared !== undefined ? await prepared.resolve() : { env: {}, redactions: [] }
      const env = { ...shared.env, ...(prepared?.baseEnv ?? {}), ...cred.env }
      // Redact the askpass token AND any credential embedded in the source URL.
      const redactions = [...cred.redactions, ...urlSecretRedactions(inputs.url)]
      const clone = await runGit(
        ["clone", inputs.url, target],
        runOpts(shared, cloneRoot, env, redactions),
      )
      const cloned = clone.exit_code === 0
      let head_sha = ""
      let branch = ""
      if (cloned) {
        head_sha = (
          await runGit(["-C", target, "rev-parse", "HEAD"], runOpts(shared, cloneRoot, env, []))
        ).stdout.trim()
        branch = (
          await runGit(
            ["-C", target, "rev-parse", "--abbrev-ref", "HEAD"],
            runOpts(shared, cloneRoot, env, []),
          )
        ).stdout.trim()
      }
      return {
        cloned,
        source_url: redactUrl(inputs.url),
        destination: relative(cloneRoot, target),
        head_sha,
        branch,
        summary: `${clone.stdout}${clone.stderr}`,
        exit_code: clone.exit_code,
        timed_out: clone.timed_out,
      }
    },
  }
}

// -----------------------------------------------------------------------------
// Config-driven factory (mirrors registerShellTools)
// -----------------------------------------------------------------------------

export interface GitTransportConfig extends SharedOptions {
  /** Repo working tree for commit/push. Required if either is enabled. */
  workspaceRoot?: string
  /** Enable git.commit. Pass options or `true` for defaults. */
  commit?: { identity?: { name: string; email: string }; trust?: TrustLevel } | true
  /** Enable git.push. Requires pinned remotes + an explicit credential. */
  push?: { remotes: Record<string, string>; credential: Credential; trust?: TrustLevel }
  /** Enable git.clone. Requires a clone root + a source allowlist. */
  clone?: {
    cloneRoot: string
    allowSource: (url: string) => boolean
    credential?: Credential
    trust?: TrustLevel
  }
}

/** Build the configured subset of transport tools. */
export function defineGitTransportTools(config: GitTransportConfig): Tool[] {
  const shared: SharedOptions = {
    env: config.env,
    maxOutputBytes: config.maxOutputBytes,
    timeoutMs: config.timeoutMs,
  }
  const tools: Tool[] = []
  if (config.commit) {
    if (config.workspaceRoot === undefined) {
      throw new Error("git transport: `workspaceRoot` is required to enable git.commit")
    }
    const c = config.commit === true ? {} : config.commit
    tools.push(makeGitCommitTool({ workspaceRoot: config.workspaceRoot, ...c, ...shared }) as Tool)
  }
  if (config.push) {
    if (config.workspaceRoot === undefined) {
      throw new Error("git transport: `workspaceRoot` is required to enable git.push")
    }
    tools.push(
      makeGitPushTool({ workspaceRoot: config.workspaceRoot, ...config.push, ...shared }) as Tool,
    )
  }
  if (config.clone) {
    tools.push(makeGitCloneTool({ ...config.clone, ...shared }) as Tool)
  }
  return tools
}

/** Build and register the configured subset of transport tools. Returns them. */
export function registerGitTransportTools(config: GitTransportConfig): Tool[] {
  const tools = defineGitTransportTools(config)
  for (const tool of tools) registerTool(tool)
  return tools
}
