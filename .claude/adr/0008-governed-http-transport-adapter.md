# ADR-0008: Governed HTTP transport adapter (fetch + request)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Nandan, Claude
- **Related:** ADR-0004 (TS-level boundary), ADR-0005 (P2 sequence), ADR-0006
  (egress governance model), ADR-0007 (controlled-network sandbox; the eventual
  `http` slice named as its next user), `packages/adapters/http/`,
  `packages/action-kernel/src/registry.ts`

## Context

P2 slice 4 (ADR-0005): the **http** adapter. ADR-0005 promoted `http / web-fetch`
into the ordered native-adapter sequence as the highest-leverage remaining pick —
it is the only adapter that hits all three of Lodestar's governance surfaces at
once, and "browse the web / call an API safely" is a far more universal adoption
story than git or Nostr:

1. **Untrusted output (injection vector).** A fetched response body is the
   canonical prompt-injection source → the Memory Firewall / auto-observation
   gate's home turf (`external_document`, must not self-promote).
2. **Outward data movement (egress).** A request body leaving to an external host
   → `blast_radius: external`, the L4 human-approval gate, and the (otherwise
   dormant) `anomalous-tool-sequence` read → egress → write exfil pattern.
3. **Consequential action.** A send is irreversible.

The egress governance model is settled (ADR-0006/0007): destination pinning,
scoped credentials, untrusted inbound, an L4 hold. HTTP is the same shape with the
substitutions its protocol forces, and one new piece of teeth the earlier slices
did not need. The kernel was already provisioned: `controlled-network`
(ADR-0007), `Permission.network.egress`, `CapabilityHandle.kind: "fetch"`.

What HTTP changes vs. the git/Nostr model:

1. **The credential is a header, not a signing key or a forge token.** An API key
   / `Bearer` token / Basic string injected on requests to a specific host — so the
   credential model is host-bound header injection rather than in-process signing.
2. **Redirects are a first-class SSRF/exfil vector.** Destination pinning bounds
   the *initial* target, but a pinned host can `3xx` to a non-pinned one
   (`localhost`, `169.254.169.254`, an attacker host). This is the escape relay /
   remote pinning never had to consider, so it is the headline new teeth here.
3. **The body is an unbounded, untrusted byte stream.** Unlike a relay's framed
   events, an HTTP body has no inherent bound; capture must be explicitly bounded.

## Decision

**Ship `@qmilab/lodestar-adapter-http` with two tools** (config-driven factory,
mirroring `defineNostrTools`):

- **`http.request` — L4 egress.** Held until approved. POST/PUT/PATCH/DELETE
  (operator-restrictable). Declares a `publication` effect (like `git.push` /
  `nostr.publish`) so a host building the `ActionContract` marks it
  `blast_radius: external`. Teeth: host pinning, scheme allowlist, per-hop
  redirect re-validation, host-bound credentials, bounded capture.
- **`http.fetch` — L1 inbound, untrusted.** GET/HEAD. Returns the body as
  `external_document`-grade untrusted content. The same host pinning + scheme +
  redirect re-validation guard applies (an SSRF guard on reads).

**The teeth:**

- **Host pinning + scheme allowlist (`assertAllowedUrl`).** The operator pins
  allowed *hostnames* (domain-level, matching how real SSRF allowlists are
  written); the agent may only target a pinned host over an allowed scheme — HTTPS
  only unless `allowHttp` is set explicitly (no silent insecure default). A
  non-pinned host or a non-allowed scheme (e.g. `file://`) fails the action.
- **Per-hop redirect re-validation.** Redirects are followed *manually*; each hop's
  `Location` host is re-validated against the pin before the next request. A
  redirect to a non-pinned host is refused. 307/308 preserve method+body;
  301/302/303 degrade an unsafe method to GET (browser behaviour). This is the
  HTTP-specific escape that destination pinning alone misses.
- **Host-bound credentials, no silent default.** An auth header is operator-supplied
  and bound to the host the agent originally targeted, resolved at request time (a
  `() => Promise<string>` resolver seam). A cross-host redirect — even to another
  pinned host — carries no credential, so a server cannot steer the adapter into
  making host B's authenticated request (a confused-deputy). The credential is
  never in the agent's inputs (an agent-supplied copy of a reserved/credential
  header is dropped; the operator's value wins), and redacted from all captured
  output, including the final URL and the redirect chain (a redirect `Location`
  can echo the token).
- **An L1 read is not an arbitrary-header egress channel.** On `http.fetch` the
  agent may set only operator-allowlisted header names (default none); a Cookie /
  `X-*` value is agent data leaving to an external host, and a no-approval read
  must not become an egress path below the L4 gate (the URL is the intrinsic read
  channel, as `nostr.fetch` bounds its REQ filter). `http.request` is L4-approved,
  so its headers are unrestricted.
- **Bounded capture.** A wall-clock timeout (AbortController) and a streamed
  response-body byte cap — an untrusted, possibly hostile server cannot hang the
  call or inflate an observation.

**No new core schema or sandbox value.** The adapter reuses `controlled-network`
(ADR-0007) and `network.egress`. It needs no signing permission (the credential is
a header, not a signature), so it declares only `["network.egress"]`. The egress
tool's `blast_radius: external` comes from the proposer's `ActionContract` (the
kernel takes the contract from `propose()` and only enforces the tool's trust
level as a floor) — the `publication` effect is the standing signal to set it.

**Dependencies:** none beyond `@qmilab/lodestar-core`, `@qmilab/lodestar-action-kernel`,
and `zod`. The transport is the runtime's standard `fetch`; we hand-roll the thin
bounded/redirect-revalidating wrapper, mirroring the git/Nostr adapters
hand-rolling their scoped runner/relay client — full control of what crosses the
trust boundary.

**Same honesty boundary as ADR-0004/0006/0007:** a **TS-level governance boundary,
not network containment.** `fetch`/`request` reach the real host by design, and we
do **not** resolve DNS to block private address ranges (that is a network sandbox
we do not claim, and DNS rebinding can defeat a naive IP check). The destination
control is the pinned host allowlist + per-hop redirect re-validation.

Locked by `http-adapter-enforces-egress-invariants` (`packs/lodestar-core/`),
which drives the real tools through the real kernel against in-process `Bun.serve`
fakes, using `localhost` as the portable non-pinned alias of the loopback server
to exercise the redirect-to-internal SSRF escape. `lodestar-core` grows to **40**
probes (**44** across both packs).

## Consequences

- The third native tool to light the L4 gate (and, with the egress sentinel, the
  exfil pattern). Proves the egress model generalises again — a third transport
  (HTTP) and a third credential shape (a header) on the same teeth.
- The first native tool whose whole purpose includes pulling *arbitrary untrusted
  web content*. Deeper firewall integration (an HTML/JSON-aware evidence linker, à
  la the doc-agent's `DocAwareEvidenceLinker`) is the natural follow-up, not built
  here — the adapter labels the body untrusted; cognition decides what to do with
  it.
- Host pinning is hostname-level (domain allowlist), not origin-level (host:port).
  This matches real-world SSRF allowlists; an operator who needs port-level
  control can run the adapter behind a forward proxy. Noted so a future change is a
  conscious one.
- Redirect re-validation makes `http.*` safe to point at hosts that legitimately
  redirect (HTTP→HTTPS, apex→www) while still blocking the SSRF escape.

## Alternatives considered

- **One `http.request` tool with method-derived trust.** Rejected — the kernel
  assigns `required_trust_level` per *tool* (a static contract field, not per
  input), so GET-at-L1 and POST-at-L4 must be two tools. Two tools also reads
  honestly (a read vs. an egress) and mirrors `nostr.fetch`/`nostr.publish`.
- **Resolve DNS and block RFC1918 / link-local / metadata ranges.** Rejected as the
  *primary* control — it is network containment we do not claim, and DNS rebinding
  defeats a check done at validate-time but not connect-time. The honest control is
  the operator host pin; an operator who wants address-range blocking runs behind a
  network policy. (Revisit if/when a real socket-level sandbox lands.)
- **Follow redirects with the platform `fetch` default (`redirect: "follow"`).**
  Rejected — it would follow a pinned host's redirect to an arbitrary host with no
  re-validation, the exact SSRF escape. Manual following + per-hop re-validation is
  the whole point.
- **Let the agent supply the host or the credential header.** Rejected — same
  reason as git/Nostr: pin destinations, keep credentials operator-supplied. An
  agent-chosen host is both an exfil channel and an SSRF vector.
- **Fetch-only this slice.** Rejected — the egress (`http.request`) is the surface
  that lights the L4 gate and the exfil sentinel; shipping it with `http.fetch` is
  what makes `http` the "all three surfaces at once" adapter ADR-0005 promoted.
