# ADR-0009: Governed messaging transport adapter (Slack + email)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Nandan, Claude
- **Related:** ADR-0005 (P2 sequence; messaging is the last ordered pick), ADR-0006
  (egress governance model), ADR-0007 (controlled-network sandbox), ADR-0008
  (host-bound header credential, bounded capture), `packages/adapters/messaging/`,
  `packages/action-kernel/src/registry.ts`

## Context

P2 slice 5 (ADR-0005), the final pick in the ordered native-adapter sequence
(shell → git → nostr → http → **messaging**). ADR-0005 promoted messaging as
*"the canonical irreversible-external L4 action — the clearest demonstration of
the Policy Kernel human-approval gate just wired in (slices 3a/3b/3c)."* Where
`http` was chosen because it hits all three governance surfaces at once, messaging
is chosen for the opposite reason: it is the **purest** instance of one surface —
an outward, irreversible send that a human must approve. You cannot un-send an
email or a Slack message, and "the agent wants to message a person" is the most
legible place a human-in-the-loop gate earns its keep.

The egress governance model is settled (ADR-0006/0007/0008): destination pinning,
operator-supplied scoped credentials, an L4 hold, bounded capture. Messaging is
the same shape with the substitutions its domain forces, and one structural
*simplification* over `http`:

1. **The agent does not supply the destination host.** For `http` the agent named
   the URL, so host pinning + per-hop redirect re-validation were load-bearing
   (the SSRF surface). For messaging the *provider endpoint is operator-fixed*
   (Slack's API base, the email API URL) — the agent never names a host, so there
   is no agent-driven SSRF and no redirect to chase. A provider 3xx is treated as
   a hard failure, not followed.
2. **The destination the agent controls is the recipient.** A Slack *channel* or
   an email *address*. That is the messaging-specific exfil vector, and the thing
   the operator pins here — the analogue of host/relay/remote pinning, but for
   *who receives the message* rather than *which host is dialed*.
3. **The sender identity is operator-fixed.** The email `from` is operator config,
   never an agent input (anti-spoofing); the Slack identity is fixed by the bot
   token.

## Decision

**Ship `@qmilab/lodestar-adapter-messaging` with two L4 egress tools**
(config-driven factory, mirroring `defineHttpTools`):

- **`slack.post` — L4 egress.** Held until approved. Posts `{channel, text}` to
  the operator-fixed Slack Web API (`chat.postMessage`). Destination control: a
  **channel allowlist**.
- **`email.send` — L4 egress.** Held until approved. POSTs a provider-shaped JSON
  payload (default Resend/Postmark-style, operator-overridable via `buildPayload`)
  to the operator-supplied email-API endpoint. Destination control: a **recipient
  allowlist** (exact addresses and/or whole domains).

Both declare a `publication` effect (like `git.push` / `nostr.publish` /
`http.request`) so a host building the `ActionContract` marks them `blast_radius:
external`.

**The teeth:**

- **Destination pinning (the exfil guard).** The operator pins allowed Slack
  channels and email recipients; the agent may send only to those. A channel match
  is format-insensitive (`#general`/`general`/case) and the *operator's canonical*
  channel string is what is sent — the agent cannot smuggle a different channel via
  a format trick. A recipient must match an exact address or fall under an allowed
  domain; a single off-allowlist recipient fails the whole send. The agent cannot
  email `attacker@evil.com`.
- **Operator-fixed endpoint + sender, no silent default.** The provider host is
  operator config, not an agent input (no agent-driven SSRF). The email `from` is
  operator-fixed (no sender spoofing). The email endpoint has *no default* — there
  is no silent default for where mail goes. HTTPS-only unless `allowHttp` is set.
- **Scoped credentials.** A single operator-supplied auth header (a Slack bot
  token, an email-API key), resolved at request time (`() => Promise<string>`
  resolver seam), never in the agent's inputs, and redacted (raw + URL-encoded
  forms) from all captured output. Simpler than `http`'s host-bound model: the
  endpoint is fixed, so there is no cross-host confused-deputy surface to defend.
- **No redirect following.** A messaging API does not legitimately redirect a
  send; following one would be the SSRF/exfil escape. A provider 3xx is a hard
  failure. (This is where messaging is *simpler* than `http` by design, not where
  it cuts a corner.)
- **Delivery semantics.** A send is binary: a non-2xx — and, for Slack, an
  `{ok:false}` returned with HTTP 200 — is a **delivery failure** that ends the
  action `failed`, not a silent "completed". (This differs from `http.fetch`,
  where a 4xx is meaningful captured *read* data; for a *send* tool, "did it go?"
  must not be papered over.)
- **Bounded capture.** A wall-clock timeout (AbortController, covering the async
  credential resolver via `raceAbort`) and a response-body byte cap — a hostile or
  misbehaving provider cannot hang the call or inflate an observation.

**Scope: egress only this slice.** Inbound reading (`slack.read` / `email.fetch`
as L1 untrusted content) is a deferred follow-up. `http.fetch` already proves the
untrusted-inbound surface comprehensively, and bounding this slice to the *send*
keeps it the clean human-approval demonstration ADR-0005 asked for. Two egress
tools across two transports is still a full slice — the contrast (channel vs
recipient/domain destination; bot token vs API key; Slack `ok:false` vs HTTP
status delivery semantics) is what shows the model generalises across
destination/credential/delivery shapes.

**No new core schema or sandbox value.** The output schema is registered in the
runtime `registry` under `slack.post@1` / `email.send@1` (one shared shape). The
adapter reuses `controlled-network` (ADR-0007) and `network.egress`. It needs no
signing permission (the credential is a header).

**Dependencies:** none beyond `@qmilab/lodestar-core`,
`@qmilab/lodestar-action-kernel`, and `zod`. The transport is the runtime's
standard `fetch`; we hand-roll a thin bounded JSON-POST wrapper (a *simpler*
sibling of `http`'s `client.ts` — no redirect machinery), keeping full control of
what crosses the trust boundary.

**Same honesty boundary as ADR-0004/0006/0007/0008:** a **TS-level governance
boundary, not network containment.** The POST reaches the real provider by design.

Locked by `messaging-adapter-enforces-egress-invariants` (`packs/lodestar-core/`),
which drives the real tools through the real kernel against in-process `Bun.serve`
provider fakes. `lodestar-core` grows to **41** probes (**45** across both packs).

## Consequences

- The fourth native tool family to light the L4 gate (and, with the egress
  sentinel, the exfil pattern). Proves the egress model generalises a fourth time
  — a fourth transport (a messaging provider API) and the recipient as the pinned
  destination.
- The clearest end-to-end demo of the Policy-Kernel human-approval gate: "the
  agent drafted a message; a human approved it; it went to a pinned recipient" is
  the most legible governance story in the repo.
- Provider-agnostic email via `buildPayload` (default Resend/Postmark-shaped). An
  operator on SendGrid/Mailgun supplies their own payload builder; the governance
  (recipient pinning, fixed from, credential redaction, L4 hold) is provider-
  independent. SMTP is intentionally **not** implemented — it would add a
  dependency and shift focus from the governance demo to protocol plumbing; an
  HTTP email API is how most production agents send mail anyway.
- Completes the ordered P2 sequence. Further adapters (SQL, vector/RAG, `fs.write`,
  payments, cloud/infra) are the demand-pulled backlog from ADR-0005.

## Alternatives considered

- **Implement SMTP for email.** Rejected — a new dependency (or hand-rolled SMTP
  over TLS) for no governance gain; the teeth live above the transport. An HTTP
  email API keeps the adapter zero-dep and is the common production path.
- **One generic `messaging.send` tool.** Rejected — the kernel assigns trust and
  schema per *tool*, and the destination shapes genuinely differ (a Slack channel
  vs an email recipient list with domain rules). Two tools read honestly and mirror
  `nostr.fetch`/`nostr.publish` and `http.fetch`/`http.request`.
- **Capture a non-2xx as a completed result (the `http.fetch` posture).** Rejected
  for a *send*: a failed send must end `failed`, or an agent (and an auditor) could
  read a rejected message as delivered. Read tools capture status as data; send
  tools must not.
- **Let the agent choose the `from` / the provider host.** Rejected — same reason
  as every earlier egress slice: pin destinations, fix the sender, keep credentials
  operator-supplied. An agent-chosen sender is spoofing; an agent-chosen host is an
  SSRF/exfil vector.
- **Include inbound read tools this slice.** Deferred — `http.fetch` already proves
  untrusted inbound; folding it in here would dilute the human-approval focus.
