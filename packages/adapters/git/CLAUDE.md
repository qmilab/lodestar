# @qmilab/lodestar-adapter-git — CLAUDE.md

Governed git tools for the Action Kernel. Two layers:

- **`git.status`** (`src/status.ts`) — the original read-only tool (L0).
- **Transport** (`src/transport.ts`, `src/run.ts`, `src/credentials.ts`) —
  `git.commit` / `git.push` / `git.clone`, the P2 slice-2 native adapter
  (ADR-0006). These graduate the demo-shaped `dev-tools-mcp` `git_commit`/`git_push`
  into a configurable, credential-bearing adapter under `packages/`.

**Forge-agnostic by design.** These speak the git protocol against *any* remote
(GitHub, GitLab, Gitea, Forgejo, Bitbucket, self-hosted, a bare repo over SSH) — the
remote is a URL plus a credential. The GitHub-only *API* surface (PRs, issues,
releases) is a separate future `adapter-github` behind a provider seam. See
`.claude/adr/0006-forge-agnostic-git-transport-in-adapter-git.md`.

## What lives here

- `src/run.ts` — the scoped `runGit` runner (scoped env via `baseGitEnv`, argv-only
  exec, wall-clock timeout with process-group reaping, bounded capture) plus
  `applyRedactions` / `redactUrl`. A git-specialised sibling of the shell adapter's
  `runScoped` — deliberately not imported from shell, to avoid coupling two adapters.
- `src/credentials.ts` — the `Credential` union (`none` / `https-token` / `ssh-key`)
  and `prepareCredential`, which resolves it to scoped-env additions (an askpass helper
  for tokens; `GIT_SSH_COMMAND` for keys) plus per-call redaction strings.
- `src/transport.ts` — the `git.commit@1` / `git.push@1` / `git.clone@1` output
  schemas, the three `Tool`s, the `make*Tool` builders, and the
  `defineGitTransportTools` / `registerGitTransportTools` config factory.
- `src/git-transport.test.ts` — mechanism-level Bun tests against a local bare repo.

The headline egress invariants are locked by the harness probe
`packs/lodestar-core/probes/git-adapter-enforces-egress-invariants.ts`, which drives the
real tools through the real kernel.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not an OS sandbox** (same framing as ADR-0004's shell
adapter). It enforces, in-process:

1. **Remote pinning + fixed refspec.** `git.push` targets the operator-pinned URL
   *explicitly*, bypassing the workspace's `.git/config`. The agent names a remote; the
   operator pins name → URL. The caller-supplied branch is validated as a branch name and
   the push builds a fixed `refs/heads/X:refs/heads/X`, so it cannot inject refspec
   syntax (e.g. `main:refs/heads/other` to touch — or `:refs/heads/main` to delete —
   another ref on the remote). The agent cannot push to an un-pinned remote.
2. **Credential scoping, no silent default.** The operator picks the `credential` kind
   explicitly. For `https-token` the secret flows through a generated `GIT_ASKPASS`
   helper that reads it from the *scoped env* — so the token never appears in argv
   (`ps`-safe) and is redacted from captured output (the askpass token AND any credential
   embedded in a URL). `token` may be a `() => Promise<string>` resolver so production
   fetches it at push time.
3. **Clone source allowlist + destination pin.** A clone URL must pass `allowSource`;
   the destination is confined under `cloneRoot` (no `..`, no absolute, no overwrite of
   a non-empty dir). Confinement is **symlink-aware** — a symlink planted under the root
   (by an untrusted prior setup) cannot redirect the clone outside it. Cloned content is
   untrusted external input.
4. **No host-env passthrough; host AND local git config neutralised.** The subprocess
   sees only a scoped env (fresh empty `HOME`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`,
   `GIT_TERMINAL_PROMPT=0`, `PATH` inherited). `git.commit` disables hooks
   (`core.hooksPath=/dev/null --no-verify`) and pins identity with `-c` flags. The
   workspace's own `.git/config` is still read by git, so before each transport op the
   adapter **rejects** a local config that sets hostile keys (`url.*.insteadOf` /
   `pushInsteadOf`, `credential.helper`, `filter.*`, `core.fsmonitor`/`sshCommand`,
   `http.*.proxy`, `include.path`, …) — otherwise a poisoned repo config could rewrite
   the pinned URL or run a helper/filter, bypassing remote pinning + credential scoping
   (`assertSafeLocalConfig`).
5. **Argv-only exec + bounded capture + wall-clock timeout.** `git` is spawned with an
   argv array (never a shell string); output is capped; a deadline reaps the whole
   process group.

**What it does NOT claim:** it does not OS-sandbox git or the network. `push`/`clone`
reach the real network *by design* — that is the governed action. The governance is
destination pinning + credential scoping + the **L4 human-approval gate** + treating
inbound clone content as untrusted — not network containment. Keep this honest in docs
and tool descriptions.

## Trust contracts

| Tool | Trust | blast_radius | reversibility | sandbox |
|------|-------|--------------|---------------|---------|
| `git.commit` | L3 | `project` | `compensable` | `write-local` |
| `git.push` | **L4** | `external` | `irreversible` | `controlled-shell` |
| `git.clone` | L3 | `project` | `reversible` | `controlled-shell` |

`git.push` @ L4 is the headline: it parks at `pending_approval` until a human resolves
it. Do **not** lower the floor to make a demo pass.

## When you extend this

- Keep new tools forge-agnostic. Anything GitHub-API-specific belongs in the future
  `adapter-github` behind a `ForgeProvider` seam — do not hardcode a forge here.
- Never let an agent supply a remote URL or a credential. Pin remotes; allowlist clone
  sources; keep credentials operator-supplied and out of argv.
- Declare real `effects` / `reversibility` / `required_trust_level`. No silent defaults
  for security-relevant settings.
- `ssh-key` is supported via `GIT_SSH_COMMAND`; `StrictHostKeyChecking` stays on
  (honest default). A capability-handle path (the kernel's `ToolContext.capabilities`)
  is the forward direction for secrets once kernel resolution lands — see ADR-0006.
