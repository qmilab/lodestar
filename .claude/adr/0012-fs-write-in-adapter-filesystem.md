# ADR-0012: fs.write graduates into adapter-filesystem, not its own package

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Nandan, Claude
- **Related:** issue #79 (child of epic #74), `examples/documentation-agent/doc-write.ts`,
  `packages/adapters/filesystem/`, ADR-0004 (TS-level boundary), ADR-0006–0009
  (the shipped adapter pattern)

## Context

Epic #74 (native adapters) says each child ships as "its own
`@qmilab/lodestar-adapter-*` package + a `*-enforces-*-invariants` probe + an
ADR." Issue #79 asks for governed filesystem writes: path confinement under a
scoped root, no host-env passthrough, graduating the documentation-agent's
example-local `doc.write` (L1, bound to the example's `workspace/`) into a
reusable adapter at **L3**.

Unlike shell/git/nostr/http/messaging, a filesystem adapter package already
exists: `@qmilab/lodestar-adapter-filesystem` ships `fs.read` and `doc.read`,
is published in v0.2.0, sits in both `publish.yml` PUBLISH_ORDER lists, and is
in the root devDependencies that probes resolve against. The repo convention
across the shipped adapters is **one package per domain/transport, several
tools per package** — messaging holds `slack.post` + `email.send`, http holds
`http.request` + `http.fetch`, git holds status + commit/push/clone.

## Decision

**Extend `@qmilab/lodestar-adapter-filesystem` with `fs.write`** rather than
creating a new package. The epic's "own package" phrasing describes the
pattern for *new domains*; the filesystem domain already has its package, and
`fs.write` shares its namespace, its project-root binding, and its
path-confinement mechanics with `fs.read`. A separate `adapter-fs-write`
package would split one domain across two packages and add publish-order,
devDeps, and README surface for no isolation benefit.

The tool (`src/write.ts`, `makeFsWriteTool(options)` / `registerFsWriteTool`):

- **Trust L3** (local reversible — modify project state), `sandbox:
  "write-local"`, `permissions: ["fs.write"]`, `reversibility: "compensable"`,
  a declared `world_state_change` effect scoped to the root — every
  security-relevant setting explicit in the contract, no silent defaults.
- **Path confinement under an operator-fixed `writableRoot`:** lexical check
  (`..`, absolute paths outside the root) plus a physical check — the deepest
  *existing* ancestor of the destination is `realpath`'d and must remain inside
  the real root, so a symlinked directory cannot redirect the write out; a
  destination that is itself a symlink is refused, never followed; an existing
  destination must be a regular file.
- **No host-environment passthrough:** no subprocess, no shell, no
  `process.env` reads; `~`/`$VAR` are literal path characters.
- **Bounded write:** contents over `maxBytes` (default 1 MiB) are *rejected*
  before touching disk — never truncated, because a truncated write is a
  corrupted artifact, not a bounded capture.
- **No silent tree growth:** a missing parent directory fails the write unless
  the operator opts in via `createDirs`; created directories are confined by
  the same ancestor check.
- **Honest overwrite accounting:** the output records `created` and
  `previous_bytes`, so the audit trail shows what a compensable write replaced.

Like every shipped adapter, this is a **TS-level governance boundary, not an OS
sandbox** (ADR-0004): syscall-level races and OS enforcement of `write-local`
are out of scope. The invariants are locked by
`filesystem-adapter-enforces-write-invariants` in `packs/lodestar-core/`, which
drives the real tool through the real kernel — two-phase hold (a held write
touches nothing), TOCTOU revalidation, the L3 floor, every escape vector above,
literal `~`/`$HOME`, and the bounded-write rejection.

The example-local `doc.write` in `examples/documentation-agent/` stays as-is
(it is example code exercising the doc pipeline); new hosts should use
`fs.write`.

## Consequences

- Governed writes become reusable by any `guard.wrap()` host without example
  code; the documentation-agent pattern is no longer the only way to mutate
  files under governance.
- Zero publish bookkeeping: no PUBLISH_ORDER, root-devDeps, or workflow
  changes — the package already ships. The package gains its (previously
  missing) `CLAUDE.md`.
- `lodestar-core` grows to 44 probes (48 across both packs).
- `fs.read` (L0) and `fs.write` (L3) live in one package with different trust
  floors — fine, because the kernel enforces `required_trust_level` per tool,
  exactly the per-command-trust property ADR-0004 preserved for shell.

## Alternatives considered

- **New `@qmilab/lodestar-adapter-fs-write` package.** Rejected: splits the
  filesystem domain in two, contradicts the one-package-per-domain convention
  the other adapters follow, and adds publish/bookkeeping surface with no
  isolation gain (both packages would depend on exactly core + action-kernel).
- **Generalize `doc.write` in place (export it from the example).** Rejected:
  `packages/` must not depend on example code, and example-local tools are not
  published.
- **Atomic temp-file + rename writes.** Deferred: `writeFile` matches the
  shipped `doc.write` mechanism; atomicity is a durability nicety, not one of
  the issue's confinement/governance invariants, and can land later without
  API change.
