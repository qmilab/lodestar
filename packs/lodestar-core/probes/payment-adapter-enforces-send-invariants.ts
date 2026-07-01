#!/usr/bin/env bun
/**
 * Probe: payment_adapter_enforces_send_invariants
 *
 * Locks the egress-governance invariants of the native payment tool
 * (`@qmilab/lodestar-adapter-payments`: `payment.send`) by driving the REAL adapter
 * tool through the REAL Action Kernel (propose → arbitrate → resolve → execute).
 * Payments is epic #74 child #80 — the strongest human-approval case (an outward,
 * irreversible money movement), so these are the things that MUST hold:
 *
 *   0. **Config is fail-closed.** An out-of-range `trust` (below L4 or above L5) is
 *      REJECTED at build — a payment must never sit below the human-approval gate nor
 *      carry an off-ladder level (the option is only for raising to L5 as a kill-switch).
 *   1. **L4 hold blocks the world.** A `payment.send` proposed at L4 parks at
 *      `pending_approval`, and NOTHING reaches the provider while it waits. Only
 *      after `resolve(granted)` + `execute` does it charge, exactly once, the
 *      operator-canonical payee.
 *   2. **Amount ceiling — rejected at PROPOSE.** An over-ceiling charge throws in
 *      `propose()` (the input schema), so no hold is ever created and the provider
 *      is untouched — an over-ceiling payment is never even presentable to a human.
 *   3. **Payee pinning — an exfil attempt is an audited `failed` action.** An
 *      approved charge to a NON-pinned payee ends `failed` (the authoritative
 *      `execute` guard), and the provider receives nothing.
 *   4. **Currency allowlist — rejected at PROPOSE.** An off-allowlist currency
 *      throws in `propose()`; the provider is untouched.
 *   5. **Idempotency — a replay cannot double-charge.** The same approved charge
 *      (same `idempotency_key`) run twice charges the provider ONCE; the second
 *      completes flagged `idempotent_replay`.
 *   6. **Credentials never leak.** The operator API key is injected on the request
 *      (the provider sees it) but is absent from the recorded action inputs AND the
 *      emitted observation — redacted even when the provider echoes it back, even when
 *      the echo uses ANY JSON string escape (`\uXXXX`, `\/`, `\"`, …; full, partial, or
 *      mixed), and even when that escaped echo arrives in a TRUNCATED / invalid-JSON
 *      failure body that reaches the audit (the captured body has its full JSON escape
 *      set decoded before redaction, so no decoded token — including a `\/`-escaped
 *      base64 credential — is recoverable from the observation or the audit); a
 *      credential with JSON-special chars is also covered in its JSON string-escaped form.
 *   7. **Delivery semantics — only an explicitly-confirmed charge succeeds.** A
 *      provider decline (HTTP 402), a 200 `status:"pending"` body, an HTTP 202
 *      Accepted, a 200 with an UNRECOGNISED status, a 200 with NO status, and a
 *      truncated/unparseable confirmation ALL end the action `failed`, not a silent
 *      "charged"; the echoed credential is redacted from the failed-action audit. (A
 *      bare 2xx is not a confirmation — the generic provider requires a recognised
 *      success status, else the operator passes a custom `interpret`.)
 *   8. **L5 kill-switch.** A charge proposed at L5 is `rejected` outright (the gate
 *      denies without human approval), the provider is untouched, and a forced
 *      `resolve(granted)` is mechanically inert (refused by phase).
 *
 *   + **Bounded capture, redaction before the cap.** An oversized provider response
 *      is captured to the cap; a truncated confirmation cannot be trusted so the
 *      charge FAILS, and when the body echoes the credential straddling the byte cap,
 *      redaction runs first so not even a token prefix survives into the audit.
 *
 * If any of these regress, a Lodestar-wrapped agent could move money with no human
 * in the loop, pay an attacker, exceed the operator ceiling, double-charge on a
 * replay, leak the API key, or silently treat a declined charge as paid — so this
 * probe is spec, not test scaffolding.
 */

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import {
  type ChargeRequest,
  type ChargeResult,
  type PaymentProvider,
  applyRedactions,
  createHttpPaymentProvider,
  makePaymentSendTool,
  postJson,
  redactionVariants,
  registerPaymentTools,
} from "@qmilab/lodestar-adapter-payments"
import type { ActionContract, BlastRadius, Observation, Reversibility } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

// A distinctive operator API key. It is injected by the adapter at request time; it
// must NEVER surface in inputs or observations.
const TOKEN = "pmt-PROBE-secret-deadbeefcafef00d"
const CREDENTIAL = { header: "Authorization", value: `Bearer ${TOKEN}` }
// A base64-style credential CONTAINING `/` — a provider can echo it JSON-escaped as
// `\/`, which a `\uXXXX`-only decode misses. The transport must decode the FULL escape
// set. Distinctive marker "pmt/PROBE" survives any single-escape trick when decoded.
const SLASH_TOKEN = "pmt/PROBE/secret/deadbeef00d"
const PAYEE = "acct_vendor"
const CEILING = { usd: 50_000 } // $500.00 in cents

// -----------------------------------------------------------------------------
// Phase A: an in-process fake PaymentProvider that records what it charged and
// dedupes on the idempotency key (no network — even simpler than a Bun.serve fake).
// -----------------------------------------------------------------------------

interface FakeProvider {
  provider: PaymentProvider
  count: () => number
  last: () => ChargeRequest | null
}

function makeFakeProvider(): FakeProvider {
  const rec = { count: 0, requests: [] as ChargeRequest[], seen: new Map<string, ChargeResult>() }
  const provider: PaymentProvider = {
    label: "fake",
    charge: async (req) => {
      rec.requests.push(req)
      // Idempotency: a duplicate key returns the prior result flagged replay, WITHOUT
      // incrementing the real charge counter — a provider that dedupes a retry.
      const prior = rec.seen.get(req.idempotency_key)
      if (prior) return { ...prior, idempotent_replay: true }
      rec.count += 1
      const result: ChargeResult = {
        succeeded: true,
        status: "succeeded",
        payment_id: `pay_${rec.count}`,
        idempotent_replay: false,
        provider_status: 0,
        response_excerpt: "",
        response_truncated: false,
        authenticated: false,
      }
      rec.seen.set(req.idempotency_key, result)
      return result
    },
  }
  return { provider, count: () => rec.count, last: () => rec.requests.at(-1) ?? null }
}

// -----------------------------------------------------------------------------
// Phase B: an in-process Bun.serve fake payment API that records the auth header,
// and branches on the request's `memo` to decline / oversize / echo the token.
// -----------------------------------------------------------------------------

interface FakeServer {
  base: string
  count: () => number
  lastAuth: () => string | null
  stop: () => void
}

function startServer(): FakeServer {
  const rec = { count: 0, auths: [] as (string | null)[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text()
      rec.count += 1
      const auth = req.headers.get("authorization")
      rec.auths.push(auth)
      const a = auth ?? ""
      const json = (value: unknown, status: number): Response =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        })
      const parsed = JSON.parse(body) as { memo?: string }
      switch (parsed.memo) {
        case "DECLINE":
          // A decline that ECHOES the credential, to test audit redaction on failure.
          return json({ error: "card_declined", echo: auth }, 402)
        case "PENDING":
          // A 200 whose body says the charge is NOT yet captured. A 2xx alone is not a
          // confirmation — this must NOT be reported as charged.
          return json({ id: "pay_pending", status: "pending" }, 200)
        case "ACCEPTED":
          // HTTP 202 Accepted: queued, not completed. Must NOT be reported as charged.
          return json({ id: "pay_accepted" }, 202)
        case "QUEUED":
          // A 200 with an UNRECOGNISED status. Fail-closed: the generic interpreter
          // only confirms on an allowlisted success status, never an unknown one.
          return json({ id: "pay_queued", status: "queued" }, 200)
        case "NOSTATUS":
          // A 200 with NO status field. A bare 2xx is not a confirmation — must fail.
          return json({ id: "pay_nostatus", echo: auth }, 200)
        case "ESCAPED": {
          // A SUCCESS (recognised status) whose echo hides the credential with a
          // PARTIAL JSON `\u` escape (every other char), so NEITHER the raw token NOR
          // the fully-escaped redaction variant matches — only canonicalising the
          // parsed body before redaction can scrub it. The decoded token must not be
          // recoverable from the observation.
          const mixed = [...a]
            .map((c, i) =>
              i % 2 === 0 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c,
            )
            .join("")
          return new Response(`{"status":"succeeded","id":"pay_esc","echo":"${mixed}"}`, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        case "OVERSIZE":
          // An oversized body that echoes the credential positioned so the byte cap
          // (256) cuts THROUGH it. A truncated confirmation cannot be trusted (so the
          // charge must FAIL), and if the cap were applied before redaction a token
          // prefix would survive into the failed-action audit.
          return new Response(`${"X".repeat(239)}${a}${"X".repeat(200)}`, { status: 200 })
        case "ESCTRUNC": {
          // An oversized (→ truncated), INVALID-JSON body (no closing brace) that
          // echoes the credential MIXED-escaped near the start: canonicalisation is
          // skipped (cannot parse), so ONLY escape-decoding before redaction can scrub
          // it from the failed-action audit (which carries the response excerpt).
          const mixed = [...a]
            .map((c, i) =>
              i % 2 === 0 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c,
            )
            .join("")
          return new Response(`{"x":"${mixed}","filler":"${"Y".repeat(400)}"`, { status: 200 })
        }
        case "SLASHTRUNC": {
          // An oversized (→ truncated), INVALID-JSON body echoing the credential with
          // every `/` JSON-escaped as `\/` (the base64-token evasion a `\uXXXX`-only
          // decode misses). The transport must decode the FULL JSON escape set.
          const slashed = a.replace(/\//g, "\\/")
          return new Response(`{"x":"${slashed}","filler":"${"Y".repeat(400)}"`, { status: 200 })
        }
        default:
          // A normal success: a recognised success status, echoing the credential back
          // (a misbehaving provider reflecting the token — must be redacted).
          return json({ status: "succeeded", id: "pay_http_1", echo: auth }, 200)
      }
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    count: () => rec.count,
    lastAuth: () => rec.auths.at(-1) ?? null,
    stop: () => server.stop(true),
  }
}

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-payments" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()

  const observations: Observation[] = []
  const observationSink = async (obs: Observation): Promise<void> => {
    observations.push(obs)
  }
  // Three-valued gate: L5 denies outright (no human approval); L4 holds; below
  // auto-approves.
  const policyGate: PolicyGate = async (action) => {
    const level = action.contract.required_level
    if (level >= 5) {
      return {
        approved: false,
        reason: "L5 is prohibited and can never run in this context",
        approver_id: "probe.policy",
      }
    }
    if (level >= 4) {
      return {
        approved: false,
        requires_human_approval: true,
        reason: "L4 egress requires human approval",
        approver_id: "probe.policy",
      }
    }
    return { approved: true, reason: "below L4 auto-approved", approver_id: "probe.policy" }
  }
  const preconditionChecker: PreconditionChecker = async () => ({ holds: true, observed: null })

  const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
    useStubsForTests: true,
  })
  const propose = (inputs: unknown, contract: ActionContract) =>
    kernel.propose({
      intent: "probe payment.send",
      tool: "payment.send",
      inputs,
      contract,
      proposed_by: "probe.payments",
    })
  const grant = (action: { id: string }, reqId: string) => ({
    kind: "granted" as const,
    action_id: action.id,
    request_id: reqId,
    approver_id: "probe.human",
  })
  const L4 = () => contractFor(4, "external", "irreversible")
  const L5 = () => contractFor(5, "external", "irreversible")
  const outputFor = (id: string) =>
    observations.find((o) => o.source.invocation_id === id)?.payload as
      | Record<string, unknown>
      | undefined

  // ===========================================================================
  // Phase A — fake provider: hold, ceiling, payee, currency, idempotency, L5.
  // ===========================================================================
  const fake = makeFakeProvider()

  // ---- 0. Config: an out-of-range trust floor is REJECTED at build ---------
  // A payment is L4 (held) or L5 (disabled) — nothing else. Below L4 would let a host
  // that auto-approves sub-L4 charge with NO human in the loop; above L5 is off the
  // trust ladder. Both must be refused at build (the option is only for raising to L5).
  for (const badTrust of [2, 6] as const) {
    let threw = false
    try {
      makePaymentSendTool({
        provider: fake.provider,
        allowedPayees: [PAYEE],
        allowedCurrencies: ["usd"],
        ceiling: CEILING,
        trust: badTrust,
      })
    } catch {
      threw = true
    }
    if (!threw) {
      return {
        passed: false,
        details: `trust floor FAILED: makePaymentSendTool accepted an out-of-range trust level ${badTrust} — a payment must be L4 or L5 only.`,
      }
    }
  }

  registerPaymentTools({
    provider: fake.provider,
    allowedPayees: [PAYEE],
    allowedCurrencies: ["usd"],
    ceiling: CEILING,
  })

  // ---- 1. L4 hold blocks the world -----------------------------------------
  const held = await kernel.arbitrate(
    propose(
      { payee: PAYEE, amount_minor: 12_500, currency: "usd", idempotency_key: "inv-0001" },
      L4(),
    ),
  )
  if (held.phase !== "pending_approval") {
    return {
      passed: false,
      details: `L4 hold FAILED: a payment.send proposed at L4 did not park at pending_approval (phase=${held.phase}).`,
    }
  }
  if (fake.count() !== 0) {
    return {
      passed: false,
      details:
        "L4 hold FAILED: the charge reached the provider while only at pending_approval — a held payment touched the world.",
    }
  }
  const paid = await kernel.execute(kernel.resolve(held, grant(held, "req-hold")))
  if (paid.phase !== "completed") {
    return {
      passed: false,
      details: `payment.send FAILED: the approved charge did not complete (phase=${paid.phase}); audit: ${JSON.stringify(paid.audit.at(-1))}`,
    }
  }
  if (fake.count() !== 1 || fake.last()?.payee !== PAYEE || fake.last()?.amount_minor !== 12_500) {
    return {
      passed: false,
      details: `payment.send FAILED: the approved charge did not hit the provider exactly once with the canonical payee/amount (count=${fake.count()}, last=${JSON.stringify(fake.last())}).`,
    }
  }
  const paidOut = outputFor(paid.id)
  if (paidOut?.charged !== true || paidOut?.payee !== PAYEE || paidOut?.currency !== "usd") {
    return {
      passed: false,
      details: `payment.send FAILED: the output did not record a confirmed charge to the canonical payee (out=${JSON.stringify(paidOut)}).`,
    }
  }

  // ---- 2. Amount ceiling — rejected at PROPOSE -----------------------------
  let ceilingThrew = false
  try {
    propose(
      { payee: PAYEE, amount_minor: 60_000, currency: "usd", idempotency_key: "inv-over" },
      L4(),
    )
  } catch {
    ceilingThrew = true
  }
  if (!ceilingThrew) {
    return {
      passed: false,
      details:
        "amount ceiling FAILED: an over-ceiling charge did not throw at propose (it would have reached the approval queue).",
    }
  }
  if (fake.count() !== 1) {
    return {
      passed: false,
      details: "amount ceiling FAILED: an over-ceiling charge reached the provider.",
    }
  }

  // ---- 3. Payee pinning — an exfil attempt is an audited `failed` action ----
  const exfil = await kernel.arbitrate(
    propose(
      { payee: "acct_attacker", amount_minor: 100, currency: "usd", idempotency_key: "inv-exfl" },
      L4(),
    ),
  )
  const exfilDone = await kernel.execute(kernel.resolve(exfil, grant(exfil, "req-exfl")))
  if (exfilDone.phase !== "failed") {
    return {
      passed: false,
      details: `payee pinning FAILED: an approved charge to a non-pinned payee did not end 'failed' (phase=${exfilDone.phase}).`,
    }
  }
  if (fake.count() !== 1) {
    return {
      passed: false,
      details: "payee pinning FAILED: the non-pinned payee reached the provider.",
    }
  }

  // ---- 4. Currency allowlist — rejected at PROPOSE -------------------------
  let currencyThrew = false
  try {
    propose({ payee: PAYEE, amount_minor: 100, currency: "gbp", idempotency_key: "inv-curr" }, L4())
  } catch {
    currencyThrew = true
  }
  if (!currencyThrew) {
    return {
      passed: false,
      details: "currency allowlist FAILED: an off-allowlist currency did not throw at propose.",
    }
  }
  if (fake.count() !== 1) {
    return {
      passed: false,
      details: "currency allowlist FAILED: an off-allowlist currency reached the provider.",
    }
  }

  // ---- 5. Idempotency — a replay cannot double-charge ----------------------
  // The same charge (same idempotency_key) run twice through the full flow models a
  // sidecar/process restart replaying a persisted action.
  const dupInput = {
    payee: PAYEE,
    amount_minor: 2_500,
    currency: "usd",
    idempotency_key: "inv-dupe1",
  }
  const firstHeld = await kernel.arbitrate(propose(dupInput, L4()))
  const firstDone = await kernel.execute(kernel.resolve(firstHeld, grant(firstHeld, "req-d-a")))
  const secondHeld = await kernel.arbitrate(propose(dupInput, L4()))
  const secondDone = await kernel.execute(kernel.resolve(secondHeld, grant(secondHeld, "req-d-b")))
  if (firstDone.phase !== "completed" || secondDone.phase !== "completed") {
    return {
      passed: false,
      details: `idempotency FAILED: a duplicate-key charge did not complete (phases=${firstDone.phase}/${secondDone.phase}).`,
    }
  }
  // count was 1 (case 1); a fresh key was charged once → 2; the duplicate must NOT
  // increment it again.
  if (fake.count() !== 2) {
    return {
      passed: false,
      details: `idempotency FAILED: a replay with the same idempotency_key double-charged the provider (count=${fake.count()}, expected 2).`,
    }
  }
  const secondOut = outputFor(secondDone.id)
  if (secondOut?.idempotent_replay !== true) {
    return {
      passed: false,
      details: `idempotency FAILED: the replayed charge was not flagged idempotent_replay (out=${JSON.stringify(secondOut)}).`,
    }
  }

  // ---- 8. L5 kill-switch ----------------------------------------------------
  const killed = await kernel.arbitrate(
    propose(
      { payee: PAYEE, amount_minor: 100, currency: "usd", idempotency_key: "inv-kill" },
      L5(),
    ),
  )
  if (killed.phase !== "rejected") {
    return {
      passed: false,
      details: `L5 kill-switch FAILED: a charge proposed at L5 was not rejected outright (phase=${killed.phase}).`,
    }
  }
  if (fake.count() !== 2) {
    return { passed: false, details: "L5 kill-switch FAILED: an L5 charge reached the provider." }
  }
  // A valid grant is mechanically inert against a rejected (non-held) action.
  let killResolveThrew = false
  try {
    kernel.resolve(killed, grant(killed, "req-kill"))
  } catch {
    killResolveThrew = true
  }
  if (!killResolveThrew) {
    return {
      passed: false,
      details:
        "L5 kill-switch FAILED: a forged resolve(granted) was accepted against a rejected L5 action (the approval was not inert).",
    }
  }

  // ===========================================================================
  // Phase B — generic-HTTP provider over a Bun.serve fake: credential redaction,
  // delivery semantics, bounded capture.
  // ===========================================================================
  _resetToolsForTests()
  const server = startServer()
  try {
    registerPaymentTools({
      provider: createHttpPaymentProvider({
        endpoint: `${server.base}/charges`,
        credential: CREDENTIAL,
        allowHttp: true,
        maxBytes: 256,
      }),
      allowedPayees: [PAYEE],
      allowedCurrencies: ["usd"],
      ceiling: CEILING,
    })

    // ---- 6. Credentials never leak ----------------------------------------
    const credHeld = await kernel.arbitrate(
      propose(
        { payee: PAYEE, amount_minor: 4_200, currency: "usd", idempotency_key: "inv-cred" },
        L4(),
      ),
    )
    const credDone = await kernel.execute(kernel.resolve(credHeld, grant(credHeld, "req-cred")))
    if (credDone.phase !== "completed") {
      return {
        passed: false,
        details: `credential check FAILED: the authenticated charge did not complete (phase=${credDone.phase}); audit: ${JSON.stringify(credDone.audit.at(-1))}.`,
      }
    }
    if (server.lastAuth() !== `Bearer ${TOKEN}`) {
      return {
        passed: false,
        details: `credential check FAILED: the operator credential was not injected on the request (provider saw '${server.lastAuth()}').`,
      }
    }
    const credObs = observations.find((o) => o.source.invocation_id === credDone.id)
    if (!credObs) {
      return {
        passed: false,
        details: "credential check FAILED: no observation recorded for the completed charge.",
      }
    }
    if (JSON.stringify(credObs).includes(TOKEN)) {
      return {
        passed: false,
        details:
          "credential leak FAILED: the credential surfaced in the observation (echoed token not redacted).",
      }
    }
    if (JSON.stringify(credDone.inputs).includes(TOKEN)) {
      return {
        passed: false,
        details: "credential leak FAILED: the credential surfaced in the recorded action inputs.",
      }
    }

    // ---- 6b. A JSON-escaped credential echo is still redacted --------------
    // A successful charge whose response echoes the credential with a PARTIAL `\u`
    // escape (evading a raw-string match) must NOT leak the DECODED token into the
    // observation — the captured body is canonicalised (escapes decoded → literal)
    // before redaction.
    const escHeld = await kernel.arbitrate(
      propose(
        {
          payee: PAYEE,
          amount_minor: 4_200,
          currency: "usd",
          idempotency_key: "inv-escp",
          memo: "ESCAPED",
        },
        L4(),
      ),
    )
    const escDone = await kernel.execute(kernel.resolve(escHeld, grant(escHeld, "req-escp")))
    if (escDone.phase !== "completed") {
      return {
        passed: false,
        details: `escaped-echo check FAILED: a success with a recognised status did not complete (phase=${escDone.phase}).`,
      }
    }
    const escExcerpt = String(outputFor(escDone.id)?.response_excerpt ?? "")
    const escDecoded = escExcerpt.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    )
    if (escExcerpt.includes(TOKEN) || escDecoded.includes(TOKEN)) {
      return {
        passed: false,
        details:
          "escaped-echo leak FAILED: a JSON-escaped credential echo decoded to the token in the observation (the body was not canonicalised before redaction).",
      }
    }

    // ---- 7. Delivery semantics (decline → failed, audit redacted) ----------
    const decline = await kernel.arbitrate(
      propose(
        {
          payee: PAYEE,
          amount_minor: 4_200,
          currency: "usd",
          idempotency_key: "inv-decl",
          memo: "DECLINE",
        },
        L4(),
      ),
    )
    const declineDone = await kernel.execute(kernel.resolve(decline, grant(decline, "req-decl")))
    if (declineDone.phase !== "failed") {
      return {
        passed: false,
        details: `delivery semantics FAILED: a provider decline (HTTP 402) did not end 'failed' (phase=${declineDone.phase}) — a declined charge was treated as paid.`,
      }
    }
    if (JSON.stringify(declineDone.audit).includes(TOKEN)) {
      return {
        passed: false,
        details:
          "delivery semantics FAILED: the echoed credential surfaced in the failed-action audit (not redacted).",
      }
    }

    // ---- 7b. Unconfirmed 2xx must NOT be reported as charged ----------------
    // The generic interpreter confirms ONLY on an explicit recognised success status.
    // A 200 status:pending body, an HTTP 202 Accepted, a 200 with an UNRECOGNISED
    // status, and a 200 with NO status field are all 2xx but none is a captured charge
    // — the strict gate must fail the action, never report it as charged. (Regression
    // guard for the generic interpreter treating a bare 2xx as success.)
    for (const [memo, key, label] of [
      ["PENDING", "inv-pend", "a 200 status:pending body"],
      ["ACCEPTED", "inv-acpt", "an HTTP 202 Accepted"],
      ["QUEUED", "inv-queu", "a 200 with an unrecognised status"],
      ["NOSTATUS", "inv-nost", "a 200 with no charge status"],
    ] as const) {
      const held = await kernel.arbitrate(
        propose(
          { payee: PAYEE, amount_minor: 4_200, currency: "usd", idempotency_key: key, memo },
          L4(),
        ),
      )
      const done = await kernel.execute(kernel.resolve(held, grant(held, "req-unconf")))
      if (done.phase !== "failed") {
        return {
          passed: false,
          details: `delivery semantics FAILED: ${label} was reported as a confirmed charge (phase=${done.phase}) — an unconfirmed 2xx must fail.`,
        }
      }
    }

    // ---- + Bounded capture: a truncated confirmation FAILS, and stays redacted ---
    // An oversized provider response is captured to the cap and flagged truncated; a
    // truncated confirmation cannot be trusted, so the charge FAILS (not a silent
    // "charged"). The capped excerpt reaches the failed-action audit, and the
    // credential straddling the cap leaves no prefix (redaction runs before the cap).
    const big = await kernel.arbitrate(
      propose(
        {
          payee: PAYEE,
          amount_minor: 4_200,
          currency: "usd",
          idempotency_key: "inv-over2",
          memo: "OVERSIZE",
        },
        L4(),
      ),
    )
    const bigDone = await kernel.execute(kernel.resolve(big, grant(big, "req-big")))
    if (bigDone.phase !== "failed") {
      return {
        passed: false,
        details: `bounded capture FAILED: an oversized/truncated provider response was treated as a confirmed charge (phase=${bigDone.phase}) — a truncated confirmation must fail.`,
      }
    }
    const bigAudit = JSON.stringify(bigDone.audit)
    if (!/truncat/i.test(bigAudit)) {
      return {
        passed: false,
        details: `bounded capture FAILED: the truncated response was not detected in the failed-action audit (detail=${bigDone.audit.at(-1)?.detail}).`,
      }
    }
    // The oversized body echoed the credential straddling the byte cap; redaction
    // runs before the cap, so not even a 9-char prefix that the full-token check
    // would NOT catch may survive into the (body-carrying) audit.
    if (bigAudit.includes("pmt-PROBE")) {
      return {
        passed: false,
        details:
          "bounded capture FAILED: a credential prefix survived truncation in the audit (the cap was applied before redaction).",
      }
    }

    // ---- + A mixed-escaped credential in a TRUNCATED/invalid body stays redacted ---
    // A hostile provider echoes the credential MIXED `\u`-escaped in a body that is
    // truncated AND invalid JSON (so canonicalisation is skipped). The failed-action
    // audit (decline_reason carries the response excerpt) must NOT contain the
    // credential — not even after JSON-decoding — because the body is escape-decoded
    // before redaction at capture.
    const escTrunc = await kernel.arbitrate(
      propose(
        {
          payee: PAYEE,
          amount_minor: 4_200,
          currency: "usd",
          idempotency_key: "inv-esct",
          memo: "ESCTRUNC",
        },
        L4(),
      ),
    )
    const escTruncDone = await kernel.execute(kernel.resolve(escTrunc, grant(escTrunc, "req-esct")))
    if (escTruncDone.phase !== "failed") {
      return {
        passed: false,
        details: `escaped-truncated check FAILED: a truncated/invalid-JSON response was not failed (phase=${escTruncDone.phase}).`,
      }
    }
    const escTruncDetail = String(escTruncDone.audit.at(-1)?.detail ?? "")
    const escTruncDecoded = escTruncDetail.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    )
    if (escTruncDetail.includes(TOKEN) || escTruncDecoded.includes(TOKEN)) {
      return {
        passed: false,
        details:
          "escaped-truncated leak FAILED: a mixed-escaped credential decoded to the token in the failed-action audit (the body was not escape-decoded before redaction).",
      }
    }

    // ---- + A JSON-special-char credential is redacted in its JSON-escaped form ----
    // A credential containing `"` or `\` is RE-escaped by JSON.stringify when the
    // transport canonicalises a body, so the redaction set must cover that JSON
    // string-escaped form. Pin the exported primitive directly (it is public API).
    const specialCred = 'Bearer a"b\\c/PROBE-secret'
    const canonicalised = JSON.stringify({ echo: specialCred })
    const redactedSpecial = applyRedactions(canonicalised, redactionVariants(specialCred))
    if (redactedSpecial.includes("PROBE-secret") || redactedSpecial.includes(specialCred)) {
      return {
        passed: false,
        details: `JSON-escaped credential redaction FAILED: a special-char credential survived in its JSON string-escaped form (redacted='${redactedSpecial}').`,
      }
    }

    // ---- + A `\/`-escaped credential in a truncated body stays redacted --------
    // The transport decodes ALL JSON string escapes (not just `\uXXXX`) before
    // redaction — so a base64-style credential containing `/`, echoed `\/`-escaped in a
    // TRUNCATED / invalid body, leaves no decodable token in the captured excerpt.
    // Driven through the exported `postJson` directly against the fake (transport-level).
    const slashRes = await postJson({
      url: new URL(`${server.base}/charges`),
      body: JSON.stringify({ memo: "SLASHTRUNC" }),
      credential: { header: "Authorization", value: `Bearer ${SLASH_TOKEN}` },
      timeoutMs: 15_000,
      maxBytes: 256,
      tool: "payment.send",
    })
    const slashDecoded = slashRes.body
      .replace(/\\\//g, "/")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    if (
      slashRes.body.includes(SLASH_TOKEN) ||
      slashRes.body.includes("pmt/PROBE") ||
      slashDecoded.includes(SLASH_TOKEN) ||
      slashDecoded.includes("pmt/PROBE")
    ) {
      return {
        passed: false,
        details: `slash-escape leak FAILED: a \\/-escaped credential survived (or decoded back) in the captured excerpt (body='${slashRes.body}').`,
      }
    }

    return {
      passed: true,
      details:
        "Native payment transport held every invariant through the Action Kernel: an out-of-range trust config (below L4 or above L5) was rejected at build (a payment can never sit below the human-approval gate nor carry an off-ladder level); a payment.send proposed at L4 parked at pending_approval and reached no provider until approval, then charged exactly once to the operator-canonical payee; an over-ceiling amount and an off-allowlist currency both threw at propose (no hold, provider untouched); an approved charge to a non-pinned payee ended 'failed' with the provider untouched (the audited exfil guard); a replay with the same idempotency_key did not double-charge and was flagged idempotent_replay; the operator API key reached the provider but never surfaced in the inputs or the (token-echoing) observation — not even when echoed with any JSON string escape (\\uXXXX, \\/, \\\", …; full, partial, or mixed), and not even when a mixed-escaped or `\\/`-escaped echo arrived in a truncated/invalid-JSON failure body that reached the audit (the captured body has its full JSON escape set decoded before redaction), and a credential with JSON-special chars is redacted in its JSON string-escaped form; a provider decline (HTTP 402), a 200 status:pending body, an HTTP 202 Accepted, a 200 with an unrecognised status, a 200 with no status, and a truncated confirmation all ended 'failed' rather than a silent 'charged' (the generic interpreter confirms only on an explicit success status), with the echoed credential redacted from the audit; an L5-pinned charge was rejected outright with a valid grant mechanically inert; and an oversized response echoing the credential straddling the byte cap was captured to the cap with not even a token prefix surviving.",
    }
  } finally {
    server.stop()
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: payment_adapter_enforces_send_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
