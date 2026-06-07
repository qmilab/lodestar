# ADR-0010: Signed approval resolutions (the cross-process forgery boundary)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Nandan, Claude
- **Related:** ADR-0001/0002/0003 (the approval lifecycle + sentinel→action
  wiring), the Policy Kernel host-wiring slices (3a/3b/3c — guard.wrap resolver,
  proxy out-of-band hold, `lodestar approve` side-channel), `docs/architecture/policy-kernel.md`,
  `packages/policy-kernel/src/approval-signature.ts`, `packages/guard-mcp/src/{config,proxy,approvals-channel}.ts`,
  `packages/cli/src/commands/approve.ts`

## Context

P3, first slice (the post-P2 security/hardening track). The MCP proxy holds an L4
action at `pending_approval` and, when `approval_timeout_ms > 0`, promotes an
out-of-band resolution it finds in the side-channel
(`<log_root>/.approvals/<project>/<request-id>.json`) into a canonical
`approval.granted@1`, then runs the held tool.

The gap, named in the code since slice 3c: that file's `approver_id` is a **plain
string**. Anything that can write the `.approvals/` directory can forge a grant.
The `lodestar approve` authority check (`authorizeResolution`) runs in the
*writer* process, so a hostile writer simply skips it — it is honest-mistake
protection, not a boundary against a malicious local writer. The `cli`/`guard-mcp`
CLAUDE.md both flagged "signed actors / a trusted actor registry the proxy
verifies" as the deferred deeper hardening. This ADR is that work.

The in-repo policy-signature path was *not* a usable precedent for the crypto: it
uses a host-**injected** `verifySignature` seam, and the reference probe signs
with a base64 placeholder. That is acceptable for a policy document the trusted
host loads, but the approval side-channel is a genuine cross-process forgery
surface — the verification has to be **real**.

## Decision

**Sign the resolution with the approver's Ed25519 key; the proxy verifies against
operator-pinned approver public keys before promoting.** The trust root moves from
"can write the file" to "holds the approver private key".

1. **Real Ed25519, no new dependency.** `@qmilab/lodestar-policy-kernel` gains
   `canonicalApprovalResolutionHash` + `signApprovalResolution` /
   `verifyApprovalSignature` / `generateApproverKeyPair`, built on Node's native
   `node:crypto` Ed25519 (the same dependency-free primitive `hash.ts` already
   uses). The signature is over the canonical resolution document
   `{ request_id, action_id, kind, approver_id, reason?, at }`; `signer_id` is
   bound to `approver_id`. The reject set mirrors `verifyPolicySignature` plus the
   pinned-key check: absent (unless `allow_unsigned`), `payload_hash` mismatch,
   `signer_id ≠ approver_id`, **signer not in the operator-pinned set**, non-ed25519,
   bad signature bytes. `payload_hash` alone is *not* a forgery defence (an
   attacker recomputes it over their own forged doc) — the teeth are the signature
   verifying against a key whose private half the attacker lacks.

2. **Pin the keys in the proxy config.** `ProxyConfig.approvals = { authorized_keys:
   {actor_id, public_key}[], allow_unsigned? }`. The proxy verifies a side-channel
   resolution before promoting; a forged / unsigned / unpinned-signer / tampered
   file is **not promoted** — the action stays held to its deadline and times out,
   and a best-effort `guard.approval.signature_rejected` diagnostic is recorded
   (deduped once; the mark is set only after a successful emit, and a rejected
   side-channel file is deleted so a planted file is not a per-poll crypto sink).
   The promoted `approval.granted@1` carries the verified signature, so the **log
   is self-verifying**.

   **The gate covers BOTH resolution sources, not just the side-channel.**
   `.approvals/` is a *sibling* of the NDJSON log under the same `log_root`, so a
   local writer who can forge a side-channel file can equally append a forged
   `approval.granted@1` to the log. The same Ed25519 gate therefore runs on the
   **log path** (`resolutionOutcomeFor`) too — a forged unsigned log event is
   rejected, recorded (deduped by event id — the log is append-only), and skipped,
   not promoted. (Review found the original channel-only check left this bypass;
   the `forged-approval-cannot-execute` probe now pins both paths.)

3. **Require-signed by default, explicit `allow_unsigned` opt-out.** A proxy that
   can wait for an out-of-band resolution (`approval_timeout_ms > 0`) must either
   pin at least one approver key **or** set `approvals.allow_unsigned: true`. The
   gap is rejected at `ProxyConfigSchema` parse *and* re-checked in the `MCPProxy`
   constructor via the shared `hasUnauthenticatedApprovalGap` predicate (the TS
   type doesn't encode the superRefine, so a library host building a literal config
   would otherwise bypass it — the same schema-guard + constructor-guard pairing
   the persistence / sentinel guards use; one predicate so the two cannot drift).
   No silent default for a security-relevant setting; mirrors the policy
   `allow_unsigned` discipline. `approval_timeout_ms === 0` never promotes a
   side-channel resolution, so it has no forgery surface and no requirement.
   **`allow_unsigned` is the no-keys legacy/dev escape only**: once *any* approver
   key is pinned, a valid signature is required even if `allow_unsigned` is also
   set — a stray opt-out flag must not silently weaken a key-pinned path. A pinned
   key that is not a parseable Ed25519 SPKI PEM fails loudly at construction
   (`assertValidApproverKeys`), rather than silently rejecting every real approval
   as if it were a forgery.

4. **The CLI signs; `keygen` mints keys.** `lodestar approve grant/deny` loads the
   approver's private key from `--key <path>` or the `LODESTAR_APPROVER_KEY` env
   (never argv — a path is fine, the secret is not), and signs the resolution after
   `authorizeResolution` passes. `lodestar approve keygen --approver <id> [--out
   <prefix>]` mints an Ed25519 keypair (private PKCS#8 at mode 0600, public SPKI)
   and prints the ready-to-paste `authorized_keys` pin.

## Consequences

- The held L4 — the whole point of the trust-ladder floor — now un-parks only for
  a real, operator-authorised approver. The `forged-approval-cannot-execute` probe
  pins it: a signed grant from the pinned key runs; a forgery (attacker key
  claiming the operator's id), an unsigned resolution, and a signed-then-tampered
  resolution are each refused and time out. `lodestar-core` grows to **42** probes.
- **In-process `guard.wrap()` is unaffected** — same trusted process, no
  side-channel, no forgery surface. The optional `signature` field on the
  grant/deny payloads is available there for log self-verification but is not
  enforced. Enforcement targets the cross-process side-channel only.
- The existing `approval-via-side-channel` probe (promotion mechanics, sole-writer
  seq) and `approval-timeout-denies` (in-process log path) now set
  `approvals.allow_unsigned: true` explicitly — the same behaviour they always
  had, now an explicit configuration rather than an implicit gap. Probes are spec:
  signing is added on top, not weakened.

## Alternatives considered

- **Opt-in enforcement (verify only when keys are configured).** Rejected — leaves
  the forgery hole open by default. The whole point is secure-by-default; an
  operator who genuinely wants the unsigned path says so with `allow_unsigned`.
- **Reuse the policy injected-`verifySignature` seam.** Rejected for approvals —
  it has no real crypto in-repo, and the side-channel needs an actual signature
  check, not a host-pluggable stub. (The new real verifier *could* later replace
  the policy placeholder; that is a separate follow-up, deliberately out of scope.)
- **A separate trusted-actor registry service.** Deferred — pinning public keys in
  the operator-controlled proxy config is the minimal trust root that closes the
  hole without standing up new infrastructure. A registry is a post-v1 multi-actor
  concern.
