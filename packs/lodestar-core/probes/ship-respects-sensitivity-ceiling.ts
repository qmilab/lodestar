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
 *        rather than silently failing open.
 *
 * If a future change routes payload content onto the wire without gating it, A
 * (or T) trips. If the gate over-redacts, B trips. If structural metadata is
 * dropped with the content, C trips. If an invalid ceiling fails open, E trips.
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
      headers: { authorization: `Bearer ${TOKEN_MARKER}` },
      sensitivityCeiling: "internal",
    })
    const req = server.requests[server.requests.length - 1]
    if (!req) return fail(details, "capture server received no POST")
    const body = req.body

    // The summary's body must be exactly what crossed the wire.
    if (internal.ndjson !== body) {
      return fail(details, "shipped body differs from what the server received")
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
    details.push("T: token in header only (not in body); POST /v1/events as application/x-ndjson")

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
