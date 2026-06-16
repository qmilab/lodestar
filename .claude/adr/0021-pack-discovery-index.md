# ADR-0021: Pack discovery index — a static signed listing, discovery as a protocol

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Nandan, Claude
- **Related:** Epic #76, #87 (this ADR — ADR-0016 **step 6 of 6**, the last child),
  ADR-0016 (registry architecture, §1 fixes discovery-as-a-protocol), ADR-0017
  (signed manifests, #88), ADR-0018 (npm/git source resolution, #86), ADR-0019
  (publish/add CLI, #90), ADR-0020 (verification badges, #89), ADR-0010 (Ed25519
  signing primitive + operator-pinned keys),
  `docs/concepts/threat-model/registry-supply-chain.md` §5,
  `packages/core/src/schemas/pack-index.ts`,
  `packages/core/src/crypto/pack-index-signing.ts`,
  `packages/harness/src/pack/pack-index.ts`, `packages/cli/src/commands/pack.ts`

## Context

The first five registry children put the trust plumbing in place on both axes —
authorship (signed manifests, #88; source resolution, #86; publish/add, #90) and
attestation (badges, #89). What is still missing is the front door: **how a
consumer finds a pack in the first place.** Today they must already know an npm
package name or a git URL.

ADR-0016 §1 fixed the stance before any code: **the open registry is a *protocol*,
not a *service*.** Discovery in the open layer is a fetchable **static signed
index** — a plain JSON list an author or community hosts anywhere (a gist, a repo,
an object store) — not a hosted search backend. This keeps the open layer
decentralized, dependency-free, and non-gating, and is also the cleanest open-core
seam: hosted search / ranking / popularity signals / a curation pipeline are the
commercial surface (ADR-0016 §4). #87 is deliberately the **thinnest** child for
exactly that reason — it ships the format + local verify + a local query, and
stops.

The hard line the design must hold is the same one the whole registry exists for,
restated for discovery: *an index can advertise, but it can never make an unsigned
or forged pack verify.* A compromised or hostile index is in scope (threat-model
§5) and must be defanged structurally, not by trusting the index less.

## Decision

**1. Discovery is a static signed JSON document, verified locally against a third
trust root.** Schema in `@qmilab/lodestar-core` (`schemas/pack-index.ts`):
`PackIndex { index_version, description?, packs[], publisher_id?, generated_at?,
signature? }`, where each `PackIndexEntry` is `{ name, version, source, author_id?,
description?, coverage_areas[], invariants[], badges? }`. The index is signed with
the same Ed25519 lineage as manifests and badges (`crypto/pack-index-signing.ts`
mirrors `probe-pack-signing.ts` / `badge-signing.ts` exactly — `canonicalPackIndex*`
+ `signPackIndex` + `verifyPackIndexSignature`, all thin wrappers over the ADR-0017
`signing.ts` primitive). The consumer pins **index-publisher** keys in a *third*,
separate field — `PackTrustConfigSchema.index_publisher_keys` — distinct from author
keys (sign bytes) and attester keys (sign attestations): an index publisher signs a
*listing*. Pinning a publisher governs only whose advertisement you trust.

**2. An entry carries the immutable source descriptor, so discovery feeds resolution
directly.** `PackIndexEntry.source` is the same `PackSourceRefSchema` (#86) that
`pack add` consumes — an npm exact-version+SRI pin or a full git commit SHA (or a
`local` path for a private/local index). A discovered entry resolves with no extra
indirection: `pack search` prints the exact `pack add` argument. The `version`
mirrors the manifest version for display; the source ref is the binding.

**3. The index advertises; it never authorizes — trust stays in #88/#89.** This is
the load-bearing property. `loadPackIndex` verifies the index signature (fail
closed: an unsigned index is rejected unless an explicit `allow_unsigned`; a signed
index is always fully verified — un-pinned publisher, wrong key, or post-signing
tamper all throw). But verification of the *index* only authenticates the
*advertisement*. **Choosing a listed pack still routes through `addProbePack`**
(source resolution #86 + verify-on-load #88) against the consumer's pinned **author**
keys. So a verified index that advertises an unsigned or forged pack cannot make it
installable — `pack add` rejects it — and a hostile index can mis-list, re-point, or
omit, but the worst it achieves is a wasted fetch. The `badges?` field is likewise
**advisory advertisement only** (`kind` + `attester_id`); a consumer that wants to
trust a badge verifies the actual `badges/*.badge.json` locally against pinned
attester keys (ADR-0020), never the index's word.

**4. Search is a thin local query over fetched, verified indexes.** `searchPackIndexes`
filters listings by name/description text, coverage area, and invariant (case-
insensitive, AND), returning one hit per (index, listing) so a consumer sees *who*
advertises a pack. Multiple indexes **compose** — pass several, a hostile one is
just one more source, and a single index that fails to fetch/verify is skipped (not
fatal), so it cannot break discovery for the rest. This mirrors `lodestar harness
list`'s side-effect-free inspection.

**5. The CLI is the read surface plus a thin publisher-side sign.** `lodestar pack
search` / `pack list` (read) fetch one or more pinned indexes (`--index <source>`:
a path, `file:`, or https URL), verify each against pinned publisher keys
(`index_publisher_keys` + `--index-key`), and filter locally (`--coverage`,
`--invariant`, a text arg, `--json`). To make the round-trip real, `lodestar pack
index-sign` signs an **authored** index file in place (validate → set publisher_id
+ generated_at → sign → self-verify → write), and `pack keygen --index` mints the
publisher key — exactly the `publish` discipline for a pack. The publisher *writes*
the listing (they know each pack's source pin); the CLI only signs it. The
hosted/managed index-building pipeline stays commercial (ADR-0016 §4). Logic lives
in `@qmilab/lodestar-harness`, the format in `@qmilab/lodestar-core`, the shell in
`@qmilab/lodestar-cli` — no new package (ADR-0016 §6).

## Consequences

- The registry's six children are complete on all three axes: **authorship**
  (author key, fail-closed gate), **attestation** (attester key, advisory), and now
  **discovery** (publisher key, advisory advertisement). Each is pinned and adopted
  independently.
- Discovery adds **zero** new dependency and **zero** hosted infrastructure: an index
  is a file, fetched read-only over local fs or plain https, verified with the
  existing primitive. The open layer stays decentralized by construction.
- The "an index advertises but cannot launder trust" property is enforced
  structurally — the pack signature is re-verified at `add` regardless of how the
  pack was found — so the discovery surface adds no new trust to defend.
- **Strip / omission is undetectable** without an expectation list (same as badges,
  ADR-0020): a consumer who never saw a listing cannot tell it was omitted. Acceptable
  because discovery is advisory — an absent listing downgrades to "not found here",
  never to a false "trusted".
- A `local` source in a *shared* index is non-portable; the schema allows it (for
  private/local indexes and offline testing) but published indexes should advertise
  npm/git. Documented, not enforced.
- Generalising the index to policy/adapter packs later is a `source`/taxonomy reuse,
  guarded by `PACK_INDEX_SPEC_VERSION`, not a re-architecture.

## Alternatives considered

- **A hosted search/discovery service in the open repo.** Rejected — ADR-0016 §1/§4:
  the open layer is a protocol, the hosted backend (ranking, full-text, popularity)
  is the commercial surface. Standing up a service would also re-introduce a
  centralized dependency the registry exists to avoid.
- **Make a chosen pack trust the index's advertised author/badges (skip re-verify on
  add).** Rejected — that would make the index an *authority*, exactly the laundering
  hole. The index must only advertise; #88/#89 decide. Re-verifying on add is cheap
  and non-negotiable.
- **Pin index publishers under the existing `author_keys` (one trust root).**
  Rejected — an index publisher signs a *listing*, not bytes; conflating the roots
  would force trusting a curator to author packs (or vice versa). A third, separate
  `index_publisher_keys` mirrors the author/attester split (ADR-0020 §4).
- **Mutable source refs in entries (a `latest` dist-tag / branch).** Rejected — same
  immutability discipline as #86 (ADR-0016 §1): an entry pins an exact npm
  version+SRI or full git SHA, so following a discovered entry is reproducible and a
  re-pointed tag cannot swap bytes under a still-valid index signature.
- **Defer any publisher-side tooling (read-only this slice).** Rejected (mildly) —
  without a way to *produce* a signed index, the read side has nothing real to
  consume. `pack index-sign` + `keygen --index` are the thinnest write surface that
  closes the loop; the *managed* index pipeline remains commercial.
