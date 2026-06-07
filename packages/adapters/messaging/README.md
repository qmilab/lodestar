# @qmilab/lodestar-adapter-messaging

Governed messaging egress tools for the Lodestar Action Kernel — part of
**Lodestar**, the trust layer for AI agents.

Two tools, both **L4 egress** — the cleanest demonstration of the human-approval
gate:

| Tool | Trust | Direction | What it does |
|------|-------|-----------|--------------|
| `slack.post` | **L4** | egress | Post text to an operator-pinned Slack channel. Held until a human approves. |
| `email.send` | **L4** | egress | Send an email to operator-pinned recipients via an HTTP email API. Held until a human approves. |

`slack.post` / `email.send` are the fourth native egress family in Lodestar after
`git.push`, `nostr.publish`, and `http.request`. Where `http` hit all three
governance surfaces at once, messaging is the *purest* instance of one: an
outward, irreversible send a human must approve. You cannot un-send a message.

## Install

```sh
bun add @qmilab/lodestar-adapter-messaging
```

## Use

```ts
import { registerMessagingTools } from "@qmilab/lodestar-adapter-messaging"

registerMessagingTools({
  slack: {
    // Operator bot token. A function is resolved at request time so a host can
    // fetch it from a secret store. Never the agent's; redacted from output.
    credential: { header: "Authorization", value: () => secrets.get("SLACK_BOT_TOKEN") },
    // The exfil guard: the agent may post only to these channels.
    allowedChannels: ["#alerts", "#deploys"],
    // apiBaseUrl defaults to https://slack.com (override for an enterprise grid /
    // forward proxy / testing).
  },
  email: {
    credential: { header: "Authorization", value: () => secrets.get("EMAIL_API_KEY") },
    // No default — you must say where mail goes (Resend/Postmark/SendGrid/…).
    endpoint: "https://api.resend.com/emails",
    // Operator-fixed sender. The agent cannot choose the From (anti-spoofing).
    from: "agent@ops.example.com",
    // The exfil guard: exact addresses and/or whole domains.
    allowedRecipients: ["oncall@company.com", "@company.com"],
    // Optional: a provider-specific payload builder. Default is a
    // Resend/Postmark-style { from, to, subject, text, html } JSON body.
    // buildPayload: (msg) => ({ personalizations: [{ to: msg.to }], from: { email: msg.from }, ... }),
  },
})
```

The tools register into the Action Kernel's tool registry. Drive them through the
kernel (`propose → arbitrate → execute`) like any governed tool; a host (Guard,
the MCP proxy, an example) supplies the policy gate and `KernelContext`. Both tools
are L4, so they park at `pending_approval` until a human resolves the hold.

### The agent's inputs

```ts
// slack.post — channel MUST be operator-allowlisted
{ channel: "#alerts", text: "deploy 1.4.2 is live" }

// email.send — every recipient MUST be operator-allowlisted (address or domain);
// the agent does NOT supply `from`.
{ to: "oncall@company.com", subject: "Deploy succeeded", body: "1.4.2 is live", html?: "<p>…</p>" }
```

A non-pinned channel or an off-allowlist recipient fails the action. The agent
never supplies the provider host, the sender, or the credential. A failed send
(non-2xx, or a Slack `ok:false`) ends the action `failed` — a rejected send is
never reported as delivered.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not network containment** (the same honesty as
the shell / git / Nostr / HTTP adapters, ADR-0004/0006/0007/0008). It enforces,
in-process:

1. **Destination pinning (the exfil guard).** The agent may send only to
   operator-pinned channels / recipients. A channel is matched
   format-insensitively and sent as the operator's canonical form; a recipient must
   match an exact address or an allowed domain, and one bad recipient fails the
   whole send.
2. **Operator-fixed endpoint + sender.** The provider host is operator config (no
   agent-driven SSRF); the email `from` is operator-fixed (no spoofing). HTTPS-only
   unless `allowHttp`.
3. **Scoped credentials.** Operator-supplied (no silent default), resolved at
   request time, never in the agent's inputs, and redacted from all captured
   output.
4. **No redirect following.** A messaging API does not legitimately redirect a
   send; a 3xx is a hard failure (following it would be the SSRF/exfil escape).
5. **Delivery semantics.** A non-2xx — and a Slack `{ok:false}` at HTTP 200 — is a
   delivery failure that ends the action `failed`, not a silent success.
6. **Bounded capture.** A wall-clock timeout and a response-body byte cap stop a
   hostile or misbehaving provider from hanging the call or inflating an
   observation.

**What it does NOT claim:** it does not OS-sandbox the network, and it does not
implement SMTP (email goes via an HTTP email API). The POST reaches the real
provider by design — that is the governed action. The governance is destination
pinning + an operator-fixed endpoint/sender + scoped credentials + the **L4
human-approval gate**.

Inbound reading (`slack.read` / `email.fetch`) is a deferred follow-up — this
slice is egress-only, the clean human-approval demo.

## License

Apache-2.0
