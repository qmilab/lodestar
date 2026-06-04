#!/usr/bin/env bun
/**
 * Probe: otel_export_respects_sensitivity_ceiling
 *
 * The OpenTelemetry exporter (`@qmilab/lodestar-otel-exporter`,
 * `lodestar otel export`) ships the epistemic chain to external trace
 * tools (Langfuse, Phoenix, Jaeger, Tempo). Its load-bearing invariant is
 * the locked v0.2 export rule (`docs/architecture/v02-delta.md` §3):
 *
 *   "events above a configured sensitivity threshold are not exported by
 *    default; spans are emitted with metadata but payload is dropped or
 *    hashed."
 *
 * A `secret`-sensitivity belief — an API key, credential, PII fragment —
 * must never leave the boundary in an exported span, even though the
 * span's *structure* (that a secret belief existed and backed a decision)
 * should still be visible. This is the OTel analog of the Memory
 * Firewall's retrieval gate and the viewer's read-only invariant.
 *
 * The probe seeds a fixture log with one `secret` belief whose claim text
 * is a credential marker and one `public` belief whose claim text is an
 * innocuous marker, exports the session through the *real* read path
 * (`exportSession`), and asserts:
 *
 *   A — at the default `internal` ceiling, the secret marker appears
 *       NOWHERE in the exported OTLP JSON;
 *   B — the public marker DOES appear (the export works; it is not just
 *       redacting everything);
 *   C — the secret belief is still present structurally — a `belief.adopted`
 *       event carrying its id and `sensitivity=secret` — with a
 *       `*.statement.redacted` marker and the withheld content's payload
 *       hash in place of the text;
 *   D — raising the ceiling to `secret` makes the marker reappear, proving
 *       it is the gate withholding it, not an unrelated bug.
 *
 * If a future change routes claim content into a span without gating it,
 * A trips. If the gate over-redacts, B trips. If structural metadata is
 * dropped along with content, C trips.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Belief, Claim } from "@qmilab/lodestar-core"
import { EventLogWriter, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import { exportSession } from "@qmilab/lodestar-otel-exporter"

interface ProbeResult {
  passed: boolean
  details: string[]
}

const PROJECT = "otel-sensitivity-probe"
const SESSION = "otel-sensitivity-probe-session"
const ACTOR = "otel-sensitivity-probe-actor"
const NOW = "2026-06-04T12:00:00.000Z"

// Distinctive markers we can scan for verbatim in the exported bytes.
const SECRET_MARKER = "hunter2-SECRET-CREDENTIAL-MARKER-9f3a7c"
const PUBLIC_MARKER = "build-target-es2022-PUBLIC-MARKER"

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
    calibration_class: "otel.sensitivity::test",
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

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-otel-sens-"))

  try {
    await seedLog(rootDir)
    details.push(`seeded fixture log: 1 secret belief + 1 public belief at ${rootDir}`)

    // ── Export at the default `internal` ceiling ─────────────────────────
    const summary = await exportSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      sensitivityCeiling: "internal",
    })
    const json = JSON.stringify(summary.otlp)

    // A — the secret marker is nowhere in the exported bytes.
    if (json.includes(SECRET_MARKER)) {
      return fail(details, "secret claim content leaked into the exported OTLP JSON")
    }
    details.push("A: secret marker absent from the exported OTLP (gate held)")

    // B — the public marker is present (the export actually works).
    if (!json.includes(PUBLIC_MARKER)) {
      return fail(details, "public claim content missing — the exporter dropped everything")
    }
    details.push("B: public marker present (export is not over-redacting)")

    // C — the secret belief survives structurally, with a redaction marker.
    const spans = (summary.otlp as OtlpDoc).resourceSpans[0]?.scopeSpans[0]?.spans ?? []
    const root = spans[0]
    const secretEvent = (root?.events ?? []).find(
      (e) =>
        e.name === "belief.adopted" && attr(e.attributes, "lodestar.belief.id") === "belief-secret",
    )
    if (!secretEvent) {
      return fail(details, "secret belief's structural event vanished from the export")
    }
    if (attr(secretEvent.attributes, "lodestar.sensitivity") !== "secret") {
      return fail(details, "secret belief event lost its sensitivity metadata")
    }
    if (attr(secretEvent.attributes, "lodestar.belief.statement.redacted") !== true) {
      return fail(details, "secret belief statement was not marked redacted")
    }
    const hash = attr(secretEvent.attributes, "lodestar.belief.statement.payload_hash")
    if (typeof hash !== "string" || hash.length < 16) {
      return fail(details, "redaction marker did not carry the withheld content's payload hash")
    }
    if (summary.redacted_count < 1) {
      return fail(details, `redacted_count was ${summary.redacted_count}, expected ≥ 1`)
    }
    details.push(
      `C: secret belief present structurally; statement redacted with payload_hash ${hash.slice(0, 12)}… ` +
        `(redacted_count=${summary.redacted_count})`,
    )

    // D — raising the ceiling to `secret` makes the marker reappear.
    const open = await exportSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      sensitivityCeiling: "secret",
    })
    const openJson = JSON.stringify(open.otlp)
    if (!openJson.includes(SECRET_MARKER)) {
      return fail(
        details,
        "raising the ceiling to secret did NOT surface the content — gate is unconditional",
      )
    }
    if (open.redacted_count !== 0) {
      return fail(
        details,
        `at ceiling=secret, redacted_count was ${open.redacted_count}, expected 0`,
      )
    }
    details.push(
      "D: at ceiling=secret the marker reappears (the ceiling is the gate, redacted_count=0)",
    )

    // E — an invalid ceiling (a typo from a JS caller / env-derived config
    // that bypassed the type system) must THROW, not silently fail open and
    // export the secret. Without runtime validation, an unknown ceiling
    // ranks above every real level and nothing is ever withheld.
    const badOpts = {
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
      sensitivityCeiling: "internl",
    } as unknown as Parameters<typeof exportSession>[0]
    let threw = false
    try {
      await exportSession(badOpts)
    } catch {
      threw = true
    }
    if (!threw) {
      return fail(details, "an invalid sensitivity ceiling did NOT throw — the gate can fail open")
    }
    details.push("E: an invalid ceiling throws (the gate fails closed, not open)")

    return {
      passed: true,
      details: [
        ...details,
        "OTel export respects the sensitivity ceiling: secret content is withheld (structure + hash only) " +
          "by default, surfaced only when the ceiling is explicitly raised.",
      ],
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

// ── Minimal structural view of the OTLP doc, for assertions ────────────────

interface OtlpKeyValue {
  key: string
  value: Record<string, unknown>
}
interface OtlpEvent {
  name: string
  attributes: OtlpKeyValue[]
}
interface OtlpSpan {
  events: OtlpEvent[]
}
interface OtlpDoc {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>
}

/** Read a (string|bool) attribute value out of an OTLP KeyValue array. */
function attr(attributes: OtlpKeyValue[], key: string): string | boolean | undefined {
  const kv = attributes.find((a) => a.key === key)
  if (!kv) return undefined
  if (typeof kv.value.stringValue === "string") return kv.value.stringValue
  if (typeof kv.value.boolValue === "boolean") return kv.value.boolValue
  return undefined
}

function fail(details: string[], message: string): ProbeResult {
  return { passed: false, details: [...details, `FAIL: ${message}`] }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: otel_export_respects_sensitivity_ceiling")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
