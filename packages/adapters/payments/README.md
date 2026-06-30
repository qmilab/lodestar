# @qmilab/lodestar-adapter-payments

Governed payment-send tool for the Lodestar Action Kernel — part of **Lodestar**,
the trust layer for AI agents.

One tool, **L4 egress** — the strongest demonstration of the human-approval gate:

| Tool | Trust | Direction | What it does |
|------|-------|-----------|--------------|
| `payment.send` | **L4** | egress | Charge an operator-pinned payee, up to an operator amount ceiling, in an allowlisted currency, with a forwarded idempotency key. Held until a human approves. |

`payment.send` is the irreversible-money sibling of `slack.post` / `email.send` /
`git.push` / `nostr.publish` / `http.request`. Where the vector adapter governs
untrusted *inbound* retrieval, payments is the opposite end: pure egress,
irreversible, maximum approval friction. **You cannot un-send a payment.** The
operator can pin the tool to **L5** to disable payments entirely in a context
(a hard kill-switch the gate enforces — a valid approval is inert against it).

## Install

```sh
bun add @qmilab/lodestar-adapter-payments
```

## Use

```ts
import {
  registerPaymentTools,
  createHttpPaymentProvider,
} from "@qmilab/lodestar-adapter-payments"

registerPaymentTools({
  // The seam: inject the shipped generic-HTTP provider, a real PSP SDK wrapper, or
  // a fake. Lodestar ships NO concrete Stripe/Adyen client or key.
  provider: createHttpPaymentProvider({
    // No default — you must say where money goes.
    endpoint: "https://api.your-psp.example/v1/charges",
    // Operator API key. A function is resolved at request time so a host can fetch
    // it from a secret store. Never the agent's; redacted from output.
    credential: { header: "Authorization", value: () => secrets.get("PSP_API_KEY") },
    // Optional: a provider-specific request body. Default is a generic charge shape.
    // buildPayload: (req) => ({ destination: req.payee, amount: req.amount_minor, ... }),
  }),
  // The exfil/redirection guard: the agent may pay only these.
  allowedPayees: ["acct_ops_vendor", "acct_payroll"],
  // Operator-allowed currencies (ISO-4217; supply lowercase).
  allowedCurrencies: ["usd", "eur"],
  // The amount ceiling in MINOR units (cents): a single cap for all currencies, or a
  // per-currency map. Every allowed currency must be capped.
  ceiling: { usd: 50000, eur: 45000 },
})
```

The tool registers into the Action Kernel's tool registry. Drive it through the
kernel (`propose → arbitrate → resolve → execute`) like any governed tool; a host
(Guard, the MCP proxy, an example) supplies the policy gate and `KernelContext`.
At L4 it parks at `pending_approval` until a human resolves the hold.

### The agent's inputs

```ts
// payment.send — payee MUST be operator-allowlisted; amount in integer minor units
// (cents), at or below the operator ceiling; currency operator-allowlisted; a stable
// idempotency_key the provider uses to dedupe a replay.
{ payee: "acct_ops_vendor", amount_minor: 12500, currency: "usd",
  idempotency_key: "inv-2026-0042", memo: "Invoice 0042" }
```

An off-allowlist payee, an over-ceiling amount, or an off-allowlist currency fails:
the amount/currency are rejected at *propose* (so an over-ceiling payment is never
even presentable to a human), and the payee is enforced authoritatively in *execute*
(so an off-allowlist payee is a recorded `failed` security event, like the messaging
exfil guard). The agent never supplies the provider host or the credential. An
unconfirmed charge (a decline, a non-2xx, a `pending` settlement) ends the action
`failed` — never a silent "charged".

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not payment-network containment** (the same
honesty as the shell / git / Nostr / HTTP / messaging adapters,
ADR-0004/0006/0007/0008/0009). It enforces, in-process:

1. **Operator-pinned payee (the exfil/redirection guard).** The agent may pay only
   operator-pinned payees, matched format-insensitively and charged as the operator's
   canonical form.
2. **Operator amount ceiling + currency allowlist.** The agent cannot exceed the
   per-currency ceiling or charge an off-allowlist currency. Amounts are integer
   minor units — never floats. An allowed currency with no ceiling is refused config.
3. **Idempotency key.** Forwarded to the provider so a retry/replay (e.g. across a
   sidecar restart) cannot double-charge.
4. **Operator-fixed endpoint + scoped credential.** The agent never names the
   provider host (no agent-driven SSRF) nor sees the credential (operator-supplied,
   resolved at request time, redacted from all captured output). HTTPS-only unless
   `allowHttp`.
5. **No redirect following.** A 3xx from the provider is a hard failure.
6. **Strict delivery semantics.** An unconfirmed charge ends the action `failed`.
7. **Bounded capture.** A wall-clock timeout and a response-body byte cap stop a
   hostile or misbehaving provider from hanging the call or inflating an observation.
8. **L4 human-approval gate (the headline), with an L5 kill-switch.** Held until a
   human approves; pinnable to L5 to disable payments entirely.

**What it does NOT claim:** it does not OS-sandbox the network, and it ships no PSP
integration — the POST reaches the real provider by design (that is the governed
action). Lodestar ships no concrete provider or key; the operator injects a
`PaymentProvider`. The governance is the payee pin + amount/currency caps +
idempotency + operator-fixed endpoint/credential + the **L4 human-approval gate**.

## License

Apache-2.0
