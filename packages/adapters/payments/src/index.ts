/**
 * @qmilab/lodestar-adapter-payments — governed payment-send tool for the Lodestar
 * Action Kernel. Epic #74 child #80 (ADR-0040).
 *
 * - `payment.send` (L4) — charge an operator-pinned payee up to an operator amount
 *   ceiling, in an allowlisted currency, with a forwarded idempotency key; held
 *   until a human approves. The operator can pin it to L5 to disable payments
 *   entirely in a context (kill-switch).
 *
 * The strongest human-approval case — an outward, irreversible money movement.
 * Governance: operator-pinned payee (the exfil/redirection guard), an operator
 * amount ceiling + currency allowlist (rejected at propose AND re-asserted in
 * execute), a forwarded idempotency key (no double-charge on replay), an
 * operator-fixed endpoint + scoped credential (resolver seam, redacted), strict
 * delivery semantics (an unconfirmed charge fails), bounded capture, no redirect
 * following. Lodestar ships NO concrete PSP client or key — the operator injects a
 * `PaymentProvider`. A TS-level governance boundary, not payment-network containment.
 */
export {
  makePaymentSendTool,
  definePaymentTools,
  registerPaymentTools,
  createHttpPaymentProvider,
  PaymentSendOutputSchema,
  type PaymentSendOutput,
  type PaymentSendInput,
  type PaymentSendToolOptions,
  type PaymentToolsConfig,
  type PaymentProvider,
  type ChargeRequest,
  type ChargeResult,
  type HttpPaymentProviderOptions,
} from "./tools.js"
export {
  type PaymentCredential,
  type SecretValue,
  type ResolvedHeader,
  type ResolvedCredential,
  resolveCredential,
  applyRedactions,
  redactionVariants,
} from "./credentials.js"
export {
  type PayeePolicy,
  type MoneyPolicy,
  compilePayeePolicy,
  compileMoneyPolicy,
  assertAllowedPayee,
  assertAllowedCurrency,
  assertWithinCeiling,
  isAllowedPayee,
  isAllowedCurrency,
  normalizePayee,
  normalizeCurrency,
} from "./destinations.js"
export {
  type SendResult,
  type PostJsonOptions,
  postJson,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "./transport.js"
