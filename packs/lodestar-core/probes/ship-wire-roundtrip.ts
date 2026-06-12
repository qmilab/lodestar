#!/usr/bin/env bun
/**
 * Probe: ship_wire_roundtrip
 *
 * The session shipper (`@qmilab/lodestar-ship`, `lodestar ship`) produces the
 * `lodestar.session_ship@1` NDJSON wire format (ADR-0014). This probe stands in
 * for the RECEIVER and pins the format's integrity contract end to end:
 *
 *   1 — the body parses: one manifest line (`ShipManifestSchema`) then one
 *       wrapper record per event (`ShipRecordSchema`); manifest counts match the
 *       records; `seq` is strictly increasing; the dedupe key
 *       `(project_id, session_id, seq)` is unique;
 *   2 — every `redacted:false` record RE-VERIFIES:
 *       `canonicalHash(envelope.payload) === envelope.payload_hash`;
 *   3 — every `redacted:true` record is FLAGGED, not hash-mismatched: its payload
 *       is the `{ "lodestar.redacted": true }` marker, it carries
 *       `payload_sensitivity`, and its `payload_hash` is the ORIGINAL — equal to
 *       `canonicalHash(the withheld payload)` and NOT to the hash of the marker.
 *       (A receiver that branches on the flag verifies; one that blindly hashed
 *       the marker would see a "mismatch" — proving redaction must be honoured.)
 *   4 — the gate FAILS CLOSED: a decision event (no `sensitivity`, no action
 *       contract) is treated as `secret` and ships redacted at the default
 *       `internal` ceiling;
 *   5 — the session is LOSSLESS + PORTABLE at `--sensitivity-ceiling secret`:
 *       a second ship redacts nothing and EVERY record's `payload_hash`
 *       re-verifies — the whole chain reconstructs on the far side.
 *
 * If redaction ever recomputes the hash of the marker (destroying the
 * commitment), 3 trips. If the wire mutates an envelope field, 2 trips. If the
 * fail-closed posture regresses and a decision leaks at `internal`, 4 trips.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Belief, Claim } from "@qmilab/lodestar-core"
import {
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"
import {
  REDACTED_PAYLOAD,
  SHIP_WIRE_KIND,
  SHIP_WIRE_VERSION,
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

const PROJECT = "ship-roundtrip-probe"
const SESSION = "ship-roundtrip-probe-session"
const ACTOR = "ship-roundtrip-probe-actor"
const NOW = "2026-06-11T12:00:00.000Z"

const SECRET_MARKER = "roundtrip-SECRET-MARKER-a17f"
const PUBLIC_MARKER = "roundtrip-PUBLIC-MARKER-c93e"
const OBS_MARKER = "roundtrip-OBS-MARKER-77b2"
const DECISION_MARKER = "roundtrip-DECISION-MARKER-5d04"

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
    calibration_class: "ship.roundtrip::test",
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

/**
 * Seed a mixed log and return the original payloads keyed by event id, so the
 * receiver-side checks can recompute `canonicalHash` and compare against the
 * (possibly redacted) record's preserved hash.
 *
 * At the default `internal` ceiling: public claim/belief + the public
 * observation ship verbatim; the secret claim/belief redact; the decision
 * event (no sensitivity → fail-closed `secret`) redacts.
 */
async function seedLog(rootDir: string): Promise<Map<string, unknown>> {
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
  const originals = new Map<string, unknown>()
  const events: Array<{ id: string; type: string; payload: unknown }> = [
    {
      id: "ev-claim-public",
      type: "claim.extracted",
      payload: claim("claim-public", `The ${PUBLIC_MARKER} is set`, "public"),
    },
    {
      id: "ev-belief-public",
      type: "belief.adopted",
      payload: belief("belief-public", "claim-public", "public"),
    },
    {
      id: "ev-claim-secret",
      type: "claim.extracted",
      payload: claim("claim-secret", `key is ${SECRET_MARKER}`, "secret"),
    },
    {
      id: "ev-belief-secret",
      type: "belief.adopted",
      payload: belief("belief-secret", "claim-secret", "secret"),
    },
    {
      id: "ev-observation",
      type: "observation.recorded",
      // A real, schema-valid Observation, so its `public` sensitivity is trusted
      // and it ships verbatim (a bare `{ sensitivity }` blob would fail closed).
      payload: {
        id: "obs-1",
        schema: "test.note@1",
        payload: { note: OBS_MARKER },
        source: { tool: "test", invocation_id: "inv-1", captured_at: NOW },
        context: { session_id: SESSION, project_id: PROJECT, actor_id: ACTOR },
        trust: "validated",
        sensitivity: "public",
      },
    },
    {
      // No `sensitivity`, no action contract → payloadContentSensitivity fails
      // closed to `secret`, so this redacts at the internal ceiling.
      id: "ev-decision",
      type: "decision.made",
      payload: {
        id: "decision-1",
        question: `Ship with ${DECISION_MARKER}?`,
        made_by: ACTOR,
        made_at: NOW,
      },
    },
  ]
  for (const e of events) {
    originals.set(e.id, e.payload)
    await writer.append({ ...common, id: e.id, type: e.type, payload: e.payload })
  }
  return originals
}

function parseWire(body: string): { manifest: ShipManifest; records: ShipRecord[] } {
  const lines = body.split("\n").filter((l) => l.trim().length > 0)
  const first = lines[0]
  if (first === undefined) throw new Error("empty wire body")
  const manifest = ShipManifestSchema.parse(JSON.parse(first))
  const records = lines.slice(1).map((l) => ShipRecordSchema.parse(JSON.parse(l)))
  return { manifest, records }
}

const MARKER_HASH = canonicalHash(REDACTED_PAYLOAD)

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-ship-rt-"))

  try {
    const originals = await seedLog(rootDir)
    details.push(`seeded fixture log: 6 events (3 public/obs, 2 secret, 1 decision) at ${rootDir}`)

    // ── Ship at the default `internal` ceiling (dry-run: returned ndjson) ─────
    const internal = await shipSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      sensitivityCeiling: "internal",
    })
    // A dry-run (no endpoint/out) must return the body for inspection.
    if (internal.ndjson === undefined) return fail(details, "dry-run ship returned no NDJSON body")
    const { manifest, records } = parseWire(internal.ndjson)

    // 1 — structural contract.
    if (manifest.kind !== SHIP_WIRE_KIND || manifest.version !== SHIP_WIRE_VERSION) {
      return fail(details, `manifest header wrong: ${manifest.kind}@${manifest.version}`)
    }
    if (manifest.event_count !== records.length) {
      return fail(
        details,
        `manifest event_count ${manifest.event_count} ≠ ${records.length} records`,
      )
    }
    const actualRedacted = records.filter((r) => r.redacted).length
    if (manifest.redacted_count !== actualRedacted) {
      return fail(details, `manifest redacted_count ${manifest.redacted_count} ≠ ${actualRedacted}`)
    }
    let prevSeq = Number.NEGATIVE_INFINITY
    const dedupe = new Set<string>()
    for (const r of records) {
      if (r.envelope.seq <= prevSeq) {
        return fail(details, `seq not strictly increasing at ${r.envelope.seq} (prev ${prevSeq})`)
      }
      prevSeq = r.envelope.seq
      dedupe.add(`${r.envelope.project_id}|${r.envelope.session_id}|${r.envelope.seq}`)
    }
    if (dedupe.size !== records.length) {
      return fail(details, "dedupe key (project,session,seq) is not unique across records")
    }
    details.push(
      `1: parsed manifest + ${records.length} records (${actualRedacted} redacted); seq strictly increasing; dedupe key unique`,
    )

    // 2 & 3 — per-record hash semantics.
    let verifiedUnredacted = 0
    for (const r of records) {
      const stored = r.envelope.payload_hash
      if (!r.redacted) {
        // 2 — re-verify the shipped payload against its hash.
        const recomputed = canonicalHash(r.envelope.payload)
        if (recomputed !== stored) {
          return fail(details, `unredacted ${r.envelope.id}: payload_hash does not re-verify`)
        }
        verifiedUnredacted++
      } else {
        // 3 — flagged, not mismatched.
        if (JSON.stringify(r.envelope.payload) !== JSON.stringify(REDACTED_PAYLOAD)) {
          return fail(details, `redacted ${r.envelope.id}: payload is not the redaction marker`)
        }
        if (stored === MARKER_HASH) {
          return fail(details, `redacted ${r.envelope.id}: hash was recomputed from the marker`)
        }
        const expected = canonicalHash(originals.get(r.envelope.id))
        if (stored !== expected) {
          return fail(details, `redacted ${r.envelope.id}: preserved hash ≠ original payload hash`)
        }
      }
    }
    if (verifiedUnredacted < 1) {
      return fail(details, "no unredacted records to verify — fixture or gate is wrong")
    }
    details.push(
      `2: ${verifiedUnredacted} unredacted payload_hashes re-verify; 3: redacted records keep the original hash (≠ marker hash), flagged not mismatched`,
    )

    // 4 — fail-closed: the decision event redacts at the internal ceiling.
    const decRec = records.find((r) => r.envelope.id === "ev-decision")
    if (!decRec || !decRec.redacted) {
      return fail(details, "decision event (unknown sensitivity) did NOT fail closed at internal")
    }
    if (internal.ndjson.includes(DECISION_MARKER)) {
      return fail(details, "fail-closed decision content still crossed the wire at internal")
    }
    details.push("4: decision event fails closed (redacted at the internal ceiling)")

    // 5 — lossless + portable at ceiling=secret: nothing redacted, all verify.
    const open = await shipSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      sensitivityCeiling: "secret",
    })
    if (open.ndjson === undefined)
      return fail(details, "dry-run ship (secret) returned no NDJSON body")
    const openWire = parseWire(open.ndjson)
    if (open.redacted_count !== 0 || openWire.records.some((r) => r.redacted)) {
      return fail(details, `at ceiling=secret, ${open.redacted_count} records still redacted`)
    }
    for (const r of openWire.records) {
      if (r.redacted) continue
      if (canonicalHash(r.envelope.payload) !== r.envelope.payload_hash) {
        return fail(details, `at ceiling=secret, ${r.envelope.id} payload_hash does not re-verify`)
      }
    }
    if (!open.ndjson.includes(DECISION_MARKER) || !open.ndjson.includes(SECRET_MARKER)) {
      return fail(details, "at ceiling=secret the full session content is not present")
    }
    details.push(
      "5: at ceiling=secret nothing redacts and every payload_hash re-verifies (lossless)",
    )

    return {
      passed: true,
      details: [
        ...details,
        "lodestar.session_ship@1 round-trips: unredacted hashes re-verify, redacted records are " +
          "flagged with the original hash preserved, and the whole session is recoverable at the top clearance.",
      ],
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

function fail(details: string[], message: string): ProbeResult {
  return { passed: false, details: [...details, `FAIL: ${message}`] }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: ship_wire_roundtrip")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
