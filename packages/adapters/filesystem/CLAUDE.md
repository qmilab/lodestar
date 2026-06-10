# @qmilab/lodestar-adapter-filesystem — CLAUDE.md

The native filesystem adapter: governed reads and writes confined to an
operator-fixed root. One package for the whole filesystem domain (ADR-0012) —
mirroring how messaging holds `slack.post` + `email.send` — with the kernel
enforcing a distinct trust floor per tool.

## What lives here

- `src/read.ts` — `fs.read` (L0, `sandbox: read`): bounded UTF-8 read with
  lexical + symlink path confinement under a project root.
- `src/doc-read.ts` — `doc.read` (L0): the same confined read, emitting a
  `documentation.source@1` observation tagged with a `kind` so the cognitive
  core's `DocumentationExtractor` can extract documentation claims. Used by
  `examples/documentation-agent/`.
- `src/write.ts` — `fs.write` (L3, `sandbox: write-local`, compensable): the
  graduated documentation-agent `doc.write` (issue #79, ADR-0012). Confined
  writes under a `writableRoot`, with `maxBytes` rejection and opt-in
  `createDirs`.
- `src/read-bounded.ts` / `*.test.ts` — the bounded reader and mechanism-level
  Bun unit tests.

The adversarial write invariants are locked by the harness probe
`packs/lodestar-core/probes/filesystem-adapter-enforces-write-invariants.ts`,
which drives the real tool through the real Action Kernel.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not an OS sandbox** (ADR-0004 applies here
too). Enforced in-process:

1. **Path confinement under the scoped root.** Both tools resolve paths against
   a root fixed at construction. Escapes are refused lexically (`..`, absolute
   paths outside the root) AND physically: the deepest existing ancestor is
   `realpath`'d and must stay inside the real root, so a symlinked directory
   cannot redirect the operation out. `fs.write` additionally refuses a
   destination that is itself a symlink (it would otherwise follow it out of
   the root) and refuses to clobber non-regular files.
2. **No host-environment passthrough.** No subprocess, no shell, no
   `process.env` reads in any execute path; `~` and `$VAR` are literal path
   characters, never expanded.
3. **Bounded I/O.** Reads are captured up to `max_bytes` and flagged truncated.
   Writes over `maxBytes` are **rejected before touching disk — never
   truncated**: a truncated write is a corrupted artifact, not a bounded
   capture.
4. **No silent tree growth.** A missing parent directory fails `fs.write`
   unless the operator opted in via `createDirs`; created directories are
   confined exactly like the file.
5. **Honest overwrite accounting.** `fs.write` reports `created` and
   `previous_bytes`, so the audit trail records what a compensable write
   replaced.

**What it does NOT claim:** OS-level enforcement of the `read` / `write-local`
profiles (read-only bind mounts, namespaces) and syscall-level TOCTOU race
containment. Keep that honest in docs and tool framing.

## When you touch this package

- `fs.write` is L3 (local reversible) and `fs.read` / `doc.read` are L0. Do not
  lower a floor to make a demo pass; the kernel enforces it per tool.
- Every security-relevant setting (sandbox profile, trust, permissions,
  effects, byte caps, `createDirs`) is explicit — no silent defaults.
- New write behavior must extend the probe in `packs/lodestar-core/` under
  adversarial conditions, not just the unit tests.
- The example-local `doc.write` in `examples/documentation-agent/` stays
  example-local; new hosts use `fs.write`.
