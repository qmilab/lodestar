# ADR-0040: Governed Payments adapter

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Nandan, Claude
- **Related:** #80 (Payments), #74 (native-adapter epic), ADR-0005 (demand-pulled
  adapters), ADR-0009 (the messaging adapter — the egress template ported here),
  ADR-0008 (the HTTP transport posture), `packages/adapters/payments/`,
  `packages/action-kernel/` (the two-phase flow), `packages/policy-kernel/`
  (the L5-prohibited gate path)

## Context

The native-adapter epic builds a governed adapter wherever governance is
load-bearing. Every prior egress adapter (`git.push`, `nostr.publish`,
`http.request`, `slack.post`/`email.send`) is an *outward, irreversible* action a
human must approve, and the messaging adapter was deliberately the **purest** such
demo. A payment is that case taken to its limit: **irreversible money movement**,
the strongest reason to hold an action for a human and the cleanest contrast to the
just-shipped vector/RAG adapter (untrusted *inbound* retrieval). #80 is the
egress-only, maximum-approval-friction child of epic #74.

The issue framed it precisely: *"L4/L5, irreversible — operator-pinned payee, amount
ceiling, idempotency key, no agent-chosen recipient. Held until approved."* Three
design questions shaped the adapter:

1. **What is "L4/L5"?** The trust ladder (`packages/core/src/schemas/action.ts`)
   defines **L4** = external/shared, requires approval, and **L5** = prohibited,
   can never run in this context. So "L4/L5" means: `payment.send` defaults to L4
   (held until approved) and an operator can pin it to **L5** as a hard kill-switch.
2. **Where do the new guards sit in the two-phase flow?** Payments adds two
   invariants the egress template never needed — an **amount ceiling** and a
   **currency allowlist** — plus the established payee/destination pin. The kernel
   has exactly three stop points, and they are not equivalent (see Decision).
3. **What does Lodestar ship?** A payment needs a PSP client + key. Lodestar ships
   no provider client anywhere else (the vector adapter embeds no model; the #163
   generic extractor keeps the LLM in the consumer). The governance value is the
   *gate*, not the integration.

## Decision

Ship **`@qmilab/lodestar-adapter-payments`** with one tool, **`payment.send`**
(L4 egress, irreversible), built as a near-verbatim port of the messaging adapter's
five-file split (`credentials.ts` / `transport.ts` ported unchanged but for the
type rename; `destinations.ts` → the payee + money guards; `tools.ts` / `index.ts`).
No `packages/core` change — the input/output schemas are adapter-local and only the
`payment.send@1` output schema registers at runtime, exactly like messaging.

**Provider seam.** The operator injects a `PaymentProvider` (`charge(req) =>
ChargeResult`). Lodestar ships only the governance shell plus a generic
`createHttpPaymentProvider` default over the bounded transport — **no Stripe/Adyen
SDK or key**. The credential is the operator's resolver-seam header
(`PaymentCredential`), redacted from all captured output; the endpoint is
operator-fixed.

**Two-phase guard placement** (the crux, validated against `kernel.ts`):

- The kernel's only genuine fail-fast-at-propose seam is the **input Zod schema**
  (`tool.inputs.parse` throws inside `propose()` before any Action/hold exists).
  **Preconditions do not fire at propose** — they run only in `execute()`, so they
  cannot prevent a hold; we use `preconditions: () => []`.
- **Amount ceiling + currency allowlist → the input schema** (an object-level
  `.superRefine` closing over operator config; currency checked first, then the
  per-currency ceiling). An over-ceiling or off-allowlist request throws at propose,
  so **a doomed/over-ceiling payment is never even presentable to a human** — the
  property the messaging template could not give. Re-asserted in `execute` as
  defense in depth. Refinements stay **pure** (no transform/preprocess) — the kernel
  parses once and forbids re-parse drift.
- **Payee allowlist → `execute` only** (`assertAllowedPayee`, returns the operator
  canonical payee), exactly like messaging's exfil guard. A non-pinned payee throws
  → the action ends **`failed`**, a recorded security event in the audit. This is
  the right home for an exfil guard (auditability over approval-queue-noise
  reduction), and it keeps the execute guard **reachable and probe-tested through
  the kernel** rather than unreachable defensive code. (Money caps are the new,
  high-value fail-fast invariant; the payee follows the established egress
  precedent.)
- **Idempotency key.** A required, well-formed-shape input, forwarded to the
  provider (the HTTP default sends it as an `Idempotency-Key` header) so a
  retry/replay — e.g. across a sidecar restart re-driving a persisted action —
  cannot double-charge. Amounts are **integer minor units** (no floats); an allowed
  currency with no ceiling is refused config (no unbounded-payment hole).
- **L5 kill-switch** (`policy-kernel/src/gate.ts`): at `level >= 5` the gate denies
  *without* `requires_human_approval` → the kernel goes straight to `rejected`,
  never `pending_approval`; `execute()` only runs from `approved`, so a valid
  approval is mechanically inert.
- **Strict delivery semantics** (inherited): an unconfirmed charge — a decline, a
  non-2xx, a `pending` settlement, an unparseable confirmation — throws → `failed`.
  A send tool must never report an unconfirmed charge as charged. No redirect is
  followed (a 3xx is a hard failure); capture is bounded with redaction before the
  byte cap.

Tool contract: `required_trust_level: 4` (operator-overridable to 5),
`effects: [external_call, world_state_change]` (the proposer keys
`blast_radius: external` off `external_call`), `reversibility: "irreversible"`,
`permissions: ["network.egress"]`, `sandbox: "controlled-network"`.

## Consequences

- A Lodestar-wrapped agent cannot move money without a human in the loop, cannot pay
  a non-pinned payee (an audited `failed` event), cannot exceed the operator ceiling
  or use an off-allowlist currency (rejected before the human is even asked), cannot
  double-charge on a replay, and cannot leak the API key. An operator can disable
  payments entirely in a context with the L5 pin.
- One probe, **`payment-adapter-enforces-send-invariants`** (always runs, in-memory
  — an injected fake provider, no DB/network gating), drives the real tool through
  the real kernel across eight cases: the L4 hold + happy path, the propose-time
  ceiling and currency rejections, the execute-time audited payee guard, the
  no-double-charge idempotency replay, credential non-leakage + redaction, decline →
  `failed`, the L5 kill-switch (with a valid grant proven inert), and bounded capture
  with a credential straddling the cap.
- Still a **TS-level governance boundary, not payment-network containment**
  (ADR-0004): the POST reaches the real provider by design; PSP-side controls
  (per-key limits, allowlisted destinations) are the operator's defence in depth.
- The 27th npm package; deps are core + action-kernel + zod (no `adapter-sql` edge,
  unlike vector). No CLI registration (adapters that need host secrets self-register
  from a guarded loop). Probe count 78 → 79 (core 74 → 75).

## Alternatives considered

- **Belt-and-suspenders payee (schema *and* execute).** The first design rejected a
  non-pinned payee at *both* propose (schema) and execute. Rejected: with the payee
  in the schema, `propose()` throws and the execute guard is never reached through
  the normal API — unreachable defensive code a reviewer would flag, and it turns an
  exfil attempt into a silent propose-time `ZodError` instead of an audited `failed`
  action. Execute-only matches the messaging precedent and keeps the guard tested.
- **A `payment.status` read companion this slice.** Deferred. Egress-only keeps this
  the clean human-approval demo (the same call messaging made about `slack.read` /
  `email.fetch`); a status read can land later behind the same package.
- **A concrete PSP integration (Stripe/Adyen client).** Rejected: Lodestar ships no
  provider client or key by policy. The `PaymentProvider` seam + generic-HTTP
  default keeps the package deterministic and probe-testable; a real SDK wrapper
  lives in the consumer.
- **Preconditions for the ceiling/payee guards.** Rejected: preconditions are an
  execute-time TOCTOU defense for *live world state*, and they do not fire at propose
  — they could not give the "over-ceiling never presentable" property. Static
  operator config belongs in the input schema (money caps) and the execute guard
  (payee), not in preconditions.
