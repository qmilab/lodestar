# ADR-0006: Governed git transport lives in `adapter-git` (forge-agnostic), not a github adapter

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Nandan, Claude
- **Related:** ADR-0004 (supersedes its naming), ADR-0005, `packages/adapters/git/`,
  `packages/action-kernel/src/registry.ts` (`CapabilityHandle`), `docs/roadmap.md`

## Context

P2's native-adapter sequence (ADR-0005) lists the second slice as "github". ADR-0004
deferred `git commit`/`push` "to the github adapter, where the remote/credential story
lives." But the capability that earns this slot — per ADR-0005, **`push` is the first
native egress** (`blast_radius: external`, the L4 human-approval gate, scoped
credentials, the dormant exfil sentinel) — is **forge-agnostic**: `git commit` /
`push` / `clone` speak the git protocol against *any* remote (GitHub, GitLab, Gitea,
Forgejo, Bitbucket, Codeberg, self-hosted, a bare repo over SSH). The remote is just a
URL plus a credential.

Only the *forge API* (pull/merge requests, issues, releases) is GitHub-specific — and
it differs per forge (GitHub REST vs GitLab MRs vs Gitea/Forgejo vs Bitbucket). Naming
the transport adapter "github" would bake a false forge-specificity into a forge-neutral
capability, and would split git ops awkwardly (`git.status` in `adapter-git`,
`git.commit`/`push` in `adapter-github`).

## Decision

**Add the governed transport tools `git.commit` / `git.push` / `git.clone` to the
existing `@qmilab/lodestar-adapter-git`** (joining the read-only `git.status`). This
**supersedes ADR-0004's naming** (which is updated to `Superseded by ADR-0006` for the
commit/push placement only; its TS-level-boundary decision still stands and is carried
forward here).

**Reserve a future `adapter-github`** for genuinely GitHub-API tools, behind a
`ForgeProvider` seam so GitLab/Gitea/etc. implementations can slot in later.

The transport tools carry the shell adapter's hardening (ADR-0004) plus two
egress-specific governance mechanisms:

- **Remote pinning.** The operator pins `remotes: { name → URL }`. The agent picks a
  *name* (default `origin`); the adapter pushes to the pinned URL *explicitly*,
  bypassing the workspace's (possibly poisoned) `.git/config` — the agent cannot
  redirect a push.
- **Credential scoping, no silent default.** The operator chooses a `credential`
  explicitly: `none`, `https-token` (flows via a generated `GIT_ASKPASS` reading the
  secret from the scoped env, so the token never reaches argv and is redacted from
  captured output; the token may be a `() => Promise<string>` resolver fetched at push
  time), or `ssh-key` (via `GIT_SSH_COMMAND`).
- **Clone source allowlist + destination pin.** A clone URL must pass an operator
  allowlist; the destination is confined under a pinned `cloneRoot`. Cloned content is
  untrusted external input.

Trust floors: `git.commit` L3, `git.push` **L4** (held until approved), `git.clone` L3
(inbound, untrusted content — not egress).

**Forward direction (noted, not built here).** The Action Kernel already models opaque
secret handles (`ToolContext.capabilities`, "tools never see raw secret values").
Once kernel capability *resolution* lands, the `https-token` resolver seam is the bridge
to route the token as a capability rather than a config value.

The invariants are locked by `git-adapter-enforces-egress-invariants` in
`packs/lodestar-core/`, which drives the real tools through the real kernel.

## Consequences

- Honest naming: a forge-neutral capability lives under a forge-neutral package; the
  egress governance sits with `git`, where it conceptually belongs.
- `adapter-git` graduates from read-only to egress-capable; this is the first native
  tool that lights up the L4 gate and (eventually) the exfil sentinel.
- `lodestar-core` grows to **38** probes (**42** across both packs).
- A future `adapter-github` is now scoped to *API only* and must introduce the
  `ForgeProvider` seam on day one (do not hardcode GitHub).
- Same honesty boundary as ADR-0004: this is a **TS-level governance boundary, not an
  OS sandbox**. `push`/`clone` reach the real network by design; the governance is
  destination pinning + credential scoping + L4 approval + firewall-marked inbound
  content — not network containment.

## Alternatives considered

- **New `adapter-github` holds commit/push (literal ADR-0004).** Rejected — names a
  forge-neutral capability after one forge and splits git ops across two packages.
- **New neutral `adapter-git-remote` separate from read-only `adapter-git`.** Rejected
  — a third git-ish package to maintain for no real separation benefit; `git.status`
  and the transport tools share the same scoped-runner machinery.
- **Push via the remote *name* (let git resolve `.git/config`).** Rejected — a poisoned
  repo config could redirect the push; pinning to the explicit URL closes that.
- **Credential in the URL / a default credential.** Rejected — silent defaults for
  security settings are forbidden; credentials in argv leak via `ps`.
