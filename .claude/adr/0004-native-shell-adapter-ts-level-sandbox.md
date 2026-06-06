# ADR-0004: Native shell adapter does TS-level governance, not OS sandboxing

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Nandan, Claude
- **Related:** `docs/architecture/v02-delta.md` §6, `docs/architecture/policy-kernel.md` (Sandbox), `examples/telenotes-governed-dev/dev-tools-mcp/`, `packages/adapters/shell/`, PR #56

## Context

P1 (sentinel→action wiring) is complete. Next in the locked post-v1 order is P2 —
native adapters, sequenced **shell → github → nostr**. This ADR covers the first
slice: the native `shell` adapter.

The reusable seed already exists: `examples/telenotes-governed-dev/dev-tools-mcp/`
ships three hardcoded tools (`shell_test`/`git_commit`/`git_push`) that spawn fixed
binaries with a scoped env. Its CLAUDE.md names the graduation path into
`packages/adapters/{shell,github}`: generalize the command allowlist and move it
under `packages/` (where example-specific code is forbidden).

Two forces shape the design:

1. **What enforcement can a native adapter honestly provide today?** The policy-kernel
   doc is explicit that OS-level sandbox *enforcement* (namespaces, cgroups, a real
   `controlled-shell` runtime, `--network none`) "graduates with the shell adapter" —
   but that is a large, platform-specific lift. The `controlled-shell` profile is
   currently a policy *decision*, not an OS-enforced *boundary*.
2. **How should commands be exposed?** The dev-tools server argued for *distinct*
   tools over one generic `shell.run`, because the MCP proxy assigns trust per tool
   name. A native adapter is reached through `guard.wrap()`, where trust comes from
   the action contract — but the per-command-trust property is still worth keeping.

## Decision

Ship `@qmilab/lodestar-adapter-shell` as a **TS-level audit / governance boundary,
explicitly not an OS sandbox**, exposed through a **config-driven tool factory**.

- **TS-level safety, enforced in-process** (the things it *does* claim): fixed binary
  + argv-only exec via `Bun.spawn` (no shell string → no command injection); an
  allowlist via each spec's `argsMatcher` (validates the requested args, returns the
  final args, or throws *before* spawning); no host-env passthrough (the subprocess
  sees only the declared `env`; default is a fresh-HOME scoped env, git config
  disabled); a wall-clock timeout that kills the process and reports `timed_out`;
  bounded output capture; and a pinned `workspaceRoot` cwd.
- **What it does NOT claim:** it does not OS-sandbox the code it runs. `shell.test`
  executes the workspace's own test code; network access and out-of-workspace reads
  are not prevented at the OS level. The package documents this boundary in its
  CLAUDE.md, README, and tool framing — the same honesty the dev-tools server and
  v02-delta §6 already practice. OS-level enforcement remains deferred.
- **Config-driven factory:** `defineShellTool(spec, options)` turns each declared
  command spec into its own governed `Tool` with its own `name` and `trust` floor.
  Because the Action Kernel already enforces `required_trust_level` per tool, distinct
  trust per command (e.g. `shell.test` @L3) falls out for free — preserving the
  dev-tools property without hardcoding three tools.
- **Scope split:** the shell adapter ships the run-commands-safely mechanism plus a
  `bunTest` (`shell.test`) preset. **git commit/push move to the git-transport adapter**
  (P2 slice 2), where the remote/credential story lives — mirroring the dev-tools
  graduation path. *(Superseded by ADR-0006: that adapter is `adapter-git`, not a
  "github" adapter, because git transport is forge-agnostic.)*

The invariants are locked by `shell-adapter-enforces-sandbox-invariants` in
`packs/lodestar-core/`, which drives the real adapter through the real kernel.

## Consequences

- A real, configurable native shell surface exists under `packages/`, unblocking the
  github and nostr adapters and any `guard.wrap()` host that needs governed commands.
- The adapter is honest about its limits: it is not advertised as an OS sandbox, so a
  reader cannot mistake "governed" for "contained." When the OS-level runtime lands,
  it slots under the same `controlled-shell` profile without changing the tool API.
- The MCP proxy still cannot reach native adapters (it only governs downstream MCP
  servers) — so the Telenotes demo keeps using the dev-tools MCP server; this adapter
  serves the in-process `guard.wrap()` path. Accepted, not a regression.
- `lodestar-core` grows to 37 probes (41 across both packs).

## Alternatives considered

- **OS-level sandbox now (namespaces/cgroups/network isolation).** Rejected for this
  slice: large, platform-specific, and not required to ship a useful, honest native
  adapter. Deferred behind the same `controlled-shell` profile.
- **Single generic `shell.run` with a binary allowlist.** Rejected: collapses every
  permitted command into one trust floor — the exact thing the dev-tools server split
  three tools to avoid.
- **Keep commit/push in the shell adapter.** Rejected: remotes, credentials, and push
  belong to the `github` adapter (P2 slice 2); folding them in here would re-merge
  concerns the graduation path deliberately separates.
