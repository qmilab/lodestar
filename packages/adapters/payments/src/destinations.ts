/**
 * Request guards — the payments-specific governance chokepoints. Two families:
 *
 *   1. **Payee allowlist** (the exfil/redirection guard) — the payments analogue of
 *      the messaging recipient allowlist, the HTTP host pin, the git remote pin, the
 *      Nostr relay pin. The provider endpoint is operator-fixed (the agent never
 *      names the host — see `tools.ts`), so the only destination the agent controls
 *      is *who gets paid*. That is the thing the operator pins here. Matching is
 *      format-insensitive (trim + case), and a matched charge is sent to the
 *      operator's *canonical* payee string — the agent cannot smuggle a different
 *      payee past the pin via a format trick.
 *   2. **Money policy** (the amount/currency guard) — NEW invariants this adapter
 *      introduces over the egress template: an operator-fixed **amount ceiling** the
 *      agent cannot exceed, and a **currency allowlist**. Amounts are integer minor
 *      units (e.g. cents) — never floats. Every operator-allowed currency MUST carry
 *      a ceiling; an allowed currency with no cap would be an unbounded-payment hole,
 *      so `compileMoneyPolicy` refuses that config at build time.
 *
 * These guards are pure (no I/O, no throw on a happy path beyond config validation)
 * so they can run both as input-schema refinements at propose time (fail fast,
 * before a hold is ever created) AND as authoritative re-checks in `execute` (the
 * last line before the irreversible charge). See `tools.ts` and ADR-0040.
 *
 * Same honesty boundary as ADR-0004/0006/0007/0008/0009: a TS-level governance
 * boundary, not payment-network containment.
 */

// -----------------------------------------------------------------------------
// Payee allowlist (the exfil/redirection guard)
// -----------------------------------------------------------------------------

export interface PayeePolicy {
  /** normalized-payee → operator's canonical payee string (what we actually pay). */
  byNormalized: Map<string, string>
}

/** Normalize a payee handle for matching: trim, collapse internal whitespace runs,
 * lowercase. The operator's *canonical* form is always what gets charged, so
 * normalization only widens *matching* (an agent naming `ACME-Vendor ` still maps to
 * the operator's pin) — it never changes the destination, which stays a pinned
 * canonical payee. */
export function normalizePayee(entry: string): string {
  return entry.trim().replace(/\s+/g, " ").toLowerCase()
}

export function compilePayeePolicy(payees: string[]): PayeePolicy {
  const byNormalized = new Map<string, string>()
  for (const raw of payees) {
    const canonical = raw.trim()
    if (canonical.length === 0) continue
    const key = normalizePayee(canonical)
    if (key.length === 0) continue
    // First pin for a normalized key wins; a duplicate is ignored.
    if (!byNormalized.has(key)) byNormalized.set(key, canonical)
  }
  if (byNormalized.size === 0) {
    throw new Error(
      "payments: allowedPayees is empty — an agent could pay no one (refusing config)",
    )
  }
  return { byNormalized }
}

/** Whether a payee is operator-pinned (pure, no throw) — for input-schema refinement. */
export function isAllowedPayee(payee: string, policy: PayeePolicy): boolean {
  return policy.byNormalized.has(normalizePayee(payee))
}

/** Validate the agent's payee against the pin. Throws on a non-pinned payee. Returns
 * the operator's canonical payee string to actually charge. The authoritative check
 * used in `execute` — the last line before the irreversible side effect. */
export function assertAllowedPayee(payee: string, policy: PayeePolicy, tool: string): string {
  const canonical = policy.byNormalized.get(normalizePayee(payee))
  if (canonical === undefined) {
    const pinned = [...policy.byNormalized.values()].join(", ") || "none"
    throw new Error(`${tool}: payee '${payee}' is not in the operator-allowed payees (${pinned})`)
  }
  return canonical
}

// -----------------------------------------------------------------------------
// Money policy (the amount/currency guard) — NEW for payments
// -----------------------------------------------------------------------------

export interface MoneyPolicy {
  /** Lowercased operator-allowed currency codes. */
  allowedCurrencies: Set<string>
  /** The operator ceiling (in minor units) for a currency, or undefined if the
   * currency is not allowed. Every allowed currency always has a ceiling. */
  ceilingFor: (currency: string) => number | undefined
}

/** Normalize a currency code for matching: trim + lowercase. */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toLowerCase()
}

function assertPositiveIntMinor(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`payments: ${label} must be a positive integer in minor units (got ${value})`)
  }
}

/**
 * Compile the money policy. `ceiling` is either a single cap (minor units) that
 * applies to every allowed currency, or a per-currency `{ usd: 50000, eur: 45000 }`
 * map. Refuses config where an allowed currency has no ceiling — an uncapped
 * allowed currency would be an unbounded-payment hole.
 */
export function compileMoneyPolicy(
  allowedCurrencies: string[],
  ceiling: number | Record<string, number>,
): MoneyPolicy {
  const allowed = new Set<string>()
  for (const raw of allowedCurrencies) {
    const c = normalizeCurrency(raw)
    if (c.length > 0) allowed.add(c)
  }
  if (allowed.size === 0) {
    throw new Error("payments: allowedCurrencies is empty (refusing config)")
  }

  if (typeof ceiling === "number") {
    assertPositiveIntMinor(ceiling, "ceiling")
    const cap = ceiling
    return {
      allowedCurrencies: allowed,
      ceilingFor: (c) => (allowed.has(normalizeCurrency(c)) ? cap : undefined),
    }
  }

  const byCurrency = new Map<string, number>()
  for (const [k, v] of Object.entries(ceiling)) {
    const c = normalizeCurrency(k)
    if (c.length === 0) continue
    assertPositiveIntMinor(v, `ceiling for '${c}'`)
    // A ceiling for a currency that is NOT allowlisted is dead/confusing config — and
    // would otherwise hand a cap to an off-allowlist currency. Refuse it, don't ignore.
    if (!allowed.has(c)) {
      throw new Error(
        `payments: ceiling has an entry for '${c}', which is not in allowedCurrencies (refusing config)`,
      )
    }
    byCurrency.set(c, v)
  }
  // Every allowed currency must carry a ceiling — no uncapped allowed currency.
  for (const c of allowed) {
    if (!byCurrency.has(c)) {
      throw new Error(
        `payments: allowed currency '${c}' has no ceiling — an uncapped currency is an unbounded-payment hole (refusing config)`,
      )
    }
  }
  // `ceilingFor` gates on the allowlist too (mirroring the single-cap branch), so the
  // `MoneyPolicy` contract — undefined for a non-allowed currency — holds unconditionally,
  // keeping the exported `assertWithinCeiling` a sound defensive guard for direct callers.
  return {
    allowedCurrencies: allowed,
    ceilingFor: (c) => {
      const n = normalizeCurrency(c)
      return allowed.has(n) ? byCurrency.get(n) : undefined
    },
  }
}

/** Whether a currency is operator-allowed (pure, no throw) — for input-schema refinement. */
export function isAllowedCurrency(currency: string, policy: MoneyPolicy): boolean {
  return policy.allowedCurrencies.has(normalizeCurrency(currency))
}

/** Validate the agent's currency against the allowlist. Throws on a non-allowed
 * currency. Returns the normalized currency. Authoritative check used in `execute`. */
export function assertAllowedCurrency(currency: string, policy: MoneyPolicy, tool: string): string {
  const c = normalizeCurrency(currency)
  if (!policy.allowedCurrencies.has(c)) {
    const allowed = [...policy.allowedCurrencies].join(", ") || "none"
    throw new Error(`${tool}: currency '${currency}' is not operator-allowed (${allowed})`)
  }
  return c
}

/** Validate the amount against the operator ceiling for its currency. Throws on an
 * over-ceiling amount (or an unknown currency, defensively). Authoritative check
 * used in `execute` — re-asserted even after the input-schema rejected it at propose. */
export function assertWithinCeiling(
  amountMinor: number,
  currency: string,
  policy: MoneyPolicy,
  tool: string,
): void {
  const cap = policy.ceilingFor(currency)
  if (cap === undefined) {
    throw new Error(
      `${tool}: no ceiling for currency '${currency}' (currency not operator-allowed)`,
    )
  }
  if (amountMinor > cap) {
    throw new Error(
      `${tool}: amount ${amountMinor} exceeds the operator ceiling ${cap} for ${normalizeCurrency(currency)}`,
    )
  }
}
