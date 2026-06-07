# ADR-0007: Governed Nostr transport adapter (publish + fetch)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Nandan, Claude
- **Related:** ADR-0004 (TS-level boundary), ADR-0005 (P2 sequence), ADR-0006
  (egress governance model), `packages/adapters/nostr/`,
  `packages/action-kernel/src/registry.ts` (`SandboxProfile`, `Permission`,
  `CapabilityHandle`)

## Context

P2 slice 3 (ADR-0005): the **nostr** adapter — "publish a note" is the second
native egress after `git.push`. The egress governance model is already settled
(ADR-0006): an L4 human-approval gate, destination pinning, scoped credentials,
untrusted inbound content. Nostr is the same shape with three substitutions the
official NIPs force, and one capability the kernel was already provisioned for.

What the NIPs change vs. the git model:

1. **The signing key *is* the credential** (NIP-01). Whoever holds the secret key
   can publish as that identity. Unlike git's token-to-a-remote, the secret is
   used to *sign in-process* (BIP-340 Schnorr over secp256k1) — it never crosses
   a process boundary or the wire; only the derived pubkey and the 64-byte
   signature do. So git's argv/no-shell/process-group hardening does not apply;
   the boundary is "the key never leaves the adapter and never lands in output."
2. **The outcome is the relay's verdict, not fire-and-forget** (NIP-01). The
   relay replies `["OK", id, accepted, message]` with machine-readable reason
   prefixes (`auth-required:`, `pow:`, `rate-limited:`, `blocked:`, …). Publish
   awaits OK per relay.
3. **Restricted relays require NIP-42 AUTH.** On `auth-required:` (or a
   relay-sent `["AUTH", challenge]`), the client signs a kind-22242 event
   (tags `relay`, `challenge`) with the *same* key and resends.

The kernel already anticipated this adapter: `Permission` has `secret.sign`, and
`CapabilityHandle.kind` is `"sign" | "fetch" | "publish"` — the Nostr verbs.

## Decision

**Ship `@qmilab/lodestar-adapter-nostr` with two tools** (config-driven factory,
mirroring `defineGitTransportTools`):

- **`nostr.publish` — L4 egress.** Held until approved. Teeth:
  - **Relay pinning.** The operator pins the allowed relay URLs; the agent may
    target only a pinned URL (default: all of them). It cannot exfiltrate a note
    to an attacker-controlled relay — the analogue of git's remote pinning.
  - **Kind allowlist.** The operator pins publishable kinds (default `[1]`, text
    notes), so the agent cannot publish a deletion (kind 5) or a metadata /
    contact-list overwrite (kind 0 / 3) without opt-in.
  - **Credential scoping, no silent default.** The secret key is operator-supplied
    (64-hex or NIP-19 `nsec1…`), resolved at publish time (a `() => Promise<string>`
    resolver seam), never seen by the agent, never on the wire, redacted from
    output. Forward direction: route it as a `CapabilityHandle` (`kind: "sign"`)
    once kernel capability resolution lands — same note ADR-0006 made for git.
  - **NIP-42 AUTH** with the same key, one retry.
- **`nostr.fetch` — L1 inbound, untrusted.** Returns events each stamped with a
  locally-computed `signature_valid` (id recomputed AND schnorr verified);
  malformed events are dropped and counted. A valid signature attests authorship,
  not truth — content stays untrusted. Relay pinning applies to reads too: the
  agent cannot make the adapter open a socket to an arbitrary URL (an **SSRF
  guard**).
  - **Fetch carries no redaction set, by design.** `publish` redacts captured
    output against the signer's secret; `fetch` passes an empty set. This
    asymmetry is intentional, not an oversight: the redaction set is derived
    solely from the operator signing key, which signs in-process so only the
    pubkey + signature reach the wire. A relay never possesses that secret, so it
    cannot embed it in a returned event body — redacting inbound bodies against it
    would be a literal no-op. Inbound safety is the `signature_valid` check plus
    L1-untrusted tagging, not redaction. The only condition that would make a fetch
    redaction set real is a future `NostrCredential` kind (NIP-46 remote signer,
    NIP-49 `ncryptsec`) whose secret is wire-visible and could be replayed by a
    relay; the call site flags that revisit condition.

**Add a `controlled-network` `SandboxProfile`.** None of the existing profiles is
honest for a tool that does network egress with no shell and no fs writes (git
reused `controlled-shell` *because it spawns `git`*; the Nostr adapter signs and
opens a WebSocket in-process). The sandbox profile is the coarse hint; the precise
declaration is `permissions` (`["network.egress", "secret.sign"]` for publish,
`["network.egress"]` for fetch). Additive enum value; the only consumers are the
type, two re-exports, a CLI printer, and the guard-mcp config validator (updated
in lockstep) — no sandbox-enforcement engine exists yet to break.

**Dependencies:** `@noble/curves` (BIP-340 schnorr), `@noble/hashes` (sha256),
`@scure/base` (bech32 for NIP-19). Audited, minimal, the de-facto Nostr/crypto
primitives (nostr-tools itself sits on them). We hand-roll the thin event
serialize/id layer and the relay WebSocket client — full control of what crosses
the trust boundary, mirroring the git adapter hand-rolling its scoped runner.

**Same honesty boundary as ADR-0004/0006:** a **TS-level governance boundary, not
network containment.** `publish`/`fetch` reach the real relay by design; the
governance is relay pinning + the in-process key + the L4 gate + untrusted
inbound — not a network sandbox.

Locked by `nostr-adapter-enforces-egress-invariants` (`packs/lodestar-core/`),
which drives the real tools through the real kernel against in-process fake
relays. `lodestar-core` grows to **39** probes (**43** across both packs).

## Consequences

- The second native tool to light up the L4 gate (and, with the egress sentinel,
  the exfil pattern). Proves the egress model generalises beyond git — a different
  transport (WebSocket), a different credential (a signing key), the same teeth.
- `nostr.fetch` is the first native tool whose whole purpose is untrusted inbound
  content; deeper firewall integration (a Nostr-aware evidence linker, à la the
  doc-agent's `DocAwareEvidenceLinker`) is the natural follow-up, not built here.
- **PoW (NIP-13) is not implemented in v0:** a `pow:` rejection is surfaced
  honestly, not mined around. **NIP-46 remote signing / NIP-49 `ncryptsec`** are
  natural future `NostrCredential` variants; the union is shaped to grow.
- `controlled-network` is now available to any future protocol-native egress
  adapter (the eventual `http` slice is the obvious next user).

## Alternatives considered

- **Use `nostr-tools` instead of low-level primitives.** Rejected — heavier and
  more opinionated (its own relay pooling to constrain); the low-level path keeps
  the egress governance and redaction fully in our hands.
- **Reuse `controlled-shell` for the sandbox (as git did).** Rejected — dishonest;
  the Nostr adapter spawns no shell. Declaring `shell.exec` it never uses violates
  "no silent/over-broad security defaults."
- **Publish-only this slice.** Rejected — fetch is cheap on the same relay client
  and demonstrates the untrusted-inbound surface (signature-verify + SSRF guard)
  that pairs with the egress story.
- **Let the agent supply a relay URL or the signing key.** Rejected — same reason
  as git: pin destinations, keep credentials operator-supplied. An agent-chosen
  relay is both an exfil channel and an SSRF vector.
