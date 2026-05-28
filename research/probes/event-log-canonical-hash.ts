#!/usr/bin/env bun
/**
 * Probe: event_log_canonical_hash_round_trip
 *
 * The writer computes `canonicalHash(payload)` on the IN-MEMORY object
 * and stores that hash on the envelope. `JSON.stringify` is what writes
 * the envelope to disk. If those two serialisers disagree on any
 * payload value, the persisted hash never verifies against the
 * persisted payload.
 *
 * The historical foot-gun: `undefined` fields. `JSON.stringify` drops
 * them in objects; a naive canonicalHash that walks `Object.keys` would
 * see them. Same for `undefined` array elements (JSON.stringify renders
 * those as `null`).
 *
 * This probe locks the round-trip property: for several payload shapes
 * that exercise the rough edges, `canonicalHash(payload)` equals
 * `canonicalHash(JSON.parse(JSON.stringify(payload)))`. Any future
 * regression on either side trips this.
 *
 * Three scenarios:
 *   A — payload with a top-level `undefined` field (the
 *       firewall-audit case for non-reflection adopts/transitions).
 *   B — payload with `undefined` array elements (less likely in
 *       practice but the writer must mirror JSON.stringify's `null`
 *       substitution exactly).
 *   C — round-trip of a real firewall.belief.adopted-shaped payload
 *       with no causal_parent_ids set, end-to-end via EventLogWriter
 *       + EventLogReader.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
  canonicalHash,
} from "@qmilab/lodestar-event-log"

interface ProbeResult {
  passed: boolean
  details: string[]
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []

  // ── A — undefined top-level field ───────────────────────────────────────
  const payloadA: Record<string, unknown> = {
    belief_id: "b-1",
    by_authority: "auto_observation",
    causal_parent_ids: undefined,
    rationale_id: "r-1",
  }
  const hashAInMemory = canonicalHash(payloadA)
  const hashARoundTrip = canonicalHash(JSON.parse(JSON.stringify(payloadA)))
  details.push(`A: in-memory hash=${hashAInMemory.slice(0, 12)} round-trip hash=${hashARoundTrip.slice(0, 12)}`)
  if (hashAInMemory !== hashARoundTrip) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL A: canonicalHash diverges across the JSON.stringify boundary for a payload ` +
          `with a top-level undefined field. Persisted hash will not verify against persisted payload.`,
      ],
    }
  }

  // ── B — undefined array element ────────────────────────────────────────
  const payloadB = {
    items: ["a", undefined, "b"],
  }
  const hashBInMemory = canonicalHash(payloadB)
  const hashBRoundTrip = canonicalHash(JSON.parse(JSON.stringify(payloadB)))
  details.push(`B: in-memory hash=${hashBInMemory.slice(0, 12)} round-trip hash=${hashBRoundTrip.slice(0, 12)}`)
  if (hashBInMemory !== hashBRoundTrip) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL B: canonicalHash diverges for arrays containing undefined. ` +
          `JSON.stringify renders undefined elements as null; canonicalHash must mirror that.`,
      ],
    }
  }

  // ── C — end-to-end through writer + reader ─────────────────────────────
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-hash-"))
  const writer = new EventLogWriter(rootDir)
  const projectId = "probe-project"
  const sessionId = "probe-session"
  const payloadC = {
    kind: "belief.adopted",
    belief_id: crypto.randomUUID(),
    claim_id: crypto.randomUUID(),
    evidence_id: crypto.randomUUID(),
    rationale_id: crypto.randomUUID(),
    by_authority: "auto_observation",
    at: new Date().toISOString(),
    by_actor_id: "probe-actor",
    // Note: NO causal_parent_ids key. This is the firewall's
    // non-reflection path; if the previous bug regressed, this would
    // come in as `causal_parent_ids: undefined` instead and the hash
    // would diverge.
  }
  const envelope = await writer.append({
    id: crypto.randomUUID(),
    type: "firewall.belief.adopted",
    schema_version: "1",
    project_id: projectId,
    session_id: sessionId,
    actor_id: "probe-actor",
    timestamp: new Date().toISOString(),
    causal_parent_ids: [],
    payload: payloadC,
    versions: {},
  })
  const reader = new EventLogReader(rootDir)
  const readBack = await reader.readSession(projectId, sessionId)
  if (readBack.length !== 1) {
    return {
      passed: false,
      details: [...details, `FAIL C: expected 1 event read back, got ${readBack.length}`],
    }
  }
  const stored = readBack[0]!
  const recomputed = canonicalHash(stored.payload)
  details.push(`C: stored hash=${envelope.payload_hash.slice(0, 12)} recomputed=${recomputed.slice(0, 12)}`)
  if (stored.payload_hash !== recomputed) {
    return {
      passed: false,
      details: [
        ...details,
        `FAIL C: stored payload_hash does not verify against the persisted payload's canonical hash. ` +
          `This is the load-bearing replay-grade invariant — every envelope must round-trip.`,
      ],
    }
  }

  return {
    passed: true,
    details: [
      ...details,
      "All scenarios pass: canonicalHash mirrors JSON.stringify on undefined fields/elements, " +
        "and a written envelope's payload_hash verifies against the persisted payload after a read round-trip.",
    ],
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: event_log_canonical_hash_round_trip")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
