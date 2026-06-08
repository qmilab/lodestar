---
title: "Governed egress & native adapters"
description: "The native adapters — git, http, nostr, messaging, shell — that govern the irreversible, outward actions: held at L4 until approved, with pinned destinations, scoped credentials, and untrusted inbound content."
---

# Governed egress & native adapters

The actions that actually carry risk are the ones that **leave the project**:
pushing a commit, calling an API, sending an email or a Slack message, publishing
a note. They reach the outside world, they often carry a credential, and you
cannot quietly undo them. Lodestar ships **native adapters** that put exactly
these actions under the [trust ladder](trust-ladder.md) and the
[Policy Kernel](policy-kernel.md).

## The adapters

Each adapter is a governed tool (or set of tools) you register with the kernel:

| Adapter | Tools | What it reaches |
| --- | --- | --- |
| **git** (`adapter-git`) | `git.status` (L0), `git.commit` (L3), `git.push` (**L4**), `git.clone` (L3, inbound) | any git remote — the first native egress |
| **http** (`adapter-http`) | `http.request` (**L4**), `http.fetch` (L1, inbound) | an agent-authored body to an external host |
| **nostr** (`adapter-nostr`) | `nostr.publish` (**L4**), `nostr.fetch` (L1, inbound) | a signed note to a relay |
| **messaging** (`adapter-messaging`) | `slack.post` (**L4**), `email.send` (**L4**) | a message to a channel or recipient |
| **shell** (`adapter-shell`) | operator-declared commands, each its own tool with its own trust floor | a real binary |

The split between an **L4 egress** (held until approved) and an **L1 inbound
fetch** (untrusted content, never auto-trusted) is deliberate: writing to the
world needs a human; reading from it produces an
[`external_document`](threat-model/memory-poisoning.md) the firewall treats as
hostile.

## The shared model

Every egress adapter holds the same invariants *through the kernel*:

- **Held until approved.** An L4 egress stops at `pending_approval`; the
  irreversible step doesn't run until a [signed approval](policy-kernel.md)
  releases it.
- **The destination is operator-pinned, not agent-chosen.** The agent names a
  *handle* (a remote, a host, a relay, a channel); the operator pins what that
  handle resolves to. A poisoned config, an injected URL, or an agent-supplied
  recipient can't redirect the action — this is the exfiltration guard.
- **The credential never surfaces.** Tokens and signing keys are operator-supplied
  (resolver-capable, fetched at action time), flow out of band (never on `argv`),
  and are redacted from every input, observation, and error message — even when a
  server echoes them back.
- **Untrusted inbound is tagged, not trusted.** A fetched response or event is
  captured to a byte cap and marked `external_document` / signature-checked; a
  valid signature attests *authorship*, not *truth*.

## Where the teeth differ

The model is shared; each transport has one sharp edge worth knowing:

- **git** — the push targets the *pinned* remote URL explicitly, bypassing a
  poisoned `.git/config`; the credential flows via `GIT_ASKPASS`, never argv.
- **http** — **per-hop redirect re-validation**: a pinned host that 3xx-redirects
  to `localhost` / a metadata endpoint / any non-pinned host is *stopped*
  (destination pinning alone misses this SSRF escape), and the credential is bound
  to the original host so a redirect carries no token.
- **nostr** — the signing key *is* the credential; the note is signed **in
  process** (BIP-340) so only the public key and the signature reach the wire.
- **messaging** — recipients are pinned by exact address *and* whole domain, the
  sender is operator-fixed (no spoofing), and a provider `ok:false` ends the
  action `failed` rather than silently "sent."
- **shell** — fixed-binary, argv-only exec (no shell string → no injection), an
  argument allowlist, scoped env (no host-env passthrough), and a wall-clock
  timeout that reaps the whole process group.

## The honest boundary

These are **TS-level governance boundaries, not OS or network containment.** The
point isn't to *prevent* the agent from reaching the network — an approved `git
push` genuinely pushes. The point is to make every such action **named, rated,
held for approval, attributed, and audited**, with the credential and the
destination outside the agent's control. For hard isolation — namespaces, cgroups,
a network jail — run the downstream tools inside your own OS sandbox. That layer
is a later concern; the governance layer is what ships today.

## Related

- [The trust ladder](trust-ladder.md) — why a push is L4 and a read is L1.
- [The Policy Kernel & approvals](policy-kernel.md) — the hold that gates an
  egress and the signed approval that releases it.
- [Memory poisoning](threat-model/memory-poisoning.md) — why inbound fetched
  content is treated as hostile.
- [CLI reference](../reference/cli.md) — the commands behind the adapters.
