# @qmilab/lodestar-adapter-payments — CLAUDE.md

Governed payment egress for the Action Kernel — epic #74 child #80 (ADR-0040). The
strongest human-approval case in Lodestar: an outward, **irreversible** money
movement a human must approve. The egress-only counterpart to the vector/RAG
adapter's untrusted-inbound retrieval — pure egress, irreversible, maximum approval
friction. You cannot un-send a payment.

- **`payment.send`** — L4 egress. Charge an operator-pinned payee up to an operator
  amount ceiling, in an allowlisted currency, with a forwarded idempotency key. Held
  until approved. Operator-pinnable to **L5** to disable payments in a context.

## What lives here

- `src/destinations.ts` — the request guards. The **payee allowlist** (the
  exfil/redirection guard: `compilePayeePolicy` / `assertAllowedPayee` /
  `isAllowedPayee`, format-insensitive, charges the operator's canonical payee) and
  the **money policy** (`compileMoneyPolicy` / `assertAllowedCurrency` /
  `assertWithinCeiling` / `isAllowedCurrency` — the NEW amount-ceiling + currency
  allowlist; an allowed currency with no ceiling is refused config). Pure functions
  so they run both as propose-time input-schema refinements AND execute-time
  authoritative re-checks.
- `src/credentials.ts` — the `PaymentCredential` model (a single operator-supplied
  auth header) + `resolveCredential` (resolver seam) + `applyRedactions` /
  `redactionVariants`. Ported from the messaging adapter's `credentials.ts`, **plus a
  payments hardening**: `redactionVariants` also emits the JSON `\uXXXX`-escaped form
  of the secret, so a credential a hostile provider echoes JSON-escaped (to evade a
  raw-string match) is still scrubbed — even from a *truncated* body that cannot be
  parsed (see transport).
- `src/transport.ts` — the bounded JSON-POST wrapper (`postJson`): a wall-clock
  timeout (covering the async resolver via `raceAbort`), a streamed response-body
  byte cap with redaction applied **before** the cap, and **a refusal to follow any
  redirect**. Ported from messaging's `transport.ts`, **plus a payments hardening**:
  `readCappedBody` canonicalises a fully-parseable JSON body (`JSON.stringify` of the
  parse collapses every `\uXXXX` escape to literal ASCII) and re-redacts it, so an
  escaped credential — full *or* partial — cannot survive into the captured excerpt or
  any field later parsed from it.
- `src/tools.ts` — the `payment.send@1` output schema + registration, the
  `PaymentProvider` seam + `ChargeRequest` / `ChargeResult`, the generic-HTTP
  `createHttpPaymentProvider` default (the idempotency key forwarded as a header),
  the `makePaymentSendTool` factory (which layers the config-closing `.superRefine`
  input schema), the strict `execute`, and the `definePaymentTools` /
  `registerPaymentTools` config factory.
- `src/index.ts` — the barrel.

The headline invariants are locked by the harness probe
`packs/lodestar-core/probes/payment-adapter-enforces-send-invariants.ts`, which
drives the real tool through the real kernel against an in-process fake provider
(and the generic-HTTP provider against a `Bun.serve` fake for the transport cases).

## The two-phase enforcement model (read this before changing a guard)

There are exactly three points where a request can be stopped, and they are NOT
equivalent (validated against `packages/action-kernel/src/kernel.ts`):

1. **The input Zod schema** (`tool.inputs.parse`) throws inside `propose()` **before
   any Action/contract/hold exists** — the only genuine fail-fast-at-propose seam.
2. **Preconditions do NOT fire at propose** — they run only in `execute()` (post
   approval). So a precondition cannot prevent a hold. We use `preconditions: () => []`.
3. **A thrown `execute` body** ends the action `failed`, but only *after* a human
   approved.

So the guards are placed as:

- **amount ceiling / currency allowlist** → the input-schema `.superRefine` (an
  over-ceiling / off-allowlist request throws at propose, no hold — a doomed/oversize
  payment is never even presentable to a human) **and** re-asserted in `execute`
  (defense in depth). The ceiling check is an object-level refinement (it needs amount
  + currency together); the currency check runs first.
- **payee allowlist** → **`execute` only** (`assertAllowedPayee`, returns the
  canonical payee), exactly like the messaging adapter's exfil guard. A non-pinned
  payee throws → the action ends **`failed`**, a recorded security event in the audit
  — rather than a silent propose-time `ZodError`. This is the right home for an exfil
  guard (auditability over approval-queue-noise reduction), and it keeps the execute
  guard **reachable and probe-tested through the kernel** rather than unreachable
  defensive code. (Money caps are the new, high-value fail-fast invariant; the payee
  follows the established egress precedent — ADR-0040.) The probe's "non-allowlisted
  payee" case drives this execute path.
- All refinements stay **pure** (no `.transform` / `.preprocess`) — the kernel parses
  inputs once and forbids re-parse drift; a transforming schema is not idempotent.

**L5 kill-switch** (`packages/policy-kernel/src/gate.ts`): at `level >= 5` the gate
denies *without* `requires_human_approval` → the kernel transitions straight to
`rejected`, never `pending_approval`; `execute()` only runs from `approved`, so a
valid approval is mechanically inert.

## The boundary this claims — and the one it does not

A **TS-level governance boundary, not payment-network containment** (same framing as
ADR-0004/0006/0007/0008/0009). It enforces, in-process: payee pinning, amount/currency
caps, idempotency forwarding, an operator-fixed endpoint + scoped+redacted
credential, no redirect following, strict delivery semantics, bounded capture, and
the L4 human-approval gate. **What it does NOT claim:** no OS/network sandbox, and no
PSP integration — the POST reaches the real provider by design. Lodestar ships no
concrete provider or key; the operator injects a `PaymentProvider`. Keep this honest
in docs and tool descriptions.

## Trust contracts

| Tool | Trust | blast_radius | reversibility | effects | sandbox | permissions |
|------|-------|--------------|---------------|---------|---------|-------------|
| `payment.send` | **L4** (L5 to disable) | `external` | `irreversible` | `external_call`, `world_state_change` | `controlled-network` | `network.egress` |

`blast_radius` is set by the proposer's `ActionContract`, not the `Tool`; the tool
declares an `external_call` effect (like every egress adapter) so a host building the
contract knows to mark it `external`. The tool spawns no subprocess, so the honest
sandbox is `controlled-network` (ADR-0007). Do **not** lower the L4 floor or widen
the payee/currency allowlists or the ceiling to make a demo pass.

## Scope

**One tool, egress-only this slice.** No `payment.status` read companion (a deferred
follow-up) — bounding this slice to the send keeps it the clean human-approval
demonstration. No cognitive-core changes (no untrusted-inbound `external_document`
output), so no extractor/linker.

## When you extend this

- Keep the payee pinned, the endpoint operator-fixed, the credential operator-supplied
  and redacted, and the amount/currency capped. An agent-chosen payee is an exfil
  channel; an agent-chosen host is an SSRF vector; an uncapped amount is unbounded loss.
- Keep the idempotency key forwarded so a replay cannot double-charge.
- Keep delivery semantics **fail-closed**: the generic provider confirms a charge
  ONLY on an explicit recognised success status (never a bare 2xx); a missing /
  unrecognised status, a 202, or a truncated/unparseable body must fail the action. A
  provider that confirms differently is handled by a custom `interpret`, not by
  loosening the default.
- For a new PSP, pass `buildPayload` / `interpret` rather than special-casing here —
  the governance is provider-independent.
- The `payment-adapter-enforces-send-invariants` probe is spec. If a change makes it
  pass without exercising the L4 hold, the L5 kill-switch, payee pinning, the amount
  ceiling, the currency allowlist, idempotency, credential redaction, or delivery
  semantics, that's a probe bug, not an improvement.
