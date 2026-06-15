# ADR-0019: `lodestar pack publish` / `lodestar pack add` — the author + consumer flow

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** Nandan, Claude
- **Related:** Epic #76, #90 (this ADR), ADR-0016 (registry architecture — this is
  its **step 4 of 6**), ADR-0017 (signed manifests, #88), ADR-0018 (npm/git source
  resolution, #86), ADR-0010 (Ed25519 signing primitive + operator-pinned keys),
  `packages/core/src/schemas/probe-pack.ts`, `packages/harness/src/pack/`,
  `packages/cli/src/commands/pack.ts`

## Context

#88 (ADR-0017) put the **trust root** in place — a signed `lodestar.probe-pack.json`
manifest whose `content_digest` binds the probe bytes, verified on load against
operator-pinned author keys. #86 (ADR-0018) put the **transport** in place —
`loadProbePackFromSource(ref)` resolves a pinned `PackSourceRef` (npm: exact
version + SRI; git: full commit SHA) to confined bytes via a **non-executing
fetch**, then runs #88's verify-on-load over those bytes.

What was missing is the *human* flow that produces and consumes those artifacts:
nothing yet **signs** a first-party pack (they all ship unsigned under
`allow_unsigned`, deferred here per the harness loader comment), and a consumer who
wants to pull an external pack has to hand-author a `PackSourceRef` and call the
loader API. #90 is that flow — `lodestar pack publish` (author) and `lodestar pack
add` (consumer) — and it is the seam that ties #88 and #86 together end-to-end.

## Decision

**Reuse before a new package (ADR-0016 §6).** No `@qmilab/lodestar-registry`. The
*logic* lives in `@qmilab/lodestar-harness` (`src/pack/publish.ts`, `add.ts`,
`trust-config.ts`, `lockfile.ts`) beside the loader it builds on; the *formats* go
in `@qmilab/lodestar-core` (`schemas/pack-registry.ts` — the consumer trust config
and the lockfile); the *CLI shell* is `packages/cli/src/commands/pack.ts` under the
existing `lodestar` binary. This is the same core-owns-format / harness-owns-I/O
split the loader already follows.

**1. `lodestar pack publish` signs *after* freezing the files.** It resolves the
declared probe files (the loader's exact escape + symlink-realpath checks, now
factored into a shared `resolve.ts` so publish and verify compute the digest the
*same* way — no drift), computes the `content_digest` over the frozen bytes, sets
`author_id` + `content_digest`, strips any stale signature, then signs the
canonical manifest with the author's Ed25519 key. The order is the ADR-0016 §2
consequence: *tooling cannot sign a manifest then mutate files*. The signed
manifest is written back (or to `--out`). Publish then **self-verifies** —
re-loading the written pack with the author pinned and `allow_unsigned` off — so a
pack that would not verify on a consumer's machine fails at publish time, not
theirs.

**2. `lodestar pack add <source>` is resolve → verify → surface → install →
record.** It parses a pinned source argument (`npm:<pkg>@<ver> --integrity <sri>`,
`git:<url>#<40hex>`, or a `local:`/path), loads the operator's pinned author keys
(a trust config + repeatable `--author-key` flags), and calls
`loadProbePackFromSource` — so the **non-executing fetch + #88 verify-on-load runs
before any pack-authored code could** (the whole point: `add` never triggers an
`npm install` lifecycle script or a git hook). Only after verification does it
**surface** the manifest's declared coverage / invariants / probe count / pin /
author, **install** (copy the verified bytes into a stable dir, then re-load + 
re-verify the *installed* copy — TOCTOU closure, the same belt-and-suspenders the
loader's post-realpath re-check uses), and **record** the pin in a lockfile. Fail
closed: an unverified or content-mismatched pack is refused unless `--allow-unsigned`
is explicit.

**3. Author keys are minted by `lodestar pack keygen`, never touch argv.** A
dedicated `keygen --author <id>` mirrors `approve keygen` (same
`generateEd25519KeyPair`, same temp+rename 0600 private-key discipline) but prints
a pin labelled for the consumer trust config, not the proxy's `approvals`. The
author's private key is read for `publish` from `--key <path>` or
`LODESTAR_AUTHOR_KEY` — a path or an env var, never an argv value, asserted by the
roundtrip probe's no-leak check.

**4. The consumer trust config mirrors the proxy's pinned-approver config
(ADR-0010).** `{ author_keys: [{ actor_id, public_key }], allow_unsigned? }`, read
from `--trust-config <path>` (default `.lodestar/pack-trust.json`). Same shape and
same fail-closed default as `approvals.authorized_keys`, so an operator who has
pinned approver keys already knows this format. Badge attestations (#89) attach
here later; the surface step leaves the seam but does not implement badge display
(badges do not exist yet).

## Consequences

- **Easier:** the registry is now usable by a human end-to-end — an author signs
  and publishes, a consumer pins keys and pulls, with one `lodestar pack` verb.
  The first-party packs can finally be *signed* (a follow-up: publish them and pin
  the key in CI), retiring the `allow_unsigned` first-party shortcut over time.
- **Harder / accepted:** `loadProbePack`'s probe-resolution + content-digest code
  is now shared (`resolve.ts`) instead of inline — a small refactor of a
  security-critical file, guarded by the existing 110 harness tests + 53-probe
  pack which must stay green. We accept the churn for digest-parity (publish and
  verify provably agree).
- **Deferred:** publishing *to* npm/git is still the author's own
  `npm publish` / `git push` (we sign + prepare the artifact, we don't push it);
  the hosted index/search and the managed scanner stay commercial (ADR-0016 §4);
  badge surfacing waits on #89; signing the bundled first-party packs is a separate
  follow-up so this PR stays the *mechanism*, not the migration.

## Alternatives considered

- **A new `@qmilab/lodestar-registry` package** — rejected; ADR-0016 §6 says reuse
  until the surface demands it, same discipline as `fs.write` staying in
  `adapter-filesystem` (ADR-0012).
- **Publish re-using `loadProbePack` to resolve files** — rejected; a re-publish of
  an already-signed manifest would fail the loader's signature check (no pinned
  keys at publish time). Factoring the resolution into `resolve.ts` lets publish
  reuse the *file-safety* checks without the verify step.
- **Trust config / lockfile schemas in harness** — rejected; ADR-0016 §6 puts
  formats in core. They are pure Zod (no I/O), so core's no-runtime invariant holds.
- **Reusing `approve keygen` for author keys** — rejected in favour of a dedicated
  `pack keygen`: the printed pin and guidance differ (author trust config vs.
  proxy `approvals`), and a mislabeled pin is a silent footgun.
