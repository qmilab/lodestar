#!/usr/bin/env bun
/**
 * Probe: messaging_adapter_enforces_egress_invariants
 *
 * Locks the egress-governance invariants of the native messaging tools
 * (`@qmilab/lodestar-adapter-messaging`: `slack.post` / `email.send`) by driving
 * the REAL adapter tools through the REAL Action Kernel
 * (propose → arbitrate → resolve → execute) against in-process fake providers
 * standing in for Slack / an email API. Messaging is P2 slice 5 — the canonical
 * irreversible-external **L4 human-approval** action, so these are the things that
 * MUST hold:
 *
 *   1. **L4 hold blocks the world.** A `slack.post` (egress) proposed at L4 parks
 *      at `pending_approval`, and NOTHING reaches the provider while it waits.
 *      Only after `resolve(granted)` + `execute` does it land with its message.
 *   2. **Destination pinning beats exfiltration.** An approved `slack.post` to a
 *      NON-pinned channel — an approved `email.send` to a NON-allowlisted
 *      recipient — and an approved `email.send` whose `to` is a comma-separated
 *      string smuggling an off-allowlist address — all end `failed`, and the
 *      provider receives nothing. A send to an allowlisted recipient (by domain)
 *      lands.
 *   3. **Operator-fixed sender.** The email reaches the provider with the
 *      operator's `from`, never an agent-chosen one (the agent has no `from`
 *      input — anti-spoofing).
 *   4. **Credentials never leak.** The operator bot token is injected on the
 *      request (the provider sees it) but is absent from the recorded action
 *      inputs AND the emitted observation (redacted even when the provider echoes
 *      it back), and the agent never supplied it.
 *   5. **Delivery semantics.** A Slack `ok:false` (HTTP 200) is a delivery
 *      FAILURE — the action ends `failed`, not a silent "completed".
 *   6. **Bounded capture, redaction before the cap.** An oversized provider
 *      response is captured up to the cap and flagged `response_truncated` — a
 *      hostile provider cannot inflate an observation. AND, when that response
 *      echoes the credential straddling the byte cap, redaction runs first so not
 *      even a token *prefix* survives the truncation.
 *
 * If any of these regress, a Lodestar-wrapped agent could send a message with no
 * human in the loop, email an attacker, spoof the sender, leak the bot token, or
 * silently treat a rejected send as delivered — so this probe is spec, not test
 * scaffolding.
 */

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { registerMessagingTools } from "@qmilab/lodestar-adapter-messaging"
import type { ActionContract, BlastRadius, Observation, Reversibility } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

// A distinctive operator bot token. It is injected by the adapter at request
// time; it must NEVER surface in inputs or observations.
const TOKEN = "xoxb-PROBE-secret-deadbeefcafef00d"
const CREDENTIAL = { header: "Authorization", value: `Bearer ${TOKEN}` }
const OPERATOR_FROM = "agent@ops.example.com"

// -----------------------------------------------------------------------------
// In-process fake providers (Bun.serve) that record what they received.
// -----------------------------------------------------------------------------

interface FakeServer {
  base: string
  count: () => number
  lastAuth: () => string | null
  lastBody: () => string | null
  stop: () => void
}

type Responder = (req: Request, body: string) => Response

function startServer(respond: Responder): FakeServer {
  const rec = { count: 0, auths: [] as (string | null)[], bodies: [] as (string | null)[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text()
      rec.count += 1
      rec.auths.push(req.headers.get("authorization"))
      rec.bodies.push(body)
      return respond(req, body)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    count: () => rec.count,
    lastAuth: () => rec.auths.at(-1) ?? null,
    lastBody: () => rec.bodies.at(-1) ?? null,
    stop: () => server.stop(true),
  }
}

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-messaging" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()

  // The Slack fake: by channel/text it returns ok:true (echoing the auth header
  // to exercise redaction), an ok:false delivery failure, or an oversized body.
  const slack = startServer((_req, body) => {
    const parsed = JSON.parse(body) as { channel?: string; text?: string }
    if (parsed.channel === "#broken") return jsonResponse({ ok: false, error: "channel_not_found" })
    // Echo the auth header back so the credential-redaction check has something to
    // catch (a misbehaving provider that reflects the token into its response).
    return jsonResponse({
      ok: true,
      ts: "1700000000.000100",
      echo: _req.headers.get("authorization"),
    })
  })
  // The email fake: a normal {id} confirmation, or — for the bounded-capture case
  // — an oversized body that ECHOES the operator credential positioned so the
  // byte cap (2048) cuts THROUGH it. If the cap were applied before redaction, a
  // credential prefix would survive into the observation.
  const email = startServer((req, body) => {
    const parsed = JSON.parse(body) as { subject?: string }
    if (parsed.subject === "OVERSIZE") {
      const auth = req.headers.get("authorization") ?? ""
      // 2031 + "Bearer " (7) puts the boundary ~10 chars into the token.
      return new Response(`${"X".repeat(2031)}${auth}${"X".repeat(500)}`, { status: 200 })
    }
    return jsonResponse({ id: "email_probe_123" }, 200)
  })

  const observations: Observation[] = []
  const observationSink = async (obs: Observation): Promise<void> => {
    observations.push(obs)
  }
  // Three-valued gate: L4+ holds for human approval; below auto-approves.
  const policyGate: PolicyGate = async (action) => {
    if (action.contract.required_level >= 4) {
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

  try {
    registerMessagingTools({
      slack: {
        credential: CREDENTIAL,
        allowedChannels: ["#alerts", "#broken"],
        apiBaseUrl: slack.base,
        allowHttp: true,
      },
      email: {
        credential: { header: "Authorization", value: `Bearer ${TOKEN}` },
        endpoint: `${email.base}/emails`,
        from: OPERATOR_FROM,
        allowedRecipients: ["@company.com"],
        allowHttp: true,
        // A small cap so the 50 KiB body truncates while the tiny {id} does not.
        maxBytes: 2048,
      },
    })

    const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
      useStubsForTests: true,
    })
    const propose = (tool: string, inputs: unknown, contract: ActionContract) =>
      kernel.propose({
        intent: `probe ${tool}`,
        tool,
        inputs,
        contract,
        proposed_by: "probe.messaging",
      })
    const grant = (action: { id: string }, reqId: string) => ({
      kind: "granted" as const,
      action_id: action.id,
      request_id: reqId,
      approver_id: "probe.human",
    })
    const L4 = () => contractFor(4, "external", "irreversible")

    // ---- 1. L4 hold blocks the world --------------------------------------
    const held = await kernel.arbitrate(
      propose("slack.post", { channel: "#alerts", text: "build is green" }, L4()),
    )
    if (held.phase !== "pending_approval") {
      return {
        passed: false,
        details: `L4 hold FAILED: a slack.post proposed at L4 did not park at pending_approval (phase=${held.phase}).`,
      }
    }
    if (slack.count() !== 0) {
      return {
        passed: false,
        details:
          "L4 hold FAILED: the message reached the provider while only at pending_approval — a held egress action touched the world.",
      }
    }
    const sent = await kernel.execute(kernel.resolve(held, grant(held, "req-slack")))
    if (sent.phase !== "completed") {
      return {
        passed: false,
        details: `slack.post FAILED: the approved post did not complete (phase=${sent.phase}); audit: ${JSON.stringify(sent.audit.at(-1))}`,
      }
    }
    const sentBody = JSON.parse(slack.lastBody() ?? "{}") as { channel?: string; text?: string }
    if (
      slack.count() !== 1 ||
      sentBody.channel !== "#alerts" ||
      sentBody.text !== "build is green"
    ) {
      return {
        passed: false,
        details: `slack.post FAILED: the approved post did not deliver exactly once with the right channel/text (count=${slack.count()}, body=${slack.lastBody()}).`,
      }
    }

    // ---- 2. Destination pinning beats exfiltration ------------------------
    // 2a: a non-pinned Slack channel.
    const exfilChan = await kernel.arbitrate(
      propose("slack.post", { channel: "#secret-exfil", text: "stolen" }, L4()),
    )
    const exfilChanDone = await kernel.execute(
      kernel.resolve(exfilChan, grant(exfilChan, "req-ec")),
    )
    if (exfilChanDone.phase !== "failed") {
      return {
        passed: false,
        details: `channel pinning FAILED: an approved slack.post to a non-pinned channel did not end 'failed' (phase=${exfilChanDone.phase}).`,
      }
    }
    if (slack.count() !== 1) {
      return {
        passed: false,
        details: "channel pinning FAILED: the non-pinned channel reached the provider.",
      }
    }
    // 2b: a non-allowlisted email recipient.
    const exfilTo = await kernel.arbitrate(
      propose("email.send", { to: "attacker@evil.com", subject: "secrets", body: "..." }, L4()),
    )
    const exfilToDone = await kernel.execute(kernel.resolve(exfilTo, grant(exfilTo, "req-et")))
    if (exfilToDone.phase !== "failed") {
      return {
        passed: false,
        details: `recipient pinning FAILED: an approved email.send to a non-allowlisted recipient did not end 'failed' (phase=${exfilToDone.phase}).`,
      }
    }
    if (email.count() !== 0) {
      return {
        passed: false,
        details: "recipient pinning FAILED: the off-allowlist recipient reached the provider.",
      }
    }
    // 2b-2: a comma-separated recipient STRING cannot smuggle an off-allowlist
    // address past the per-recipient check (the domain check would otherwise see
    // only the last `@`'s domain while a provider splits on the comma).
    const commaInj = await kernel.arbitrate(
      propose(
        "email.send",
        { to: "attacker@evil.com, alice@company.com", subject: "x", body: "y" },
        L4(),
      ),
    )
    const commaInjDone = await kernel.execute(
      kernel.resolve(commaInj, grant(commaInj, "req-comma")),
    )
    if (commaInjDone.phase !== "failed") {
      return {
        passed: false,
        details: `multi-address bypass FAILED: an approved email.send with a comma-separated recipient string did not end 'failed' (phase=${commaInjDone.phase}).`,
      }
    }
    if (email.count() !== 0) {
      return {
        passed: false,
        details:
          "multi-address bypass FAILED: a comma-injected off-allowlist recipient reached the provider.",
      }
    }
    // 2c: an allowlisted (by domain) recipient lands — and the From is the operator's.
    const okEmail = await kernel.arbitrate(
      propose("email.send", { to: "alice@company.com", subject: "status", body: "all good" }, L4()),
    )
    const okEmailDone = await kernel.execute(kernel.resolve(okEmail, grant(okEmail, "req-em")))
    if (okEmailDone.phase !== "completed") {
      return {
        passed: false,
        details: `email.send FAILED: an approved send to an allowlisted recipient did not complete (phase=${okEmailDone.phase}); audit: ${JSON.stringify(okEmailDone.audit.at(-1))}`,
      }
    }
    const emailBody = JSON.parse(email.lastBody() ?? "{}") as { from?: string; to?: string[] }
    // ---- 3. Operator-fixed sender -----------------------------------------
    if (emailBody.from !== OPERATOR_FROM) {
      return {
        passed: false,
        details: `sender FAILED: the email did not carry the operator-fixed From (saw from='${emailBody.from}', expected '${OPERATOR_FROM}').`,
      }
    }

    // ---- 4. Credentials never leak ----------------------------------------
    // A fresh authenticated post to #alerts: the fake echoes the auth header into
    // its response, so the provider sees the real token — but it must not surface
    // in the recorded inputs or the emitted observation.
    const credHeld = await kernel.arbitrate(
      propose("slack.post", { channel: "#alerts", text: "whoami" }, L4()),
    )
    const credDone = await kernel.execute(kernel.resolve(credHeld, grant(credHeld, "req-cred")))
    if (credDone.phase !== "completed") {
      return {
        passed: false,
        details: `credential check FAILED: the authenticated post did not complete (phase=${credDone.phase}).`,
      }
    }
    if (slack.lastAuth() !== `Bearer ${TOKEN}`) {
      return {
        passed: false,
        details: `credential check FAILED: the operator credential was not injected on the request (provider saw '${slack.lastAuth()}').`,
      }
    }
    const credObs = observations.find((o) => o.source.invocation_id === credDone.id)
    if (!credObs) {
      return { passed: false, details: "credential check FAILED: no observation recorded." }
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

    // ---- 5. Delivery semantics (Slack ok:false → failed) ------------------
    const broken = await kernel.arbitrate(
      propose("slack.post", { channel: "#broken", text: "x" }, L4()),
    )
    const brokenDone = await kernel.execute(kernel.resolve(broken, grant(broken, "req-brk")))
    if (brokenDone.phase !== "failed") {
      return {
        passed: false,
        details: `delivery semantics FAILED: a Slack ok:false (HTTP 200) did not end 'failed' (phase=${brokenDone.phase}) — a rejected send was treated as delivered.`,
      }
    }

    // ---- 6. Bounded capture (incl. a credential straddling the cap) --------
    const big = await kernel.arbitrate(
      propose("email.send", { to: "alice@company.com", subject: "OVERSIZE", body: "b" }, L4()),
    )
    const bigDone = await kernel.execute(kernel.resolve(big, grant(big, "req-big")))
    const bigObs = observations.find((o) => o.source.invocation_id === bigDone.id)
    const bigOut = bigObs?.payload as
      | { response_truncated?: boolean; delivered?: boolean }
      | undefined
    if (bigDone.phase !== "completed" || bigOut?.response_truncated !== true) {
      return {
        passed: false,
        details: `bounded capture FAILED: an oversized provider response was not truncated at the cap (phase=${bigDone.phase}, out=${JSON.stringify(bigOut)}).`,
      }
    }
    // The oversized body echoed the credential straddling the byte cap; redaction
    // runs before the cap, so not even a prefix of the token may survive. Check a
    // 10-char prefix that the full-token check (sub-case 4) would NOT catch.
    if (JSON.stringify(bigObs).includes("xoxb-PROBE")) {
      return {
        passed: false,
        details:
          "bounded capture FAILED: a credential prefix survived truncation (the cap was applied before redaction).",
      }
    }

    return {
      passed: true,
      details:
        "Native messaging transport held every invariant through the Action Kernel: a slack.post proposed at L4 parked at pending_approval and reached no provider until approval, then delivered exactly once; an approved post to a non-pinned channel, an approved email to a non-allowlisted recipient, and an approved email whose comma-separated recipient string smuggled an off-allowlist address all ended 'failed' with the provider untouched, while an allowlisted (by domain) recipient landed carrying the operator-fixed From; the operator bot token reached the provider but never surfaced in the inputs or the (token-echoing) observation; a Slack ok:false ended 'failed' rather than a silent completed; and an oversized provider response that echoed the credential straddling the byte cap was captured to the cap and flagged truncated, with not even a token prefix surviving (redaction runs before the cap).",
    }
  } finally {
    for (const s of [slack, email]) s.stop()
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: messaging_adapter_enforces_egress_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
