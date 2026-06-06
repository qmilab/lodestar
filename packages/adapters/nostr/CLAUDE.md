# @qmilab/lodestar-adapter-nostr — CLAUDE.md

Governed Nostr transport tools for the Action Kernel — P2 slice 3 (ADR-0007).
The second native egress after `git.push`; same governance model (ADR-0006) with
the **signing key as the (in-process) credential**.

- **`nostr.publish`** — L4 egress. Sign a NIP-01 event (BIP-340 Schnorr) and
  publish it to operator-pinned relays. Held until approved.
- **`nostr.fetch`** — L1 inbound. Subscribe (REQ) to operator-pinned relays;
  return events as untrusted external content, each with a verified-signature flag.

## What lives here

- `src/event.ts` — NIP-01 primitives (`serializeEvent`, `computeEventId`,
  `signEvent`, `verifyEvent`) and NIP-19 bech32 (`note`/`npub`/`nsec`). Crypto is
  `@noble/curves` schnorr + `@noble/hashes` sha256 + `@scure/base` bech32. The
  serialize/id layer is hand-rolled (exact-by-spec, a few lines) so nothing
  higher-level mediates the trust boundary — mirrors the git adapter's hand-rolled
  runner. **BIP-340:** `schnorr.sign(message, sk)` signs the message bytes
  directly (no prehash — that option is ECDSA's); the Nostr message *is* the event
  id (a sha256 digest), so we pass it straight in, exactly as nostr-tools does.
- `src/credentials.ts` — the `NostrCredential` union (`secret-key` today; NIP-46 /
  NIP-49 are the future variants) and `prepareSigner`. Resolves a key (hex or
  `nsec1…`, or a `() => Promise<string>` resolver) to its bytes + derived pubkey +
  the redaction set, only inside `resolve()` — never retained.
- `src/relay.ts` — the relay WebSocket client: `publishToRelay` (EVENT → OK, with
  NIP-42 AUTH) and `fetchFromRelay` (REQ → EVENT* → EOSE). Bounded wall-clock
  timeout, bounded result capture, secret redaction. The Nostr-specific sibling of
  the git adapter's scoped `runGit` — same posture, WebSocket instead of subprocess.
- `src/tools.ts` — the `nostr.publish@1` / `nostr.fetch@1` output schemas, the two
  `Tool`s, the `make*Tool` builders, and the `defineNostrTools` /
  `registerNostrTools` config factory.
- `src/nostr.test.ts` — mechanism-level Bun tests against an in-process fake relay,
  including a known BIP-340 vector (sk=1 → the generator x-coordinate).

The headline invariants are locked by the harness probe
`packs/lodestar-core/probes/nostr-adapter-enforces-egress-invariants.ts`, which
drives the real tools through the real kernel.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not network containment** (same framing as
ADR-0004/0006). It enforces, in-process:

1. **Relay pinning.** The operator pins relay URLs; the agent targets only a
   pinned URL (default: all). It cannot redirect a note to an attacker relay, and
   on `fetch` it cannot make the adapter open a socket to an arbitrary host (SSRF
   guard). `resolveTargets` is the chokepoint; a non-pinned URL throws, and the
   targets are **deduplicated** (a repeated URL can't open N sockets or split the
   fetch budget into N shares).
2. **The signing key never leaves the adapter.** It signs in-process; only the
   pubkey + signature reach the wire. Operator-supplied (no silent default),
   hex-or-`nsec`, resolver-capable, redacted from all output.
3. **Kind allowlist.** Only operator-approved kinds publish (default `[1]`), so the
   agent cannot publish a deletion (5) or metadata/contact overwrite (0/3) without
   opt-in.
4. **NIP-42 AUTH.** An `auth-required:` reply (or relay-sent `["AUTH", challenge]`)
   triggers a kind-22242 auth event signed by the same key, then one resend.
5. **Untrusted inbound.** Fetched events carry a locally-computed `signature_valid`
   (id recomputed AND schnorr verified) but are untrusted content — a valid
   signature attests authorship, not truth. Malformed events are dropped + counted.
6. **Bounded fetch query.** A `fetch` filter is serialized into the outbound REQ,
   so its values are agent data leaving the process. Relay pinning bounds the
   destination; `assertBoundedFilter` additionally bounds the channel — hex-only
   `ids`/`authors`, capped list/filter counts, single-letter tag keys, capped
   tag-value length — so a read cannot become a large exfiltration path, and the
   query is recorded in the action inputs for audit. An operator who needs even a
   bounded query approval-gated raises the fetch `trust` floor.

**What it does NOT claim:** it does not OS-sandbox the network. `publish`/`fetch`
reach the real relay *by design* — that is the governed action. Keep this honest
in docs and tool descriptions.

## Trust contracts

| Tool | Trust | blast_radius | reversibility | sandbox | permissions |
|------|-------|--------------|---------------|---------|-------------|
| `nostr.publish` | **L4** | `external` | `irreversible` | `controlled-network` | `network.egress`, `secret.sign` |
| `nostr.fetch` | L1 | `project` | `reversible` | `controlled-network` | `network.egress` |

`nostr.publish` @ L4 is the headline: it parks at `pending_approval` until a human
resolves it. Do **not** lower the floor to make a demo pass. Neither tool spawns a
subprocess, so neither declares `shell.exec`; the honest sandbox is
`controlled-network` (network egress, no shell, no fs) — added in ADR-0007 because
no existing profile fit a protocol-native egress tool.

## When you extend this

- Keep credentials operator-supplied and out of the agent's hands. The signing key
  is the identity; an agent-chosen key or relay is an exfil/SSRF vector.
- New credential kinds (NIP-46 remote signer, NIP-49 `ncryptsec`) extend the
  `NostrCredential` union — none should hand the raw key to the agent. The
  `CapabilityHandle` (`kind: "sign"`) path is the forward direction once kernel
  capability resolution lands (ADR-0006/0007).
- Declare real `effects` / `reversibility` / `required_trust_level` / `sandbox`. No
  silent defaults for security-relevant settings.
- v0 does not mine NIP-13 proof-of-work; a relay `pow:` rejection is surfaced
  honestly. If you add PoW, it is a publish-time cost, not a governance relaxation.
- The `nostr-adapter-enforces-egress-invariants` probe is spec. If a change makes
  it pass without exercising relay pinning, the L4 hold, credential redaction, the
  kind allowlist, NIP-42 AUTH, or the fetch signature/SSRF checks, that's a probe
  bug, not an improvement.
