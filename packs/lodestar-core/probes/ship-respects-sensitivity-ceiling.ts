#!/usr/bin/env bun
/**
 * Probe: ship_respects_sensitivity_ceiling
 *
 * The session shipper (`@qmilab/lodestar-ship`, `lodestar ship`) transfers a
 * session's raw envelopes to a remote collector. Its load-bearing invariant is
 * the locked v0.2 export rule (`docs/architecture/v02-delta.md` §3), applied
 * client-side BEFORE anything leaves the machine (ADR-0014):
 *
 *   "events above a configured sensitivity threshold are not exported by
 *    default; the record is emitted with metadata but payload is dropped or
 *    hashed."
 *
 * A `secret`-sensitivity belief — a credential, a PII fragment — must never
 * cross the wire, even though the record's *structure* (that a secret belief
 * existed, its id, type, seq, and the hash of the withheld content) should.
 *
 * The probe seeds a fixture log with one `secret` belief (credential marker)
 * and one `public` belief (innocuous marker), ships the session through the
 * *real* read+POST path (`shipSession`) to a LOCAL CAPTURE SERVER, inspects the
 * actual bytes that hit the wire, and asserts:
 *
 *   A  — at the default `internal` ceiling, the secret marker is NOWHERE in the
 *        POSTed NDJSON body;
 *   B  — the public marker IS in the body (the shipper works; it is not just
 *        redacting everything);
 *   T  — the bearer token is NOWHERE in the body, yet the server DID receive it
 *        as an Authorization header (the credential reaches the collector but
 *        never enters the wire content) — and the POST hit `/v1/events` with
 *        `application/x-ndjson`;
 *   C  — the secret belief survives structurally: a `redacted:true` wrapper with
 *        `payload_sensitivity=secret`, the envelope's payload replaced by the
 *        `{ "lodestar.redacted": true }` marker, and the original `payload_hash`
 *        preserved; the public belief ships `redacted:false`;
 *   D  — raising the ceiling to `secret` surfaces the marker again and drives
 *        `redacted_count` to 0 (the ceiling is the gate; the whole session is
 *        portable at the top clearance);
 *   E  — invalid ceilings supplied programmatically (a typo, "", null) all THROW
 *        rather than silently failing open;
 *   F  — a forged custom event labeled `sensitivity:"public"` (not a valid content
 *        record) FAILS CLOSED — its bytes never cross the wire, it ships redacted;
 *   G  — a schema SUPERSET (a valid public Claim plus an extra secret field Zod
 *        strips on parse) likewise FAILS CLOSED — exactness is enforced;
 *   H  — a non-2xx collector that echoes the request (shipped payloads + a bearer
 *        token) in its response body has NONE of it reach the thrown error — the
 *        error reports the HTTP status only;
 *   I  — a collector that responds with a redirect (307) is REFUSED, not followed:
 *        the session is never re-POSTed to the redirect target host.
 *
 * If a future change routes payload content onto the wire without gating it, A
 * (or T) trips. If the gate over-redacts, B trips. If structural metadata is
 * dropped with the content, C trips. If an invalid ceiling fails open, E trips.
 * If shape verification regresses, F or G trips; if the collector's response body
 * (echoed payloads or a credential) reaches the error, H trips.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Belief, Claim } from "@qmilab/lodestar-core"
import { EventLogWriter, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import {
  REDACTED_PAYLOAD,
  SHIP_WIRE_KIND,
  type ShipManifest,
  ShipManifestSchema,
  type ShipRecord,
  ShipRecordSchema,
  shipSession,
} from "@qmilab/lodestar-ship"

interface ProbeResult {
  passed: boolean
  details: string[]
}

const PROJECT = "ship-sensitivity-probe"
const SESSION = "ship-sensitivity-probe-session"
const ACTOR = "ship-sensitivity-probe-actor"
const NOW = "2026-06-11T12:00:00.000Z"

// Distinctive markers we can scan for verbatim in the bytes that hit the wire.
const SECRET_MARKER = "hunter2-SECRET-CREDENTIAL-MARKER-9f3a7c"
const PUBLIC_MARKER = "build-target-es2022-PUBLIC-MARKER"
const TOKEN_MARKER = "ship-bearer-TOKEN-MARKER-4e1b9a"
// A forged custom event labels itself `public` but is not a valid content
// record — it must NOT be trusted (fail closed).
const FORGED_MARKER = "forged-custom-event-SECRET-MARKER-b82d"
// A schema superset: a valid Claim labeled `public` PLUS an extra secret field
// that Zod strips on parse but the shipper would send verbatim.
const SUPERSET_MARKER = "superset-extra-field-SECRET-MARKER-3c5e"

const SCOPE = { level: "project" as const, identifier: PROJECT }

function claim(id: string, statement: string, sensitivity: Claim["sensitivity"]): Claim {
  return {
    id,
    statement,
    source_observation_ids: [`obs-for-${id}`],
    extraction_method: "tool",
    extracted_by: ACTOR,
    status: "accepted",
    scope: SCOPE,
    sensitivity,
    authors: [ACTOR],
    created_at: NOW,
  }
}

function belief(id: string, claimId: string, sensitivity: Belief["sensitivity"]): Belief {
  return {
    id,
    claim_id: claimId,
    confidence: 0.9,
    calibration_class: "ship.sensitivity::test",
    scope: SCOPE,
    sensitivity,
    authority: "observed",
    truth_status: "supported",
    retrieval_status: "normal",
    security_status: "clean",
    freshness_status: "fresh",
    observed_at: NOW,
    last_verified_at: NOW,
  }
}

async function seedLog(rootDir: string): Promise<void> {
  const writer = new EventLogWriter(rootDir)
  const common = {
    schema_version: "1",
    project_id: PROJECT,
    session_id: SESSION,
    actor_id: ACTOR,
    timestamp: NOW,
    causal_parent_ids: [] as string[],
    versions: {},
  }
  await writer.append({
    ...common,
    id: "ev-claim-secret",
    type: "claim.extracted",
    payload: claim("claim-secret", `DB password is ${SECRET_MARKER}`, "secret"),
  })
  await writer.append({
    ...common,
    id: "ev-belief-secret",
    type: "belief.adopted",
    payload: belief("belief-secret", "claim-secret", "secret"),
  })
  await writer.append({
    ...common,
    id: "ev-claim-public",
    type: "claim.extracted",
    payload: claim("claim-public", `The ${PUBLIC_MARKER} is set`, "public"),
  })
  await writer.append({
    ...common,
    id: "ev-belief-public",
    type: "belief.adopted",
    payload: belief("belief-public", "claim-public", "public"),
  })
  // A forged/custom event (the agent `ctx.emit` vector): a bare blob with a
  // trusted-LOOKING `sensitivity:"public"` field but NOT a valid content
  // record. The shipper must verify the shape and fail closed (Codex P1).
  await writer.append({
    ...common,
    id: "ev-forged",
    type: "agent.custom",
    payload: { sensitivity: "public", note: FORGED_MARKER },
  })
  // A schema SUPERSET: a fully valid public Claim plus an extra secret field.
  // Zod strips `leaked` on parse, so a naive "validates → trust" would declassify
  // it and the raw payload (with `leaked`) would ship at the internal ceiling.
  await writer.append({
    ...common,
    id: "ev-superset",
    type: "claim.extracted",
    payload: {
      ...claim("claim-superset", "an innocuous public statement", "public"),
      leaked: SUPERSET_MARKER,
    },
  })
}

// ── A local capture server: it records exactly what hit the wire ───────────

interface Captured {
  body: string
  auth: string | null
  contentType: string | null
  path: string
}

function startCaptureServer(): {
  url: string
  requests: Captured[]
  stop: () => void
} {
  const requests: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      requests.push({
        body,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        path: new URL(req.url).pathname,
      })
      return new Response("ok", { status: 200 })
    },
  })
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) }
}

function parseWire(body: string): { manifest: ShipManifest; records: ShipRecord[] } {
  const lines = body.split("\n").filter((l) => l.trim().length > 0)
  const first = lines[0]
  if (first === undefined) throw new Error("empty wire body")
  const manifest = ShipManifestSchema.parse(JSON.parse(first))
  const records = lines.slice(1).map((l) => ShipRecordSchema.parse(JSON.parse(l)))
  return { manifest, records }
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-ship-sens-"))
  const server = startCaptureServer()

  try {
    await seedLog(rootDir)
    details.push(`seeded fixture log: 1 secret belief + 1 public belief at ${rootDir}`)

    // ── Ship at the default `internal` ceiling, to the capture server ────────
    const internal = await shipSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      endpoint: server.url,
      // A caller content-type override — using DIFFERENT casing — must be IGNORED:
      // the mandated wire type wins and is the only content-type sent, not a
      // combined "text/plain, application/x-ndjson" (review C4 / Codex P2); T below.
      headers: { authorization: `Bearer ${TOKEN_MARKER}`, "Content-Type": "text/plain" },
      sensitivityCeiling: "internal",
    })
    const req = server.requests[server.requests.length - 1]
    if (!req) return fail(details, "capture server received no POST")
    const body = req.body

    // On endpoint delivery the body is NOT retained in the summary (it has
    // already been sent); the bytes that crossed the wire are captured as `body`.
    if (internal.ndjson !== undefined) {
      return fail(details, "summary retained the NDJSON body after endpoint delivery")
    }

    // A — the secret marker is nowhere in the POSTed bytes.
    if (body.includes(SECRET_MARKER)) {
      return fail(details, "secret claim/belief content crossed the wire")
    }
    details.push("A: secret marker absent from the POST body (gate held before egress)")

    // B — the public marker is present (the shipper actually works).
    if (!body.includes(PUBLIC_MARKER)) {
      return fail(details, "public content missing — the shipper dropped everything")
    }
    details.push("B: public marker present (not over-redacting)")

    // T — credential reaches the collector as a header, never as wire content;
    // and the transport shape is right.
    if (body.includes(TOKEN_MARKER)) {
      return fail(details, "bearer token leaked into the NDJSON body")
    }
    if (req.auth !== `Bearer ${TOKEN_MARKER}`) {
      return fail(details, `server did not receive the bearer token header (got ${req.auth})`)
    }
    if (req.path !== "/v1/events") {
      return fail(details, `POST hit ${req.path}, expected /v1/events`)
    }
    if (!(req.contentType ?? "").includes("application/x-ndjson")) {
      return fail(details, `content-type was ${req.contentType}, expected application/x-ndjson`)
    }
    if ((req.contentType ?? "").includes("text/plain")) {
      return fail(details, `caller content-type leaked into the request: ${req.contentType}`)
    }
    details.push(
      "T: token in header only (not in body); POST /v1/events as application/x-ndjson (cased override ignored)",
    )

    // C — the secret belief survives structurally with a redaction wrapper.
    const { manifest, records } = parseWire(body)
    if (manifest.kind !== SHIP_WIRE_KIND) {
      return fail(details, `manifest kind was ${manifest.kind}`)
    }
    if (manifest.redacted_count < 1) {
      return fail(details, `redacted_count was ${manifest.redacted_count}, expected ≥ 1`)
    }
    const secretRec = records.find((r) => r.envelope.id === "ev-belief-secret")
    if (!secretRec) return fail(details, "secret belief's record vanished from the wire")
    if (!secretRec.redacted) {
      return fail(details, "secret belief shipped unredacted at the internal ceiling")
    }
    if (secretRec.payload_sensitivity !== "secret") {
      return fail(details, "secret belief record lost its payload_sensitivity")
    }
    if (JSON.stringify(secretRec.envelope.payload) !== JSON.stringify(REDACTED_PAYLOAD)) {
      return fail(details, "secret belief payload was not replaced by the redaction marker")
    }
    if (
      typeof secretRec.envelope.payload_hash !== "string" ||
      secretRec.envelope.payload_hash.length < 16
    ) {
      return fail(details, "redacted record did not preserve the original payload_hash")
    }
    const publicRec = records.find((r) => r.envelope.id === "ev-belief-public")
    if (!publicRec || publicRec.redacted) {
      return fail(details, "public belief did not ship verbatim (redacted:false)")
    }
    details.push(
      `C: secret belief redacted:true (payload_sensitivity=secret, hash ${secretRec.envelope.payload_hash.slice(0, 12)}… preserved); public belief redacted:false`,
    )

    // F — a forged custom event labeled `sensitivity:"public"` must FAIL CLOSED:
    // it is not a valid content record, so its bytes must not cross the wire and
    // it must ship redacted. Without shape verification this leaks (Codex P1).
    if (body.includes(FORGED_MARKER)) {
      return fail(details, "forged custom event (fake sensitivity:public) leaked onto the wire")
    }
    const forgedRec = records.find((r) => r.envelope.id === "ev-forged")
    if (!forgedRec) return fail(details, "forged event's record vanished from the wire")
    if (!forgedRec.redacted || forgedRec.payload_sensitivity !== "secret") {
      return fail(details, "forged custom event was trusted at face value — it did not fail closed")
    }
    details.push("F: forged custom event with a fake sensitivity field fails closed (redacted)")

    // G — a schema SUPERSET (valid Claim + an extra secret field) must also fail
    // closed. Zod strips the extra key on parse, but the raw payload ships
    // verbatim, so trusting the parsed-subset's `public` would leak it (Codex P1).
    if (body.includes(SUPERSET_MARKER)) {
      return fail(details, "schema-superset payload leaked its extra secret field onto the wire")
    }
    const supersetRec = records.find((r) => r.envelope.id === "ev-superset")
    if (!supersetRec) return fail(details, "superset event's record vanished from the wire")
    if (!supersetRec.redacted || supersetRec.payload_sensitivity !== "secret") {
      return fail(details, "schema-superset payload was declassified — it did not fail closed")
    }
    details.push("G: schema-superset payload (valid Claim + extra field) fails closed (redacted)")

    // D — raising the ceiling to `secret` surfaces the marker; nothing redacted.
    const open = await shipSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      endpoint: server.url,
      sensitivityCeiling: "secret",
    })
    const openReq = server.requests[server.requests.length - 1]
    if (!openReq) return fail(details, "capture server received no second POST")
    if (!openReq.body.includes(SECRET_MARKER)) {
      return fail(details, "raising the ceiling to secret did NOT surface the content")
    }
    if (open.redacted_count !== 0) {
      return fail(
        details,
        `at ceiling=secret, redacted_count was ${open.redacted_count}, expected 0`,
      )
    }
    details.push(
      "D: at ceiling=secret the marker reappears and redacted_count=0 (session portable)",
    )

    // E — invalid ceilings from a JS/config caller must THROW, not fail open.
    const badCeilings: unknown[] = ["internl", "", null]
    for (const bad of badCeilings) {
      const badOpts = {
        sessionId: SESSION,
        projectId: PROJECT,
        logRoot: rootDir,
        sensitivityCeiling: bad,
      } as unknown as Parameters<typeof shipSession>[0]
      let threw = false
      try {
        await shipSession(badOpts)
      } catch {
        threw = true
      }
      if (!threw) {
        return fail(
          details,
          `an invalid sensitivity ceiling (${JSON.stringify(bad)}) did NOT throw — fails open`,
        )
      }
    }
    details.push("E: invalid ceilings (typo, empty string, null) all throw (the gate fails closed)")

    // H — the collector's response BODY must never reach the error/logs. An
    // untrusted collector can echo the submitted NDJSON (shipped payloads) AND a
    // bearer token back in a non-2xx body; the error reports the HTTP status
    // ONLY, so neither the echoed content nor the token can land in logs (Codex P2).
    const ECHO_MARKER = "echoed-response-body-MARKER-7f2c"
    const LONG_TOKEN = `longtok-${"x".repeat(240)}-end`
    const echo = Bun.serve({
      port: 0,
      fetch: () => new Response(`teapot ${ECHO_MARKER} token=${LONG_TOKEN}`, { status: 418 }),
    })
    try {
      let message = ""
      try {
        await shipSession({
          sessionId: SESSION,
          projectId: PROJECT,
          logRoot: rootDir,
          endpoint: `http://localhost:${echo.port}`,
          headers: { authorization: `Bearer ${LONG_TOKEN}` },
        })
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      if (message === "") return fail(details, "ship to a non-2xx collector did not throw")
      if (
        message.includes(ECHO_MARKER) ||
        message.includes(LONG_TOKEN) ||
        message.includes(LONG_TOKEN.slice(0, 60))
      ) {
        return fail(details, "the collector's echoed response body leaked into the error/logs")
      }
      if (!message.includes("418")) {
        return fail(details, `error did not report the HTTP status (got: ${message})`)
      }
      details.push(
        "H: a non-2xx collector's echoed response body never reaches the error (status only)",
      )
    } finally {
      echo.stop(true)
    }

    // I — a collector that REDIRECTS (307) must NOT be followed: auto-following
    // would re-POST the session payloads to the Location host (egress to an
    // unconfigured host). shipSession throws and the decoy receives nothing
    // (Codex P2). decoy hits tracked via an array length to dodge the
    // closure-mutated-counter literal-narrowing under strict tsc.
    const decoyRequests: string[] = []
    const decoy = Bun.serve({
      port: 0,
      fetch: async (r) => {
        decoyRequests.push(await r.text())
        return new Response("ok")
      },
    })
    const redirector = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://localhost:${decoy.port}/v1/events` },
        }),
    })
    try {
      let threw = false
      try {
        await shipSession({
          sessionId: SESSION,
          projectId: PROJECT,
          logRoot: rootDir,
          endpoint: `http://localhost:${redirector.port}`,
        })
      } catch {
        threw = true
      }
      if (!threw) return fail(details, "ship followed a redirect instead of refusing it")
      if (decoyRequests.length !== 0) {
        return fail(details, "ship re-POSTed the session to the redirect target host")
      }
      details.push("I: a redirecting collector is refused; the redirect target receives nothing")
    } finally {
      redirector.stop(true)
      decoy.stop(true)
    }

    return {
      passed: true,
      details: [
        ...details,
        "ship respects the sensitivity ceiling: above-ceiling content never crosses the wire " +
          "(structure + original hash only) and the credential stays out of the body.",
      ],
    }
  } finally {
    server.stop()
    rmSync(rootDir, { recursive: true, force: true })
  }
}

function fail(details: string[], message: string): ProbeResult {
  return { passed: false, details: [...details, `FAIL: ${message}`] }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: ship_respects_sensitivity_ceiling")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
