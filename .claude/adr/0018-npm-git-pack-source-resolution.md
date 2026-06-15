# ADR-0018: npm / git pack source resolution — the non-executing, immutable-pin transport

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** Nandan, Claude
- **Related:** Epic #76, issue #86 (this work, **step 3 of 6**), ADR-0016
  (registry architecture; §1 immutable-pin + non-executing fetch, §2
  content-binding), ADR-0017 (signed manifests / verify-on-load this rides on),
  ADR-0006 (the `adapter-git` clone discipline this mirrors), #114 (runner
  execution containment — the orthogonal *safe-to-run* gap),
  `docs/concepts/threat-model/registry-supply-chain.md`,
  `packages/core/src/schemas/probe-pack.ts`,
  `packages/harness/src/pack/{source,npm-source,git-source,tar,run}.ts`

## Context

ADR-0016 set the registry architecture and ADR-0017 (#88) landed the trust root:
a signed manifest, verified on load against operator-pinned author keys, whose
signature binds a per-file `content_digest` over the probe bytes. But the v0
loader resolved `source_type: "local"` only — it could verify bytes that were
already on disk, not *fetch* a pack that ships as a published artifact.

#86 is the transport: teach the harness to resolve a pack from a published npm
package or a git repository to **immutable, content-verified bytes via a
non-executing fetch**. The hard requirement ADR-0016 §1 fixed is that source
resolution must be neither an unauthenticated step (it could deliver different
contents under a still-valid manifest signature) nor a code-execution step (an
npm `postinstall` or a git hook would run *before* verification, making the pack
capability-before-trust — exactly the anti-ClawHub line the registry exists to
hold).

## Decision

**1. Resolution is an upstream step; verification is unchanged.** A source
descriptor resolves to a confined local directory, and then the *existing*
`loadProbePack` (ADR-0017) runs over those bytes. This is why ADR-0016 §2's
"recompute the content digest over the *fetched* files" is automatic: a swapped
artifact under a re-pointed ref fails the content-digest check even when the old
signature still verifies, with no new verification code. The new
`loadProbePackFromSource(ref, opts)` composes `resolve → loadProbePack`; the
direct `loadProbePack(path)` stays the local-bytes entry. Once bytes are on disk,
every source type loads identically, so `loadProbePack` no longer gates on
`source_type` (the v0 "reject npm" stopgap is removed).

**2. A source descriptor (`PackSourceRef`) is consumer input, pinned to an
immutable artifact.** Addressing info lives *outside* the pack — you cannot read
a manifest's `source_type` to decide how to fetch it (chicken-and-egg). The
consumer supplies a discriminated descriptor (core schema):
- `npm` — exact `version` (a range / dist-tag is rejected) **and** an SRI
  `integrity`. The pin is enforced twice: the registry's advertised integrity
  must equal the pin (a mis-advertising registry is caught), and the
  *downloaded bytes'* SRI must equal the pin (the load-bearing check — a
  tampered or re-published tarball fails here).
- `git` — a **full 40-hex commit SHA**. A branch, tag, or short SHA is rejected:
  it can be force-moved, so it is not an immutable artifact.
- `local` — a path, resolved in place.

The manifest's own `source_type` becomes an advisory self-declaration; for a
non-local resolution the loader cross-checks it matches the descriptor (an
npm-fetched pack whose manifest claims `local` is refused). The resolved pin is
recorded on the loaded pack (`LoadedProbePack.source`) so the verified signature
binds to a specific immutable artifact and #90's `pack add` can write a lockfile
entry.

**3. The fetch is non-executing — no pack-authored code runs before
verification.**
- **npm** = registry-metadata read → tarball download → SRI check → archive
  extraction with **no `npm install`** and no lifecycle script. We shell out to
  the system `tar` (the same posture as `adapter-git` shelling to system `git`)
  rather than take a `node-tar` dependency: `tar` handles every archive variant
  (ustar / GNU / PAX long names) correctly, and we layer our own confinement —
  extract into a fresh `mkdtemp`, then reject the whole pack if any extracted
  entry is a symlink or resolves outside the root (the tar-slip boundary).
- **git** = clone `--no-checkout` → `checkout --detach <sha>` with
  `core.hooksPath=/dev/null` and a scoped env (`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`,
  throwaway `HOME`, no host-env passthrough — mirroring `adapter-git`'s
  `baseGitEnv`, ADR-0006, **without** taking a harness→adapter dependency) → verify
  `HEAD` is the pinned SHA → remove `.git`. No hook fires; no install runs.

**4. Mutable git refs are rejected outright (no escape hatch in v0).** ADR-0016 §1
allowed a mutable ref "unless accompanied by a pinned content digest." We defer
that hatch: the signed manifest's `content_digest` already binds bytes for a
signed pack, and a full SHA is the clean immutable address. Requiring a full SHA
gives the locking probe (`mutable-git-ref-rejected`) unambiguous teeth and keeps
the v0 surface tight; the hatch can be added later behind the spec version.

**5. Package home — reuse, per ADR-0016 §6.** The `git` source type and
`PackSourceRef` schema go in `@qmilab/lodestar-core`; resolution lives in
`@qmilab/lodestar-harness` (`pack/source.ts` dispatcher, `npm-source.ts`,
`git-source.ts`, `tar.ts`, `run.ts`) under the existing loader. No new package,
**no new runtime dependency** (system `tar` + system `git` + global `fetch`).

## Consequences

- A pack resolves from npm (exact version + integrity) or a pinned git commit
  SHA, with the existing confinement / no-escape checks preserved and the loaded
  ref recorded — then goes through #88's signature + content-digest verification
  over the fetched bytes before any probe could run.
- "A compromised index can mis-advertise but never launder a malicious pack" is
  now actually true end-to-end: an immutable pin + a content digest recomputed
  after resolution closes the re-pointed-ref / re-published-artifact hole.
- Resolution runs no pack-authored code (lifecycle scripts / hooks are not
  executed), so a pack stays a trust artifact, not capability. This is a
  **TS/process-level** governance boundary (like the native adapters), not OS
  containment — and it only guarantees *authentic, inert bytes reach the runner*.
  What those bytes do **when a probe is executed** is the orthogonal runner-side
  gap tracked in **#114** (scoped-env execution); until that lands, the guidance
  remains: do not *run* probes from a pack whose author you do not trust.
- Locking probes: `pack-resolves-from-npm` (npm happy-path + tampered-bytes
  rejection + a git-commit-SHA case, all offline via a local registry server and
  a local repo), `mutable-git-ref-rejected`, `resolution-runs-no-pack-code`.
  lodestar-core: 50 → 53 probes; 54 → 57 total.

## Alternatives considered

- **Read `source_type` from the manifest to drive resolution.** Rejected — you
  need the address (npm name / git URL + pin) *before* you can fetch the
  manifest. Addressing is consumer input (`PackSourceRef`); `source_type` is the
  pack's self-declaration, cross-checked after resolution.
- **Add a `node-tar` dependency for extraction.** Rejected — shelling to system
  `tar` (already required `git` precedent) keeps the harness dependency-free, and
  we enforce confinement ourselves rather than trusting a library's defaults.
- **Hand-roll a tar parser.** Rejected — PAX/GNU long-name handling is a real
  correctness risk; the system `tar` gets it right and we post-validate.
- **Depend on `@qmilab/lodestar-adapter-git` for `runGit`/`baseGitEnv`.** Rejected
  — that would be the first harness→adapter edge; the discipline is ~12 lines of
  scoped env, so we mirror it (citing ADR-0006) and keep the layering clean.
- **Allow a mutable git ref + an explicit content-digest pin (ADR-0016 §1's
  hatch).** Deferred — see Decision §4.
- **Resolve via `npm install` / package-manager semantics.** Rejected — lifecycle
  scripts and git hooks would execute before verification (capability-before-trust),
  the precise line this registry exists to hold.
