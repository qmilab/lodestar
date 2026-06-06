# @qmilab/lodestar-adapter-nostr

Governed [Nostr](https://github.com/nostr-protocol/nips) transport tools for the
Lodestar Action Kernel — part of **Lodestar**, the trust layer for AI agents.

Two tools, both forge-… er, relay-agnostic (they speak the Nostr protocol to any
relay):

| Tool | Trust | Direction | What it does |
|------|-------|-----------|--------------|
| `nostr.publish` | **L4** | egress | Sign a note (BIP-340) and publish it to operator-pinned relays. Held until a human approves. |
| `nostr.fetch` | L1 | inbound | Subscribe (REQ) to operator-pinned relays and return events as **untrusted** content, each with a verified-signature flag. |

`nostr.publish` is the second native egress in Lodestar after `git.push`, and it
carries the same governance teeth (ADR-0006 / ADR-0007) with one substitution: on
Nostr the **signing key is the credential**, and signing happens in-process.

## Install

```sh
bun add @qmilab/lodestar-adapter-nostr
```

## Use

```ts
import { registerNostrTools } from "@qmilab/lodestar-adapter-nostr"

registerNostrTools({
  publish: {
    // The operator pins the allowed relays. The agent can target a pinned URL
    // (or, by default, all of them) — never an arbitrary one.
    relays: ["wss://relay.damus.io", "wss://nos.lol"],
    // The signing key IS the credential. Hex or `nsec1…`; a function is resolved
    // at publish time so a host can fetch it from a secret store. Never argv,
    // never on the wire, redacted from output.
    credential: { kind: "secret-key", key: () => secrets.fetch("NOSTR_NSEC") },
    // Only text notes by default. The agent can't publish a deletion / profile
    // overwrite (kinds 5 / 0 / 3) without an explicit opt-in here.
    allowedKinds: [1],
  },
  fetch: {
    relays: ["wss://relay.damus.io"], // pinning is also an SSRF guard on reads
    maxEvents: 200,
  },
})
```

The tools register into the Action Kernel's tool registry. Drive them through the
kernel (`propose → arbitrate → execute`) like any governed tool; a host (Guard,
the MCP proxy, an example) supplies the policy gate and `KernelContext`. The L4
`nostr.publish` parks at `pending_approval` until a human resolves it.

### The agent's inputs

```ts
// nostr.publish
{ content: "hello nostr", tags?: [["t","lodestar"]], kind?: 1, relays?: ["wss://…"] }

// nostr.fetch
{ filters?: [{ kinds: [1], authors: ["<hex>"], limit: 50 }], relays?: ["wss://…"] }
```

`relays` in either input must be a subset of the operator-pinned set; anything
else fails the action.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not network containment** (the same honesty as
the shell and git adapters, ADR-0004/0006). It enforces, in-process:

1. **Relay pinning.** The agent can publish/fetch only to operator-pinned relay
   URLs. It cannot exfiltrate a note to an attacker relay, nor make the adapter
   open a socket to an arbitrary host (an SSRF guard on `fetch`).
2. **The signing key never leaves the adapter.** It signs in-process (BIP-340
   Schnorr); only the public key and signature go on the wire. It is
   operator-supplied (no silent default), accepted as hex or `nsec1…`, optionally
   a resolver, and redacted from all captured output.
3. **Kind allowlist.** Only operator-approved event kinds publish (default: kind 1).
4. **NIP-42 AUTH.** Restricted relays that reply `auth-required:` are
   authenticated with a kind-22242 event signed by the same key, then the note is
   resent — once.
5. **Untrusted inbound.** Fetched events are returned with a locally-verified
   `signature_valid` flag and are otherwise untrusted external content (a valid
   signature attests authorship, not truth). Malformed events are dropped + counted.

**What it does NOT claim:** it does not OS-sandbox the network. `publish`/`fetch`
reach the real relay by design — that is the governed action. The governance is
relay pinning + the in-process key + the **L4 human-approval gate** + treating
inbound events as untrusted — not network isolation.

**Not implemented in v0:** NIP-13 proof-of-work (a relay's `pow:` rejection is
surfaced, not mined around). NIP-46 remote signing and NIP-49 `ncryptsec` are
natural future credential variants.

## License

Apache-2.0
