# @qmilab/lodestar-adapter-git

Governed **git** tool adapter for the
[Lodestar](https://qmilab.com/lodestar) Action Kernel. Part of
Lodestar — the trust layer for AI agents.

Provides forge-agnostic git tools — read-only `git.status` plus the native
**transport** tools `git.commit`, `git.push`, and `git.clone`. These speak the
git protocol against *any* remote (GitHub, GitLab, Gitea, Forgejo, Bitbucket,
self-hosted, a bare repo over SSH); the remote is just a URL plus a credential.
The GitHub-only *API* surface (PRs, issues, releases) is a separate future
adapter — see [ADR-0006](../../../.claude/adr/0006-forge-agnostic-git-transport-in-adapter-git.md).

`git.push` is the first native Lodestar tool that moves data **out**
(`blast_radius: external`, L4) — held until a human approves.

## Install

```sh
npm install @qmilab/lodestar-adapter-git
# or
bun add @qmilab/lodestar-adapter-git
```

## Usage

```ts
import { registerGitStatusTool } from "@qmilab/lodestar-adapter-git"
import { ActionKernel } from "@qmilab/lodestar-action-kernel"

// projectRoot is required — git status runs inside it.
registerGitStatusTool(process.cwd())

const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink)
const action = kernel.propose({
  intent: "inspect repository state",
  tool: "git.status",
  inputs: { repo: "." },
  contract: { /* ... */ },
  proposed_by: "agent-1",
})
const arbitrated = await kernel.arbitrate(action)
if (arbitrated.phase === "approved") {
  const executed = await kernel.execute(arbitrated)
}
```

## Transport tools

```ts
import { registerGitTransportTools } from "@qmilab/lodestar-adapter-git"

registerGitTransportTools({
  workspaceRoot: "/work/repo",
  commit: true, // git.commit @ L3
  push: {
    // git.push @ L4 — the agent picks a NAME; the operator pins name → URL.
    remotes: { origin: "https://github.com/acme/widget.git" },
    // No silent default: choose a credential explicitly.
    credential: { kind: "https-token", token: () => secrets.fetch("gh-pat") },
  },
  clone: {
    // git.clone @ L3 — source allowlist + a pinned destination root.
    cloneRoot: "/work/clones",
    allowSource: (url) => url.startsWith("https://github.com/acme/"),
  },
})
```

## What it provides

- `makeGitStatusTool` / `registerGitStatusTool` — the read-only `git.status` tool.
- `makeGitCommitTool` / `makeGitPushTool` / `makeGitCloneTool` — individual
  transport tools.
- `defineGitTransportTools(config)` / `registerGitTransportTools(config)` — build
  (and register) the configured subset.
- `GitCommitOutputSchema` / `GitPushOutputSchema` / `GitCloneOutputSchema` — the
  Zod output schemas, registered against `git.commit@1` / `git.push@1` /
  `git.clone@1`.

## Invariants

- **Remote pinning.** `git.push` targets the operator-pinned URL *explicitly*, so a
  poisoned `.git/config` remote cannot redirect a push, and the push uses a fixed
  refspec from a validated branch name (no refspec injection). The agent picks a remote
  *name*, never a URL. The adapter also **rejects** a workspace local config that sets
  hostile keys (`url.*.insteadOf`/`pushInsteadOf`, `credential.helper`, `filter.*`, …),
  which could otherwise rewrite the pinned URL or run a helper/filter.
- **Credential scoping, no silent default.** The token flows via `GIT_ASKPASS` (never
  argv, `ps`-safe) and is redacted from captured output. The credential kind is always
  explicit.
- **Clone confinement.** A clone URL must pass the operator allowlist; the destination
  is confined under a pinned root. Cloned content is untrusted external input.
- **No host-env passthrough; host git config neutralised.** The subprocess sees only a
  scoped env (fresh empty `HOME`, `GIT_CONFIG_GLOBAL`/`SYSTEM=/dev/null`), commit hooks
  are disabled, and identity is pinned.

> **Boundary:** this is a TS-level governance boundary, **not an OS sandbox**.
> `push`/`clone` reach the real network by design; the governance is destination
> pinning + credential scoping + the L4 approval gate, not network containment.

## License

[Apache 2.0](./LICENSE).
