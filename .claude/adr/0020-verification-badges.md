# ADR-0020: Verification badges — locally-verifiable signed attestations on a signed pack

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Nandan, Claude
- **Related:** Epic #76, #89 (this ADR — ADR-0016 **step 5 of 6**), ADR-0016
  (registry architecture, §3 fixes the badge stance), ADR-0017 (signed manifests,
  #88), ADR-0019 (publish/add CLI, #90), ADR-0010 (Ed25519 signing primitive +
  operator-pinned keys), `docs/concepts/threat-model/registry-supply-chain.md` §5,
  `packages/core/src/schemas/pack-badge.ts`,
  `packages/core/src/crypto/badge-signing.ts`,
  `packages/harness/src/pack/badges.ts`, `packages/cli/src/commands/pack.ts`

## Context

#88 (ADR-0017) put the trust *root* in place — a signed manifest whose
`content_digest` binds the probe bytes, verified on load against operator-pinned
**author** keys. #90 (ADR-0019) put the author/consumer flow on top — `pack
publish` signs, `pack add` resolves → verifies → installs → records.

What that proves is **authorship**: *who* produced these exact bytes. It says
nothing about whether the pack is any *good* — whether its probes pass, whether a
scanner found anything. Positioning §5 fixes the registry's character as **trust
artifacts, not capability artifacts**, and ADR-0016 §3 names the mechanism for that
second axis: **badges** — small signed attestations issued *over* a pack by an
*attesting authority*, verified locally against a **separate** pinned trust root.
The threat model (#91, registry-supply-chain.md §5) already specifies the
properties; this ADR records how they land in code.

The hard line the design has to hold: *"a compromised index can strip or mis-attach
badges but cannot forge one that verifies."* And the open/commercial cut: the badge
**format + local verification** is open; the scanner that *runs* scans and the
authority that *issues trusted badges at scale* is the commercial surface.

## Decision

**1. A badge is a small signed document, attached to — not baked into — the
manifest.** Schema in `@qmilab/lodestar-core`
(`schemas/pack-badge.ts`): `{ badge_version, kind, subject, attester_id, result,
issued_at, signature }`, a discriminated union on `kind`
(`probe_results | security_scan`). It is **not** a manifest field: a badge is
issued *after* the pack is signed (you can only attest probe results once the pack
exists), and badges must accrue independently without re-signing the manifest or
disturbing the author signature. So badges live in a `badges/` directory at the
pack root, one `*.badge.json` file per attestation — outside the manifest's
`content_digest` (which covers declared probe files only), so adding a badge never
breaks the author signature, and each attester drops a file without an array merge.

**2. The signature is over the canonical badge document, reusing the shared
primitive.** `crypto/badge-signing.ts` mirrors `probe-pack-signing.ts` exactly:
`canonicalBadgeDocument` (the badge minus its detached `signature`),
`canonicalBadgeHash`, `signPackBadge`, and `verifyPackBadgeSignature` — all thin
wrappers over the ADR-0017 `signing.ts` primitive (`signPayloadHash` /
`verifyPayloadHashSignature`). No new crypto: the same audited Ed25519
sign/verify-against-a-pinned-key-set the approval and manifest paths use. The
`signature` field is **required** on a badge (a badge is by definition signed); a
file on disk that does not parse as a signed badge is surfaced as *malformed*, not
parsed loosely.

**3. The subject binds the badge to the exact pack bytes.** `subject = { pack,
version, manifest_hash }`, where `manifest_hash` is the canonical manifest hash
(which transitively binds the `content_digest`, which binds the probe bytes). This
is what defeats **mis-attach**: a badge legitimately signed over pack A, moved by a
hostile index onto pack B, fails the applicability check because B's recomputed
manifest hash ≠ the badge's `subject.manifest_hash`. `assertBadgeAppliesTo`
(core) is the pure check. **Forgery** is defeated separately by the signature: an
attacker can copy a real subject (the manifest hash is public) but cannot produce a
signature that verifies against a pinned attester key whose private half they do
not hold.

**4. A separate attester trust root.** The consumer pins **attester** keys
distinctly from author keys: `PackAttesterKeySchema { attester_id, public_key }`,
and `PackTrustConfigSchema` gains an additive `attester_keys: []`. An attester and
an author *may* be the same entity, but the pins are separate so an operator can
trust an author's bytes without automatically trusting that author's self-issued
"my pack passed" badge — and can pin a third-party scanner's attester key without
trusting it to author packs.

**5. Badges are advisory, never a gate.** `addProbePack` reads the resolved pack's
`badges/`, verifies each against the pinned attester keys, and **surfaces**
verified-vs-unverified — it never fails the add on a badge. A badge classifies into
`verified` (subject applies *and* signature verifies against a pinned attester),
`not_applicable` (mis-attached — subject does not match this pack),
`unverified` (signature absent-from-pins / un-pinned attester / bad bytes), or
`malformed` (unparseable file). Only `verified` is trusted; everything else is
shown as exactly what it is and **never counted as trusted**. The advisory/non-fatal
*policy* lives in the harness (`verifyPackBadges` wraps the throwing core checks in
try/catch to classify); core keeps the consistent throw-on-failure verifiers.

**6. `probe_results` is produced from a real harness run; `security_scan`'s
*runner* is out of scope.** `buildProbeResultsBadge(manifest, runResult, …)`
summarises a `PackRunResult` (ok/total/passed/failed + harness version + probe
names) and signs it — the natural output of `lodestar harness run` over a resolved
pack. `buildSecurityScanBadge(manifest, scanResult, …)` signs a *provided* scan
result (`status: clean | findings`, count, scanner label); the scanner that
actually *runs* the scan, and the authority that issues a trusted "Lodestar-verified"
badge at scale, are the commercial surface and are **not** in this repo. The CLI
exposes `lodestar pack attest` (probe_results via a real run, or security_scan from
a result file) and `lodestar pack keygen --attester`.

## Consequences

- The registry now carries two orthogonal, independently-pinned trust axes:
  **authorship** (author key, fail-closed gate) and **attestation** (attester key,
  advisory signal). An operator can adopt one without the other.
- The "compromised index can mis-advertise but never launder trust" property now
  extends to badges: mis-attach is caught by the `manifest_hash` subject binding,
  forgery by the signature, and neither requires trusting the index's word.
- Badges live *outside* the content digest by design, which is also a (documented)
  limitation: the v0 digest still covers only declared probe files, so the same
  whole-tree-hashing follow-up that applies to the manifest applies here. A badge
  file is authenticated by *its own* signature, not the pack's.
- **Strip is not detectable** without an expectation list — a consumer who never
  saw a badge cannot tell it was removed. This is acceptable because badges are
  advisory: their *absence* downgrades to "no signal", never to a false "trusted".
- More crypto surface in core (badge sign/verify), mitigated — as ADR-0016 §2
  required — by sharing the one audited primitive rather than copying it.
- Generalising badges to policy/adapter packs later (ADR-0016 §5) is a `kind`/subject
  addition guarded by `PACK_BADGE_SPEC_VERSION`, not a re-architecture.

## Alternatives considered

- **Bake badges into the signed manifest.** Rejected — that freezes the badge set at
  publish time and forces a manifest re-sign for every new attestation, and a
  `probe_results` badge cannot exist before the pack is signed. Badges must accrue
  independently (ADR-0016 §3).
- **Bind the subject by `{pack, version}` only.** Rejected — a version string is not
  the bytes; a re-published artifact at the same version (or a tag re-point) would
  carry a still-applicable badge over different bytes. Binding `manifest_hash` is the
  same content-binding discipline §2 of ADR-0016 demanded for the manifest itself.
- **Make a failed/unverified badge fail `pack add` (fail-closed, like author keys).**
  Rejected — badges are advisory trust *signal*, not a capability gate (ADR-0016 §3,
  out-of-scope note). Failing closed on an advisory signal would make an absent or
  third-party badge block an otherwise-trusted pack.
- **One sidecar `lodestar.badges.json` array instead of a `badges/` directory.**
  Rejected (mildly) — a shared array invites merge conflicts as attestations accrue
  from independent attesters; one file per badge lets them accrue without contention
  and is what a future index (#87) references individually.
- **Ship a security scanner in the open repo.** Rejected — the scanner that runs
  scans and the authority that issues trusted badges at scale are the commercial
  surface (ADR-0016 §4). The open layer ships the *format* and *local verification*
  only.
