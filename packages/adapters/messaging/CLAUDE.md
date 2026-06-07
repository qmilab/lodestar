# @qmilab/lodestar-adapter-messaging — CLAUDE.md

Governed messaging egress tools for the Action Kernel — P2 slice 5 (ADR-0009),
the last ordered pick in the native-adapter sequence (shell → git → nostr → http →
**messaging**). The fourth native egress family after `git.push`, `nostr.publish`,
and `http.request`. Where `http` hit all three governance surfaces at once,
messaging is the **purest** instance of one: an outward, irreversible send a human
must approve — the cleanest demonstration of the Policy-Kernel human-approval gate.

- **`slack.post`** — L4 egress. Post `{channel, text}` to an operator-pinned Slack
  channel via the Slack Web API. Held until approved.
- **`email.send`** — L4 egress. Send to operator-pinned recipients via an HTTP
  email API (provider-agnostic payload). Held until approved.

## What lives here

- `src/destinations.ts` — the **exfil guard**: a Slack channel allowlist
  (`compileChannelPolicy` / `assertAllowedChannel`, format-insensitive, sends the
  operator's canonical form) and an email recipient allowlist
  (`compileRecipientPolicy` / `assertAllowedRecipients`, exact addresses + whole
  domains). The messaging analogue of host/relay/remote pinning — but the pinned
  thing is *who receives the message*, since the agent never names the host.
- `src/credentials.ts` — the `MessagingCredential` model (a single operator-supplied
  auth header) + `resolveCredential` (resolves a `() => Promise<string>` at request
  time) + `applyRedactions` / `redactionVariants` (raw + URL-encoded). Simpler than
  the HTTP adapter's host-bound model — the endpoint is operator-fixed, so there is
  no cross-host confused-deputy surface.
- `src/transport.ts` — the bounded JSON-POST wrapper (`postJson`): a wall-clock
  timeout (AbortController, covering the async resolver via `raceAbort`), a streamed
  response-body byte cap, secret redaction, and **a refusal to follow any
  redirect**. The HTTP adapter's `client.ts` sibling, minus the redirect machinery
  (a messaging API does not legitimately redirect a send).
- `src/tools.ts` — the `slack.post@1` / `email.send@1` output schema, the two
  `Tool`s, the `make*Tool` builders, the operator endpoint compile + scheme check,
  the default Resend/Postmark-style email payload (operator-overridable
  `buildPayload`), and the `defineMessagingTools` / `registerMessagingTools` config
  factory.
- `src/messaging.test.ts` — mechanism-level Bun tests against in-process
  `Bun.serve` provider fakes.

The headline invariants are locked by the harness probe
`packs/lodestar-core/probes/messaging-adapter-enforces-egress-invariants.ts`,
which drives the real tools through the real kernel.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not network containment** (same framing as
ADR-0004/0006/0007/0008). It enforces, in-process:

1. **Destination pinning (the exfil guard).** The agent may send only to
   operator-pinned channels / recipients. A non-pinned channel or an off-allowlist
   recipient throws; one bad recipient fails the whole send.
2. **Operator-fixed endpoint + sender.** The provider host is operator config — the
   agent never names it, so there is *no agent-driven SSRF surface at all* (this is
   why this adapter, unlike `http`, needs no per-hop redirect re-validation). The
   email `from` is operator-fixed (anti-spoofing). HTTPS-only unless `allowHttp`.
3. **Credentials are operator-supplied and never reach the agent.** No silent
   default, resolved per request, never in the agent's inputs, redacted from all
   captured output (raw + URL-encoded).
4. **No redirect following.** A 3xx from the provider is a hard failure — following
   it would be the SSRF/exfil escape. The destination stays the pinned endpoint.
5. **Delivery semantics.** A non-2xx — and a Slack `{ok:false}` at HTTP 200 — is a
   delivery FAILURE that ends the action `failed`. A *send* tool must not paper over
   a rejected send as delivered (this is the deliberate difference from
   `http.fetch`, where a 4xx is meaningful captured read data).
6. **Bounded capture, redaction before the cap.** A wall-clock timeout and a
   response-body byte cap stop a hostile/misbehaving provider from hanging the call
   or inflating an observation. The cap is applied AFTER redaction (reading a small
   overlap beyond it) so a credential the provider echoes straddling the byte
   boundary cannot leave an unredacted prefix in the captured body.

**What it does NOT claim:** it does not OS-sandbox the network, and it does not
implement SMTP — email goes via an HTTP email API (the common production path, and
zero-dep). The POST reaches the real provider *by design*; the destination control
is the recipient/channel pin + the operator-fixed endpoint. Keep this honest in
docs and tool descriptions.

## Trust contracts

| Tool | Trust | blast_radius | reversibility | sandbox | permissions |
|------|-------|--------------|---------------|---------|-------------|
| `slack.post` | **L4** | `external` | `irreversible` | `controlled-network` | `network.egress` |
| `email.send` | **L4** | `external` | `irreversible` | `controlled-network` | `network.egress` |

`blast_radius` is set by the proposer's `ActionContract`, not the `Tool`; both
tools declare a `publication` effect (like `git.push` / `nostr.publish` /
`http.request`) so a host building the contract knows to mark them `external`. Both
@ L4 are the headline: they park at `pending_approval` until a human resolves them.
Do **not** lower the floor to make a demo pass. Neither tool spawns a subprocess,
so the honest sandbox is `controlled-network` (ADR-0007).

## Scope

**Egress only this slice.** Inbound reading (`slack.read` / `email.fetch` as L1
untrusted content) is a deferred follow-up — `http.fetch` already proves the
untrusted-inbound surface, and bounding this slice to the send keeps it the clean
human-approval demonstration ADR-0005 asked for.

## When you extend this

- Keep destinations pinned, the endpoint + sender operator-fixed, and credentials
  operator-supplied. An agent-chosen recipient is an exfil channel; an agent-chosen
  sender is spoofing; an agent-chosen host is an SSRF vector.
- Keep send delivery semantics strict: a non-2xx / `ok:false` must fail the action.
- For a new email provider, pass `buildPayload` rather than special-casing here —
  the governance is provider-independent.
- Declare real `effects` / `reversibility` / `required_trust_level` / `sandbox`.
  No silent defaults for security-relevant settings; HTTPS-only unless `allowHttp`.
- The `messaging-adapter-enforces-egress-invariants` probe is spec. If a change
  makes it pass without exercising the L4 hold, channel/recipient pinning, the
  operator-fixed sender, credential redaction, delivery semantics, or bounded
  capture, that's a probe bug, not an improvement.
