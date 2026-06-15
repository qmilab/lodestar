# ADR-0017: Signed pack manifests — shared signing primitive, content binding, verify-on-load

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Nandan, Claude
- **Related:** Epic #76, issue #88 (this work), ADR-0016 (registry architecture;
  §2 content-binding, §7 build order), ADR-0010 (the Ed25519 approval-signature
  lineage this factors from), `docs/concepts/threat-model/registry-supply-chain.md`,
  `packages/core/src/schemas/probe-pack.ts`, `packages/harness/src/pack/loader.ts`

## Context

#88 is step 2 of the registry epic — the trust root every later child verifies
against. The signature must bind the **pack contents, not just the declaration**
(ADR-0016 §2, the Codex-flagged supply-chain hole): without a content digest, a
re-pointed git tag / re-published npm artifact swaps probe bytes under a
still-valid signature.

Three decisions had real alternatives and are recorded here.

## Decision

**1. The shared Ed25519 primitive lives in `@qmilab/lodestar-core` (`src/crypto/`).**
The audited `node:crypto` sign/verify/keygen + pinned-key logic that ADR-0010 put
in `policy-kernel/approval-signature.ts` is factored into
`core/src/crypto/signing.ts` (`signPayloadHash`, `verifyPayloadHashSignature`,
`generateEd25519KeyPair`, `assertValidPublicKeys`, `lookupPinnedKey`), parameterised
by a `makeError` factory and a `subject` label so each domain keeps its typed error
and contextual message. `signApprovalResolution` / `verifyApprovalSignature` become
thin wrappers over it (same signatures, same `ApprovalSignatureError`, behaviour
unchanged — the approval tests assert on the error *type*, which is preserved).
Manifest signing (`core/src/crypto/probe-pack-signing.ts`) and badge signing (#89)
reuse the same code.

*Why core, not policy-kernel:* the primitive is pure compute (`node:crypto`, no
I/O, no state) over core's own `Signature` type. Core is the one package everyone
already depends on, so sharing from there adds **no new cross-package edges**. The
alternative — keeping it in policy-kernel — would force the *harness pack loader*
to depend on the *policy + action kernel* (policy-kernel → action-kernel) merely to
verify a signature, coupling the probe runner to the gate engine. This narrowly
refines core's "types and schemas only" norm to permit **pure, dependency-free
crypto/canonicalisation primitives over core's wire types** (core already hosts
runtime in `registry.ts`); it does not relax the hard no-I/O / no-DB / no-HTTP
constraint. `stableStringify` graduates to core and policy-kernel's `hash.ts`
re-exports it (byte-identical, so existing signed-policy / approval hashes still
verify).

**2. The content digest covers the manifest's declared probe files.** The signed
manifest carries `content_digest: { algorithm: "sha256", files: [{ path, sha256 }] }`
— a sorted per-file hash list over every probe `file` the manifest declares. The
list is stored (not just a combined digest) so the loader can name the offending
file on mismatch and so the binding is auditable. Signing the manifest (which
embeds this list) transitively authenticates the shipped probe bytes. Sentinels are
id-referenced against the in-harness registry — the pack ships no sentinel bytes —
so they are out of the digest by construction. **Whole-tree hashing** (an
undeclared helper a probe imports could still be swapped) is the documented
hardening follow-up; declared-probe-files is the honest, bounded v0 scope and
satisfies the `tampered-pack-content-cannot-load` invariant.

**3. `allow_unsigned` is secure-by-default, mirroring `verifyApprovalSignature`.**
The loader rejects an unsigned manifest unless an explicit `allowUnsigned: true`;
a *present* signature is always fully verified against operator-pinned author keys
regardless of the flag (the flag only governs the absent-signature case). First-party
in-repo packs load via an explicit `allowUnsigned: true` at their call sites — no
silent default. **Signing the first-party packs themselves is deferred to the
publish CLI (#90)**, which produces the signature over frozen files; #88 ships the
verify-on-load capability and exercises sign+verify with ephemeral runtime keys in
the probes (no committed keys).

## Consequences

- Reject set on load (typed `ProbePackError`): signature absent (unless
  `allowUnsigned`), `payload_hash` ≠ recomputed canonical manifest hash, signer ≠
  declared `author_id`, signer not in the pinned author-key set, non-ed25519,
  bad signature bytes, **and content-digest mismatch after on-disk resolution**.
- New optional manifest fields (`author_id`, `content_digest`, `signature`) are
  additive since spec `"1"` — an older loader still reads a manifest without them,
  honouring the "additive optional field is free" promise. No `PROBE_PACK_SPEC_VERSION`
  bump.
- Existing `loadProbePack(target)` callers (CLI, harness tests) must opt in with
  `allowUnsigned: true` for the unsigned first-party packs; this is the intended
  flip, not a regression.
- Content-digest computation (fs) lives in the harness; the canonical-hash and
  sign/verify (pure) live in core — the same core-owns-format / harness-owns-resolution
  split the loader already follows.
- Probes: `pack-manifest-signature-required`, `forged-pack-cannot-load`,
  `tampered-pack-content-cannot-load`.
