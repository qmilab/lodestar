import {
  type Effect,
  type Permission,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import { type TrustLevel, registry } from "@qmilab/lodestar-core"
import { z } from "zod"
import type { PaymentCredential } from "./credentials.js"
import {
  type MoneyPolicy,
  type PayeePolicy,
  assertAllowedCurrency,
  assertAllowedPayee,
  assertWithinCeiling,
  compileMoneyPolicy,
  compilePayeePolicy,
  isAllowedCurrency,
} from "./destinations.js"
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUT_MS,
  type SendResult,
  postJson,
} from "./transport.js"

/**
 * Native payment *egress* tool — `payment.send`. Epic #74 child #80 (ADR-0040).
 *
 * The strongest human-approval case in Lodestar: an outward, **irreversible**
 * money movement a human must approve. The contrast to the vector/RAG adapter
 * (untrusted inbound retrieval) — payments is the opposite end: pure egress,
 * irreversible, maximum approval friction. You cannot un-send a payment.
 *
 * The teeth (the egress template, ADR-0006/0007/0008/0009, plus two new ones):
 *
 *   - **L4 hold.** A charge is proposed at `blast_radius: external` and parks at
 *     `pending_approval` until a human approves; the provider is untouched while it
 *     waits. The operator can pin the tool to **L5** as a hard kill-switch ("this
 *     context can never make payments") — the gate denies it outright and a valid
 *     approval is mechanically inert.
 *   - **Operator-pinned payee (the exfil/redirection guard).** A payee the operator
 *     did not pin fails the action. The agent cannot pay an arbitrary recipient.
 *   - **Operator amount ceiling + currency allowlist (NEW).** The agent cannot
 *     exceed the operator's per-currency ceiling, nor charge an off-allowlist
 *     currency. Both are rejected at *propose* (the input schema) so a doomed /
 *     over-ceiling payment never even reaches the approval queue, and re-asserted in
 *     `execute` (the last line before the irreversible charge).
 *   - **Idempotency key (NEW).** A caller-stable key is forwarded to the provider so
 *     a retry/replay (e.g. across a sidecar restart) cannot double-charge.
 *   - **Operator-fixed endpoint + scoped credential.** The agent never supplies the
 *     provider host (no agent-driven SSRF) nor the credential (operator-supplied
 *     resolver seam, redacted from captured output). Lodestar ships NO concrete
 *     Stripe/Adyen client or key — the operator injects a `PaymentProvider`.
 *   - **Strict delivery semantics.** An unconfirmed charge (a decline, a non-2xx, a
 *     `pending` settlement, an unparseable confirmation) ends the action `failed` —
 *     never a silent "charged".
 *   - **Bounded capture, no redirect.** A wall-clock timeout, a response-body byte
 *     cap, and a refusal to follow any provider redirect (`transport.ts`).
 */

// -----------------------------------------------------------------------------
// Output schema — registered as payment.send@1.
// -----------------------------------------------------------------------------

export const PaymentSendOutputSchema = z
  .object({
    provider: z.string().describe("provider label, e.g. 'http' — NEVER a credential"),
    payee: z.string().describe("the operator-canonical payee the charge was sent to"),
    amount_minor: z.number().int().nonnegative().describe("amount charged, in minor units"),
    currency: z.string().describe("the normalized (lowercase) currency code"),
    charged: z.boolean().describe("the provider confirmed the charge succeeded"),
    status: z
      .enum(["succeeded", "failed", "pending"])
      .describe(
        "normalized charge status (a returned output is always 'succeeded'; the rest fail the action)",
      ),
    provider_status: z.number().int().describe("provider HTTP status (0 for a non-HTTP provider)"),
    payment_id: z.string().nullable().describe("provider-assigned charge id, if returned"),
    idempotency_key: z.string().describe("the key forwarded to the provider (NOT a secret)"),
    idempotent_replay: z.boolean().describe("true if the provider reported this as a duplicate"),
    response_excerpt: z
      .string()
      .describe("bounded, redacted provider response body — UNTRUSTED confirmation content"),
    response_truncated: z.boolean().describe("true if the provider response exceeded the cap"),
    authenticated: z
      .boolean()
      .describe("whether an operator credential header was injected on the request"),
    summary: z.string(),
  })
  .describe("payment tool output: the result of a governed, human-approved charge")

export type PaymentSendOutput = z.infer<typeof PaymentSendOutputSchema>

if (!registry.has("payment.send@1")) registry.register("payment.send@1", PaymentSendOutputSchema)

const JSON_CONTENT_TYPE = "application/json"
const DEFAULT_IDEMPOTENCY_HEADER = "Idempotency-Key"

/** The egress effects every charge declares. The `external_call` effect is the
 * standing signal a host uses to mark the `ActionContract` `blast_radius: external`,
 * exactly as the other egress adapters do; `world_state_change` records that the
 * charge moves real-world money state irreversibly. */
const SEND_EFFECTS: Effect[] = [
  { kind: "external_call", description: "send a charge to an external payment provider" },
  { kind: "world_state_change", description: "move money irreversibly to a payee" },
]

// -----------------------------------------------------------------------------
// Provider seam — the operator injects a real client (or a fake). Lodestar ships
// only the governance shell and a generic HTTP-backed default; no Stripe/Adyen SDK.
// -----------------------------------------------------------------------------

export interface ChargeRequest {
  /** Operator-canonical payee (already validated). */
  payee: string
  /** Amount in integer minor units (already validated ≤ ceiling). */
  amount_minor: number
  /** Normalized (lowercase) currency (already validated against the allowlist). */
  currency: string
  /** Caller-stable idempotency key — forward this to the provider. */
  idempotency_key: string
  /** Optional human-facing description. */
  memo?: string
}

export interface ChargeResult {
  /** The provider definitively confirmed the charge. Anything else fails the action. */
  succeeded: boolean
  status: "succeeded" | "failed" | "pending"
  payment_id: string | null
  /** The provider reported this as a duplicate of a prior charge with the same key. */
  idempotent_replay: boolean
  /** Provider HTTP status, or 0 for a non-HTTP provider. */
  provider_status: number
  /** Redacted, bounded provider response body. UNTRUSTED. */
  response_excerpt: string
  response_truncated: boolean
  /** Whether an operator credential header was injected on the request. */
  authenticated: boolean
  /** Redacted reason for a non-success, surfaced into the failed-action audit. */
  decline_reason?: string
}

export interface PaymentProvider {
  /** A non-secret label for the output, e.g. "http". NEVER a credential. */
  readonly label: string
  charge(req: ChargeRequest): Promise<ChargeResult>
}

/** Best-effort JSON parse of a (redacted) provider response — never throws. */
function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Default interpretation of a generic HTTP charge response. An operator on a
 * provider with a different success/replay signal passes their own `interpret`. */
function defaultInterpret(r: SendResult): {
  succeeded: boolean
  status: "succeeded" | "failed" | "pending"
  payment_id: string | null
  idempotent_replay: boolean
  decline_reason?: string
} {
  const parsed = parseJsonSafe(r.body)
  const payment_id = typeof parsed?.id === "string" ? parsed.id : null
  const idempotent_replay = parsed?.idempotent_replay === true
  if (r.ok) {
    return { succeeded: true, status: "succeeded", payment_id, idempotent_replay }
  }
  // The body is already redacted by the transport, so `error` cannot carry a secret.
  const decline_reason =
    typeof parsed?.error === "string" ? parsed.error : `provider returned status ${r.status}`
  return {
    succeeded: false,
    status: "failed",
    payment_id,
    idempotent_replay: false,
    decline_reason,
  }
}

export interface HttpPaymentProviderOptions {
  /** The HTTP charge endpoint (operator-supplied; e.g. https://api.stripe.com/v1/charges).
   * No default — no silent default for where money goes. */
  endpoint: string
  /** Operator API-key credential, e.g. { header: "Authorization", value: "Bearer sk_live_…" }. */
  credential: PaymentCredential
  /** Build the provider request body from the charge. Default: a generic JSON shape. */
  buildPayload?: (req: ChargeRequest) => unknown
  /** Header to carry the idempotency key. Default "Idempotency-Key". */
  idempotencyHeader?: string
  /** Map a captured HTTP response to a charge result. Default: 2xx = succeeded. */
  interpret?: (r: SendResult) => {
    succeeded: boolean
    status: "succeeded" | "failed" | "pending"
    payment_id: string | null
    idempotent_replay: boolean
    decline_reason?: string
  }
  /** Allow a plain http:// endpoint. Default false (HTTPS only). */
  allowHttp?: boolean
  /** Response-body byte cap. Default 64 KiB. */
  maxBytes?: number
  /** Wall-clock timeout. Default 15s. */
  timeoutMs?: number
}

/** A generic HTTP-backed `PaymentProvider` over the bounded transport. The shipped
 * default — NOT specific to any PSP. Operator-fixed endpoint + scoped credential +
 * the idempotency key forwarded as a header. */
export function createHttpPaymentProvider(opts: HttpPaymentProviderOptions): PaymentProvider {
  const endpoint = compileEndpoint(opts.endpoint, opts.allowHttp ?? false, "payment.send")
  const credential = opts.credential
  const buildPayload = opts.buildPayload ?? defaultPayload
  const idempotencyHeader = opts.idempotencyHeader ?? DEFAULT_IDEMPOTENCY_HEADER
  const interpret = opts.interpret ?? defaultInterpret
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    label: "http",
    charge: async (req) => {
      const result = await postJson({
        url: endpoint,
        body: JSON.stringify(buildPayload(req)),
        credential,
        extraHeaders: [
          { name: "Content-Type", value: JSON_CONTENT_TYPE },
          // Forward the idempotency key so a replay cannot double-charge. Not a secret.
          { name: idempotencyHeader, value: req.idempotency_key },
        ],
        timeoutMs,
        maxBytes,
        tool: "payment.send",
      })
      const interp = interpret(result)
      return {
        succeeded: interp.succeeded,
        status: interp.status,
        payment_id: interp.payment_id,
        idempotent_replay: interp.idempotent_replay,
        provider_status: result.status,
        response_excerpt: result.body,
        response_truncated: result.body_truncated,
        authenticated: result.authenticated,
        ...(interp.decline_reason !== undefined ? { decline_reason: interp.decline_reason } : {}),
      }
    },
  }
}

/** Default request body: a generic charge shape. An operator on a provider with a
 * different schema passes their own `buildPayload`. */
function defaultPayload(req: ChargeRequest): unknown {
  return {
    payee: req.payee,
    amount: req.amount_minor,
    currency: req.currency,
    idempotency_key: req.idempotency_key,
    ...(req.memo !== undefined ? { memo: req.memo } : {}),
  }
}

/** Parse and validate the operator's provider endpoint at compile time. HTTPS only
 * unless `allowHttp` — no silent insecure default. */
function compileEndpoint(raw: string, allowHttp: boolean, tool: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${tool}: provider endpoint '${raw}' is not a valid absolute URL`)
  }
  const allowed = allowHttp ? ["https:", "http:"] : ["https:"]
  if (!allowed.includes(url.protocol)) {
    throw new Error(
      `${tool}: provider endpoint scheme '${url.protocol}' is not allowed (allowed: ${allowed.join(", ")})`,
    )
  }
  return url
}

// -----------------------------------------------------------------------------
// payment.send — egress, L4 (operator can pin L5 to disable)
// -----------------------------------------------------------------------------

/** The base input shape. The factory layers a `.superRefine` that closes over the
 * operator's payee/currency/ceiling config so an off-allowlist / over-ceiling
 * request throws in `propose()` before any hold is created. */
const PaymentSendBaseSchema = z.object({
  payee: z.string().min(1).describe("payee handle/id; MUST be operator-allowlisted"),
  amount_minor: z
    .number()
    .int()
    .positive()
    .describe("amount in integer minor units (e.g. cents); no floats, no negatives"),
  currency: z
    .string()
    .min(1)
    .describe("ISO-4217 currency, operator-allowlisted (supply lowercase)"),
  idempotency_key: z
    .string()
    .min(8)
    .max(255)
    .describe("caller-stable key; forwarded to the provider so a replay cannot double-charge"),
  memo: z.string().max(512).optional().describe("optional human-facing description"),
})

export type PaymentSendInput = z.infer<typeof PaymentSendBaseSchema>

export interface PaymentSendToolOptions {
  /** The seam: inject the shipped HTTP default (`createHttpPaymentProvider`), a real
   * PSP SDK wrapper, or a fake. Lodestar ships no concrete provider/key. */
  provider: PaymentProvider
  /** Operator-pinned payees — the exfil/redirection guard. The agent may pay only these. */
  allowedPayees: string[]
  /** Operator-allowed currencies (ISO-4217; supply lowercase). */
  allowedCurrencies: string[]
  /** The operator amount ceiling in minor units: a single cap for all currencies, or
   * a per-currency `{ usd: 50000, eur: 45000 }` map. Every allowed currency must be capped. */
  ceiling: number | Record<string, number>
  /** Trust floor. Default L4 — egress, held until approved. Set 5 to disable (kill-switch). */
  trust?: TrustLevel
}

function toOutput(
  providerLabel: string,
  payee: string,
  currency: string,
  input: PaymentSendInput,
  result: ChargeResult,
): PaymentSendOutput {
  return {
    provider: providerLabel,
    payee,
    amount_minor: input.amount_minor,
    currency,
    charged: true,
    status: "succeeded",
    provider_status: result.provider_status,
    payment_id: result.payment_id,
    idempotency_key: input.idempotency_key,
    idempotent_replay: result.idempotent_replay,
    response_excerpt: result.response_excerpt,
    response_truncated: result.response_truncated,
    authenticated: result.authenticated,
    summary:
      `payment.send: charged ${input.amount_minor} ${currency} to ${payee}` +
      `${result.idempotent_replay ? " (idempotent replay)" : ""}` +
      `${result.payment_id ? `, id ${result.payment_id}` : ""}`,
  }
}

export function makePaymentSendTool(
  opts: PaymentSendToolOptions,
): Tool<PaymentSendInput, PaymentSendOutput> {
  const payeePolicy: PayeePolicy = compilePayeePolicy(opts.allowedPayees)
  const money: MoneyPolicy = compileMoneyPolicy(opts.allowedCurrencies, opts.ceiling)
  const provider = opts.provider
  // The input schema closes over the operator's MONEY config: an off-allowlist
  // currency or an over-ceiling amount adds an issue → `propose()` throws → NO hold
  // is created, so a doomed/over-ceiling payment is never even presentable to a human.
  // The refinements are PURE (no transform/preprocess) so re-parse is idempotent.
  //
  // The PAYEE allowlist is deliberately NOT checked here — it is enforced
  // authoritatively in `execute` (`assertAllowedPayee`), exactly like the messaging
  // adapter's exfil guard, so an agent's attempt to pay a non-pinned payee becomes a
  // recorded `failed` security event in the audit rather than a silent propose-time
  // ZodError. (ADR-0040.)
  const inputs = PaymentSendBaseSchema.superRefine((v, ctx) => {
    if (!isAllowedCurrency(v.currency, money)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: `currency '${v.currency}' is not operator-allowed`,
      })
      // An unknown currency has no ceiling to check against — stop here.
      return
    }
    const cap = money.ceilingFor(v.currency)
    if (cap !== undefined && v.amount_minor > cap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount_minor"],
        message: `amount ${v.amount_minor} exceeds the operator ceiling ${cap} for ${v.currency}`,
      })
    }
  })
  return {
    name: "payment.send",
    inputs,
    output_schema_key: "payment.send@1",
    effects: SEND_EFFECTS,
    reversibility: "irreversible",
    permissions: ["network.egress"] as Permission[],
    required_trust_level: opts.trust ?? 4,
    sandbox: "controlled-network",
    preconditions: () => [],
    execute: async (input) => {
      // The PAYEE allowlist is enforced here (the authoritative exfil guard, like
      // messaging): a non-pinned payee throws → the action ends `failed`, an audited
      // security event, and the canonical operator payee is what we actually charge.
      // The currency + ceiling are re-asserted as defense in depth — the input schema
      // already rejected them at propose (no hold), but `execute` is the last line
      // before the irreversible charge.
      const payee = assertAllowedPayee(input.payee, payeePolicy, "payment.send")
      const currency = assertAllowedCurrency(input.currency, money, "payment.send")
      assertWithinCeiling(input.amount_minor, currency, money, "payment.send")
      const result = await provider.charge({
        payee,
        amount_minor: input.amount_minor,
        currency,
        idempotency_key: input.idempotency_key,
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
      })
      // Strict delivery semantics: only a definitively-succeeded charge returns. A
      // decline / non-2xx / pending settlement / unparseable confirmation throws, so
      // the action ends `failed` — a send tool must never report an unconfirmed
      // charge as charged.
      if (!result.succeeded || result.status !== "succeeded") {
        throw new Error(
          `payment.send: charge not confirmed (status ${result.provider_status}` +
            `${result.decline_reason ? `, ${result.decline_reason}` : ""})`,
        )
      }
      return toOutput(provider.label, payee, currency, input, result)
    },
  }
}

// -----------------------------------------------------------------------------
// Config-driven factory (mirrors defineMessagingTools / defineHttpTools)
// -----------------------------------------------------------------------------

export interface PaymentToolsConfig extends PaymentSendToolOptions {}

/** Build the payment tool(s) from config. */
export function definePaymentTools(config: PaymentToolsConfig): Tool[] {
  return [makePaymentSendTool(config) as Tool]
}

/** Build and register the payment tool(s). Returns them. */
export function registerPaymentTools(config: PaymentToolsConfig): Tool[] {
  const tools = definePaymentTools(config)
  for (const tool of tools) registerTool(tool)
  return tools
}
