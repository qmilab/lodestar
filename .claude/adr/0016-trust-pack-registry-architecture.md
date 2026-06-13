# ADR-0016: Trust-pack registry — architecture, the open/commercial line, and v1.5 sequencing

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Nandan, Claude
- **Related:** Epic #76 (children #86–#91), ADR-0010 (Ed25519 signing primitive),
  ADR-0015 (transport carries a signed decision, never mints one),
  `docs/strategy/positioning.md` §5, `docs/roadmap.md`,
  `packages/core/src/schemas/probe-pack.ts`, `packages/harness/src/pack/loader.ts`

## Context

Epic #76 is the trust-pack marketplace registry (policy / probe / sentinel /
adapter packs). Positioning §5 fixed its character: **trust artifacts, not
capability artifacts** — the deliberate anti-ClawHub stance, where a marketplace
object is a *manifest carrying declarations and attestations*, never raw
executable capability with unknown effects. It is also the cleanest open-core
seam: the **open** registry drives adoption; the **managed/verified** registry is
the commercial surface (positioning §4–5).

The epic carried one hard gate — "do **not** build before the signing primitive
is solid." That gate is now lifted. ADR-0010 put real `node:crypto` Ed25519 in
`@qmilab/lodestar-policy-kernel` (`signApprovalResolution` /
`verifyApprovalSignature` / `generateApproverKeyPair`, pinned-key sets,
canonical-hash documents), and ADR-0015 established the load-bearing property the
registry inherits: a channel can only **transport** a signed decision, it cannot
**mint** one — verification is local, against operator-pinned keys.

Six children (#86–#91) exist as one-line skeletons. This ADR sets (a) the
architectural stance, (b) where the open/commercial line falls, (c) the scope cut,
and (d) the build order — before any registry code lands.

## Decision

**1. The open registry is a *protocol*, not a *service*.** A pack is addressed by
where it already lives — an npm package name or a git URL — not by a
Lodestar-hosted catalog. "Discovery" in the open layer is a fetchable **static
index** (a plain signed JSON list an author or community can host anywhere), not a
hosted search backend. This keeps the open layer decentralized, dependency-free,
and non-gating, and avoids standing up a service prematurely.

**2. The trust root is the signed manifest.** Ed25519 over the canonical pack
manifest, reusing the ADR-0010 lineage: the signer is the **pack author key**; the
consumer (operator) pins the set of trusted author keys and verifies **on load**.
The reject set mirrors the approval path — absent (unless `allow_unsigned`),
`payload_hash` mismatch, signer ≠ declared author, **signer not in the pinned
set**, non-ed25519, bad signature bytes. The canonical-hash + ed25519 sign/verify
primitive should be **factored to a reusable helper** (core/policy-kernel) rather
than copied from the approval-specific functions, so manifest, badge, and approval
signing share one audited implementation.

**3. Badges are locally-verifiable signed attestations, attached to — not baked
into — the manifest.** A badge is a small signed document
(`{ kind: "probe_results" | "security_scan", attester_id, …, signature }`) issued
by an attesting authority over a pack at a pinned version; a consumer verifies it
**locally** against pinned attester keys. The *format and local verification* are
open. *Being a trusted attester at scale* — running the scans, issuing a "verified"
badge the ecosystem relies on — is the commercial surface. A consumer never has to
trust the registry's word: a compromised index can fail to list or mis-list a
pack, but it can never make an unsigned/forged pack or badge verify.

**4. The open/commercial line, stated explicitly:**

> **OPEN (this repo, v1.5):** signed-manifest format + verify-on-load · npm/git
> source resolution · `lodestar pack publish` / `lodestar pack add` CLI · badge
> format + local verification · static signed index format · the threat-model /
> supply-chain doc.
>
> **COMMERCIAL (reserved, not in this repo):** the hosted search/discovery
> backend · the managed scanner that *runs* scans and *issues* trusted badges ·
> org-scoped / private packs · the curation/verification pipeline.

Nothing in the open layer gates the solo-dev workflow (positioning's critical
constraint).

**5. Scope cut: probe-pack (+ sentinels) first; generalize later.** v1.5 ships the
**existing** `lodestar.probe-pack.json` format with signing, source resolution,
and the publish/add CLI layered on. The unified `lodestar.pack.json
{ kind: policy | probe | sentinel | adapter }` generalization is **deferred** until
the trust plumbing is proven on the format that already exists and already loads.
The manifest already anticipates this — it carries a `PROBE_PACK_SPEC_VERSION` and
reserves the `npm` source type from day one — so generalizing later is a `kind`
discriminant added to a settled signing path, not a rewrite.

**6. Package home — reuse before a new package.** Schema additions (manifest
signature envelope, badge schema, `git` source type) go in
`@qmilab/lodestar-core`; signing reuses `@qmilab/lodestar-policy-kernel`; source
resolution and `pack publish` / `pack add` live in `@qmilab/lodestar-harness` (the
loader is already there) under the existing `lodestar` binary. A dedicated
`@qmilab/lodestar-registry` package is **deferred** — don't spin one up before the
surface needs it (same discipline as `fs.write` staying in `adapter-filesystem`,
ADR-0012).

**7. Ordered child sequence:**

> #91 threat-model + supply-chain doc → #88 signed manifests → #86 npm/git source
> resolution → #90 publish / add CLI → #89 badges + scan status → #87 discovery
> index

- **#91 leads** — the supply-chain threat model has to be written *before* the
  code, so the model drives the design (the signing-first discipline positioning
  §5 demands). No code; locks the *why*.
- **#88** is the trust root every other child verifies against; nothing downstream
  is safe without it.
- **#86** is the transport — how a published pack is fetched. Depends on nothing,
  unblocks #90.
- **#90** is the author/consumer flow that *produces* (#88-signed) and *consumes*
  (#86-resolved) packs.
- **#89** layers attestations on the now-signed, now-installable pack.
- **#87** is the read-side discovery surface — last, and deliberately thin (a
  static signed index), because the hosted version is commercial.

## Consequences

- The open registry is decentralized and non-gating: a pack works from
  local / npm / git with no Lodestar-hosted dependency, and the open/commercial
  boundary is a clean protocol-vs-service line.
- Verification is the consumer's, against pinned keys, so a compromised or hostile
  index cannot launder a malicious pack — it can only mis-advertise, never vouch.
- Each child remains its own feature branch → PR → merge with a locking probe
  (e.g. `pack-manifest-signature-required`, `forged-pack-cannot-load`,
  `pack-resolves-from-npm`, `unverified-badge-not-trusted`).
- More crypto surface in `@qmilab/lodestar-core` (manifest + badge signatures);
  mitigated by factoring one shared sign/verify helper rather than copying the
  approval functions.
- We accept that open-layer "discovery" is rudimentary (static index / git-topic
  convention). That thinness *is* the seam — richer search is the commercial pull.
- Generalizing to policy / adapter packs later is a schema addition guarded by the
  spec version, not a re-architecture.

## Alternatives considered

- **Build a hosted index/search service in-repo (Elysia, like the viewer).**
  Rejected — blurs the open/commercial seam and stands up a service prematurely;
  the open layer should be a protocol, and discovery is the commercial pull.
- **Generalize to `lodestar.pack.json { kind }` up front.** Deferred — a bigger
  schema fork to sign / verify / test at once; prove the trust plumbing on the
  probe-pack format that already exists first.
- **Stand up a `@qmilab/lodestar-registry` package now.** Deferred — premature;
  reuse core schema + policy-kernel signing + the harness loader until the surface
  demands its own package.
- **Server-issued badges (trust the registry's word).** Rejected — that is the
  centralized model the anti-ClawHub stance exists to avoid; badges must verify
  locally against pinned attester keys.
- **Lead with the CLI (#90) or signing (#88) and write the threat model after.**
  Rejected — the supply-chain model is the design input, not a postscript; writing
  it first is the discipline the whole epic was gated on.
