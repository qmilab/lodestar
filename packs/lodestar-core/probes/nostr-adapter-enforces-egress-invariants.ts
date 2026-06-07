#!/usr/bin/env bun
/**
 * Probe: nostr_adapter_enforces_egress_invariants
 *
 * Locks the transport-governance invariants of the native Nostr tools
 * (`@qmilab/lodestar-adapter-nostr`: `nostr.publish` / `nostr.fetch`) by driving
 * the REAL adapter tools through the REAL Action Kernel
 * (propose → arbitrate → resolve → execute) against in-process fake relays
 * standing in for the network. `nostr.publish` is the second native egress after
 * `git.push` — on Nostr the *signing key* is the credential and signing is
 * in-process — so these are the things that MUST hold:
 *
 *   1. **L4 hold blocks the world.** A publish proposed at L4 parks at
 *      `pending_approval`, and the note does NOT reach the relay while it waits.
 *      Only after `resolve(granted)` + `execute` does it land. (Two-phase
 *      discipline on the egress action.)
 *   2. **Published event is authentic.** The event the relay received verifies
 *      (BIP-340 Schnorr) and its id is the canonical NIP-01 hash.
 *   3. **Relay pinning beats exfiltration.** An approved publish that targets a
 *      NON-pinned relay ends `failed`, and the decoy relay receives nothing — the
 *      agent cannot redirect a note to an attacker-controlled relay.
 *   4. **Credentials never leak.** The configured secret key is absent from the
 *      recorded action inputs AND the emitted observation (it is used only to sign
 *      in-process; only the pubkey + signature go on the wire).
 *   5. **Kind allowlist.** An approved publish of a non-allowlisted kind (5,
 *      deletion) ends `failed` and nothing is published.
 *   6. **NIP-42 AUTH carries through the kernel.** Against an auth-required relay,
 *      the approved publish authenticates with the SAME key (a kind-22242 event)
 *      and the note then lands.
 *   7. **Inbound is untrusted.** `nostr.fetch` returns events with a correct
 *      `signature_valid` flag — an authentic event is `true`, a forged one
 *      `false` — so a tampered event is never silently trusted. Relay pinning
 *      (an SSRF guard) applies to reads too: a fetch from a non-pinned relay ends
 *      `failed` and opens no socket.
 *
 * If any of these regress, a Lodestar-wrapped agent could publish to an attacker
 * relay, exfiltrate a signing key, publish unapproved event kinds, or treat a
 * forged event as authentic — so this probe is spec, not test scaffolding.
 */

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
} from "@qmilab/lodestar-action-kernel"
import {
  type NostrEvent,
  registerNostrTools,
  signEvent,
  verifyEvent,
} from "@qmilab/lodestar-adapter-nostr"
import type { ActionContract, BlastRadius, Observation, Reversibility } from "@qmilab/lodestar-core"

interface ProbeResult {
  passed: boolean
  details: string
}

// A distinctive but valid secp256k1 secret key (< curve order). It is the
// publish identity; it must NEVER surface in inputs or observations.
const CREDENTIAL_SENTINEL = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
// A separate throwaway key for the stored events the fetch test reads back.
// Buffer (a Uint8Array) avoids importing @noble directly into the probe, which
// runs from the repo root where the adapter's crypto deps are not resolvable.
const STORED_SK = Uint8Array.from(
  Buffer.from("0000000000000000000000000000000000000000000000000000000000000002", "hex"),
)

// -----------------------------------------------------------------------------
// In-process fake relay (Bun WebSocket server) speaking enough of NIP-01/42.
// -----------------------------------------------------------------------------

interface FakeRelay {
  url: string
  notes: unknown[]
  authEvents: unknown[]
  rawCount: () => number
  /** Read the note count through a function so TS doesn't narrow `notes.length`
   * to a literal across an `await kernel.execute(...)` it can't see mutate it. */
  noteCount: () => number
  stop: () => void
}

function startRelay(opts: { requireAuth?: boolean; storedEvents?: unknown[] } = {}): FakeRelay {
  const notes: unknown[] = []
  const authEvents: unknown[] = []
  let raw = 0
  const server = Bun.serve<{ authed: boolean }>({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { authed: false } })) return undefined
      return new Response("nostr relay", { status: 200 })
    },
    websocket: {
      open(ws) {
        if (opts.requireAuth) ws.send(JSON.stringify(["AUTH", "challenge-xyz"]))
      },
      message(ws, message) {
        raw += 1
        const frame = JSON.parse(String(message))
        const type = frame[0]
        if (type === "EVENT") {
          const ev = frame[1]
          if (opts.requireAuth && !ws.data.authed) {
            ws.send(JSON.stringify(["OK", ev.id, false, "auth-required: authenticate first"]))
            return
          }
          notes.push(ev)
          ws.send(JSON.stringify(["OK", ev.id, true, ""]))
        } else if (type === "AUTH") {
          const ev = frame[1]
          authEvents.push(ev)
          ws.data.authed = true
          ws.send(JSON.stringify(["OK", ev.id, true, ""]))
        } else if (type === "REQ") {
          const subId = frame[1]
          for (const e of opts.storedEvents ?? []) ws.send(JSON.stringify(["EVENT", subId, e]))
          ws.send(JSON.stringify(["EOSE", subId]))
        }
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${server.port}`,
    notes,
    authEvents,
    rawCount: () => raw,
    noteCount: () => notes.length,
    stop: () => server.stop(true),
  }
}

function contractFor(level: number, blast: BlastRadius, rev: Reversibility): ActionContract {
  return {
    required_level: level,
    blast_radius: blast,
    reversibility: rev,
    scope: { level: "project", identifier: "probe-nostr" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()

  // good: an authentic stored event; forged: same shape, tampered content.
  const goodStored = signEvent(STORED_SK, {
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: "authentic stored note",
  })
  const forgedStored: NostrEvent = { ...goodStored, content: "tampered after signing" }

  const relayHold = startRelay()
  const relayAuth = startRelay({ requireAuth: true })
  const relayDecoy = startRelay()
  const relayFetch = startRelay({ storedEvents: [goodStored, forgedStored, { id: "bad" }] })

  const observations: Observation[] = []
  const observationSink = async (obs: Observation): Promise<void> => {
    observations.push(obs)
  }
  // Three-valued gate: anything at L4+ holds for human approval; below auto-approves.
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
    registerNostrTools({
      publish: {
        relays: [relayHold.url, relayAuth.url],
        credential: { kind: "secret-key", key: CREDENTIAL_SENTINEL },
        allowedKinds: [1],
      },
      fetch: { relays: [relayFetch.url] },
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
        proposed_by: "probe.nostr",
      })

    const grant = (action: { id: string }, reqId: string) => ({
      kind: "granted" as const,
      action_id: action.id,
      request_id: reqId,
      approver_id: "probe.human",
    })

    // ---- 1. L4 hold blocks the world --------------------------------------
    const pubHeld = await kernel.arbitrate(
      propose(
        "nostr.publish",
        { content: "governed note", relays: [relayHold.url] },
        contractFor(4, "external", "irreversible"),
      ),
    )
    if (pubHeld.phase !== "pending_approval") {
      return {
        passed: false,
        details: `L4 hold FAILED: a publish proposed at L4 did not park at pending_approval (phase=${pubHeld.phase}).`,
      }
    }
    if (relayHold.noteCount() !== 0) {
      return {
        passed: false,
        details:
          "L4 hold FAILED: the note reached the relay while the publish was only at pending_approval — a held egress action touched the world.",
      }
    }

    // ---- 1b + 2. Approve → lands; the published event is authentic ---------
    const pubDone = await kernel.execute(kernel.resolve(pubHeld, grant(pubHeld, "req-pub")))
    if (pubDone.phase !== "completed") {
      return {
        passed: false,
        details: `approved publish did not complete (phase=${pubDone.phase}); audit: ${JSON.stringify(pubDone.audit.at(-1))}`,
      }
    }
    if (relayHold.noteCount() !== 1) {
      return {
        passed: false,
        details: `egress FAILED: the approved publish did not land exactly one note at the pinned relay (got ${relayHold.noteCount()}).`,
      }
    }
    if (!verifyEvent(relayHold.notes[0] as NostrEvent)) {
      return {
        passed: false,
        details:
          "authenticity FAILED: the event the relay received does not verify (bad id or signature).",
      }
    }

    // ---- 4. Credential never leaks ----------------------------------------
    const pubObs = observations.find((o) => o.source.invocation_id === pubDone.id)
    if (!pubObs) {
      return {
        passed: false,
        details: "credential check: no observation recorded for the publish.",
      }
    }
    if (JSON.stringify(pubObs).includes(CREDENTIAL_SENTINEL)) {
      return {
        passed: false,
        details: "credential leak FAILED: the secret key surfaced in the publish observation.",
      }
    }
    if (JSON.stringify(pubDone.inputs).includes(CREDENTIAL_SENTINEL)) {
      return {
        passed: false,
        details: "credential leak FAILED: the secret key surfaced in the recorded action inputs.",
      }
    }

    // ---- 3. Relay pinning beats exfiltration ------------------------------
    const exfilHeld = await kernel.arbitrate(
      propose(
        "nostr.publish",
        { content: "exfil", relays: [relayDecoy.url] },
        contractFor(4, "external", "irreversible"),
      ),
    )
    const exfilDone = await kernel.execute(kernel.resolve(exfilHeld, grant(exfilHeld, "req-exfil")))
    if (exfilDone.phase !== "failed") {
      return {
        passed: false,
        details: `relay pinning FAILED: an approved publish to a non-pinned relay did not end 'failed' (phase=${exfilDone.phase}).`,
      }
    }
    if (relayDecoy.rawCount() !== 0) {
      return {
        passed: false,
        details: "relay pinning FAILED: a non-pinned decoy relay received traffic from a publish.",
      }
    }

    // ---- 5. Kind allowlist ------------------------------------------------
    const kindHeld = await kernel.arbitrate(
      propose(
        "nostr.publish",
        { content: "delete everything", kind: 5, relays: [relayHold.url] },
        contractFor(4, "external", "irreversible"),
      ),
    )
    const kindDone = await kernel.execute(kernel.resolve(kindHeld, grant(kindHeld, "req-kind")))
    if (kindDone.phase !== "failed") {
      return {
        passed: false,
        details: `kind allowlist FAILED: an approved publish of a non-allowlisted kind (5) did not end 'failed' (phase=${kindDone.phase}).`,
      }
    }
    if (relayHold.noteCount() !== 1) {
      return {
        passed: false,
        details: `kind allowlist FAILED: a non-allowlisted kind was published anyway (relay note count is ${relayHold.noteCount()}, expected 1).`,
      }
    }

    // ---- 6. NIP-42 AUTH carries through the kernel ------------------------
    const authHeld = await kernel.arbitrate(
      propose(
        "nostr.publish",
        { content: "needs auth", relays: [relayAuth.url] },
        contractFor(4, "external", "irreversible"),
      ),
    )
    const authDone = await kernel.execute(kernel.resolve(authHeld, grant(authHeld, "req-auth")))
    if (authDone.phase !== "completed") {
      return {
        passed: false,
        details: `NIP-42 AUTH FAILED: an approved publish to an auth-required relay did not complete (phase=${authDone.phase}).`,
      }
    }
    const authEvent = relayAuth.authEvents[0] as { kind?: number } | undefined
    if (!authEvent || authEvent.kind !== 22242 || relayAuth.noteCount() !== 1) {
      return {
        passed: false,
        details: `NIP-42 AUTH FAILED: the relay did not see a kind-22242 auth event followed by the note (auth=${JSON.stringify(authEvent)}, notes=${relayAuth.noteCount()}).`,
      }
    }

    // ---- 7. Inbound is untrusted: fetch flags signatures ------------------
    const fetchDone = await kernel.execute(
      await kernel.arbitrate(propose("nostr.fetch", {}, contractFor(1, "project", "reversible"))),
    )
    if (fetchDone.phase !== "completed") {
      return {
        passed: false,
        details: `fetch FAILED: an L1 fetch from a pinned relay did not complete (phase=${fetchDone.phase}).`,
      }
    }
    const fetchObs = observations.find((o) => o.source.invocation_id === fetchDone.id)
    const fetchOut = fetchObs?.payload as
      | { events: { content: string; signature_valid: boolean }[]; malformed_count: number }
      | undefined
    if (!fetchOut) {
      return { passed: false, details: "fetch FAILED: no observation recorded for the fetch." }
    }
    const authentic = fetchOut.events.find((e) => e.content === "authentic stored note")
    const tampered = fetchOut.events.find((e) => e.content === "tampered after signing")
    if (!authentic?.signature_valid) {
      return {
        passed: false,
        details:
          "inbound trust FAILED: an authentic fetched event was not flagged signature_valid.",
      }
    }
    if (tampered === undefined || tampered.signature_valid !== false) {
      return {
        passed: false,
        details:
          "inbound trust FAILED: a forged fetched event was treated as authentic (signature_valid was not false).",
      }
    }
    if (fetchOut.malformed_count !== 1) {
      return {
        passed: false,
        details: `inbound trust FAILED: a malformed event was not dropped+counted (malformed_count=${fetchOut.malformed_count}, expected 1).`,
      }
    }

    // ---- 7b. Relay pinning (SSRF) on reads --------------------------------
    const ssrfDone = await kernel.execute(
      await kernel.arbitrate(
        propose(
          "nostr.fetch",
          { relays: ["ws://internal.invalid"] },
          contractFor(1, "project", "reversible"),
        ),
      ),
    )
    if (ssrfDone.phase !== "failed") {
      return {
        passed: false,
        details: `SSRF guard FAILED: a fetch from a non-pinned relay did not end 'failed' (phase=${ssrfDone.phase}).`,
      }
    }

    return {
      passed: true,
      details:
        "Native Nostr transport held every invariant through the Action Kernel: a publish proposed at L4 parked at pending_approval and no note reached the relay until approval; the approved note landed and verified (BIP-340); the secret key never surfaced in inputs or the observation; an approved publish to a non-pinned relay ended 'failed' and the decoy received nothing; an approved publish of a non-allowlisted kind (5) ended 'failed' and published nothing; an approved publish to an auth-required relay authenticated with a kind-22242 event (same key) and then landed; fetch flagged an authentic event signature_valid=true, a forged event signature_valid=false, and dropped+counted a malformed one; and a fetch from a non-pinned relay ended 'failed' (SSRF guard).",
    }
  } finally {
    for (const r of [relayHold, relayAuth, relayDecoy, relayFetch]) r.stop()
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: nostr_adapter_enforces_egress_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
