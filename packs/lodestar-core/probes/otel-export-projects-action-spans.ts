#!/usr/bin/env bun
/**
 * Probe: otel_export_projects_action_spans
 *
 * Structural round-trip for the OpenTelemetry exporter
 * (`@qmilab/lodestar-otel-exporter`, `lodestar otel export`). The exporter
 * projects a session into OTel GenAI spans following the action-centric
 * model: the session is the root `invoke_agent` span and each governed
 * Action is an `execute_tool` child span. Trace tools (Langfuse, Phoenix,
 * Jaeger, Tempo) only render the chain correctly if that span tree is
 * well-formed: valid hex ids, correct parent/child wiring, and statuses
 * that reflect the policy verdict.
 *
 * The probe seeds a session with a completed L0 read and a *rejected* L4
 * push, exports through the real read path (`exportSession`), and asserts:
 *
 *   A — one resourceSpans / scopeSpans, scoped to this package;
 *   B — a root `invoke_agent` span plus two `execute_tool` spans, with a
 *       32-hex trace id and 16-hex span ids;
 *   C — both action spans parent to the root; the root has no parent;
 *   D — the completed read is status OK / verdict allow; the rejected push
 *       is status ERROR / verdict deny / trust level 4; and a denied action
 *       makes the root span itself ERROR;
 *   D2 — the rejected push (which produces no Outcome) ends at its terminal
 *       audit timestamp, not collapsed to a zero-length span at proposal time;
 *   D3 — the root span encloses every child (its bounds widen past the
 *       envelope range to cover the push's later audit-time end);
 *   D4 — endpoint + out are mutually exclusive (throws, rather than POSTing
 *       and silently dropping the requested file);
 *   E — the export is idempotent: re-exporting the same log yields a
 *       byte-identical trace (deterministic ids).
 *
 * If the parent wiring breaks, C trips. If a policy denial stops being
 * legible as a failed span, D trips. If an outcome-less terminal state
 * collapses to proposal time, D2 trips. If a child escapes the root bounds,
 * D3 trips. If conflicting delivery targets are silently accepted, D4 trips.
 * If ids stop being deterministic, E trips.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Action, Outcome } from "@qmilab/lodestar-core"
import { EventLogWriter, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import { exportSession } from "@qmilab/lodestar-otel-exporter"

interface ProbeResult {
  passed: boolean
  details: string[]
}

const PROJECT = "otel-spans-probe"
const SESSION = "otel-spans-probe-session"
const ACTOR = "otel-spans-probe-actor"
const SCOPE = { level: "project" as const, identifier: PROJECT }

function action(
  id: string,
  tool: string,
  phase: Action["phase"],
  level: number,
  blast: Action["contract"]["blast_radius"],
  reversibility: Action["contract"]["reversibility"],
  proposedAt: string,
  // Terminal-transition time recorded in the audit trail (e.g. when a policy
  // rejection lands). Real guard/MCP rejections carry this but no Outcome.
  terminalAt?: string,
): Action {
  return {
    id,
    intent: `${tool} for the probe`,
    tool,
    inputs: { note: "probe input" },
    contract: {
      required_level: level,
      blast_radius: blast,
      reversibility,
      scope: SCOPE,
      data_sensitivity: "public",
      preconditions: [],
    },
    phase,
    audit: terminalAt ? [{ phase, by_actor_id: ACTOR, at: terminalAt }] : [],
    proposed_at: proposedAt,
    proposed_by: ACTOR,
  }
}

function outcome(actionId: string, observedAt: string): Outcome {
  return {
    id: `out-${actionId}`,
    action_id: actionId,
    result: "success",
    effect_observation_ids: [],
    side_effects_observed: [],
    duration_ms: 5,
    observed_at: observedAt,
  }
}

async function seedLog(rootDir: string): Promise<void> {
  const writer = new EventLogWriter(rootDir)
  const common = {
    schema_version: "1",
    project_id: PROJECT,
    session_id: SESSION,
    actor_id: ACTOR,
    causal_parent_ids: [] as string[],
    versions: {},
  }
  // A completed L0 read.
  await writer.append({
    ...common,
    id: "ev-act-read",
    type: "action.completed",
    timestamp: "2026-06-04T12:00:01.000Z",
    payload: action(
      "act-read",
      "fs.read",
      "completed",
      0,
      "self",
      "reversible",
      "2026-06-04T12:00:01.000Z",
    ),
  })
  await writer.append({
    ...common,
    id: "ev-out-read",
    type: "outcome.observed",
    timestamp: "2026-06-04T12:00:02.000Z",
    payload: outcome("act-read", "2026-06-04T12:00:02.000Z"),
  })
  // A rejected L4 push (the policy block).
  await writer.append({
    ...common,
    id: "ev-act-push",
    type: "action.rejected",
    timestamp: "2026-06-04T12:00:03.000Z",
    payload: action(
      "act-push",
      "git.push",
      "rejected",
      4,
      "external",
      "irreversible",
      "2026-06-04T12:00:03.000Z",
      // Policy denied it one second after proposal — no Outcome, audit only.
      "2026-06-04T12:00:04.000Z",
    ),
  })
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-otel-spans-"))

  try {
    await seedLog(rootDir)
    details.push("seeded fixture log: completed L0 read + rejected L4 push")

    const summary = await exportSession({
      sessionId: SESSION,
      projectId: PROJECT,
      logRoot: rootDir,
    })
    const doc = summary.otlp as OtlpDoc

    // A — one resourceSpans / scopeSpans, scoped to this package.
    if (doc.resourceSpans.length !== 1) {
      return fail(details, `expected 1 resourceSpans, got ${doc.resourceSpans.length}`)
    }
    const scopeSpans = doc.resourceSpans[0]?.scopeSpans ?? []
    if (scopeSpans.length !== 1) {
      return fail(details, `expected 1 scopeSpans, got ${scopeSpans.length}`)
    }
    if (scopeSpans[0]?.scope?.name !== "@qmilab/lodestar-otel-exporter") {
      return fail(details, `unexpected scope name: ${scopeSpans[0]?.scope?.name}`)
    }
    const spans = scopeSpans[0]?.spans ?? []
    details.push("A: one resourceSpans / scopeSpans, scoped to the exporter")

    // B — root + two action spans, with well-formed hex ids.
    if (spans.length !== 3) {
      return fail(details, `expected 3 spans (root + 2 actions), got ${spans.length}`)
    }
    const root = spans[0]
    if (!root || attr(root.attributes, "gen_ai.operation.name") !== "invoke_agent") {
      return fail(details, "first span is not the invoke_agent root")
    }
    const traceId = root.traceId
    if (!/^[0-9a-f]{32}$/.test(traceId)) {
      return fail(details, `trace id is not 32 hex chars: ${traceId}`)
    }
    for (const s of spans) {
      if (!/^[0-9a-f]{16}$/.test(s.spanId)) {
        return fail(details, `span id is not 16 hex chars: ${s.spanId}`)
      }
      if (s.traceId !== traceId) return fail(details, "spans disagree on trace id")
    }
    details.push(`B: root + 2 action spans; trace ${traceId.slice(0, 12)}… well-formed ids`)

    // C — both action spans parent to the root; root has no parent.
    if (root.parentSpanId !== undefined) {
      return fail(details, "root span unexpectedly has a parentSpanId")
    }
    const readSpan = findSpan(spans, "execute_tool fs.read")
    const pushSpan = findSpan(spans, "execute_tool git.push")
    if (!readSpan || !pushSpan) {
      return fail(details, "missing one of the execute_tool spans")
    }
    if (readSpan.parentSpanId !== root.spanId || pushSpan.parentSpanId !== root.spanId) {
      return fail(details, "action spans are not parented to the session root")
    }
    details.push("C: both execute_tool spans parent to the invoke_agent root")

    // D — statuses and verdicts reflect policy.
    if (readSpan.status.code !== 1) {
      return fail(details, `completed read should be status OK(1), got ${readSpan.status.code}`)
    }
    if (
      attr(readSpan.attributes, "gen_ai.tool.name") !== "fs.read" ||
      attr(readSpan.attributes, "gen_ai.tool.call.id") !== "act-read" ||
      attr(readSpan.attributes, "lodestar.policy.verdict") !== "allow"
    ) {
      return fail(details, "read span missing gen_ai.tool.* / allow verdict")
    }
    if (pushSpan.status.code !== 2) {
      return fail(details, `rejected push should be status ERROR(2), got ${pushSpan.status.code}`)
    }
    if (
      attr(pushSpan.attributes, "lodestar.policy.verdict") !== "deny" ||
      attr(pushSpan.attributes, "lodestar.trust.required_level") !== "4"
    ) {
      return fail(details, "push span missing deny verdict / L4 trust level")
    }
    if (root.status.code !== 2) {
      return fail(
        details,
        `root should be ERROR(2) when an action is denied, got ${root.status.code}`,
      )
    }
    details.push(
      "D: read=OK/allow, push=ERROR/deny/L4, root=ERROR (denial is a legible failed span)",
    )

    // D2 — span timing. The rejected push has NO Outcome; its end must come
    // from the terminal audit timestamp (proposal+1s), not collapse to the
    // proposal time, or the trace shows a misleading zero-length span.
    const pushStart = BigInt(pushSpan.startTimeUnixNano)
    const pushEnd = BigInt(pushSpan.endTimeUnixNano)
    const expectedEnd = BigInt(Date.parse("2026-06-04T12:00:04.000Z")) * 1_000_000n
    if (pushEnd <= pushStart) {
      return fail(details, "rejected push span is zero-length — end fell back to proposal time")
    }
    if (pushEnd !== expectedEnd) {
      return fail(details, "rejected push span end did not use the terminal audit timestamp")
    }
    // The completed read still ends at its Outcome time (later than start).
    if (BigInt(readSpan.endTimeUnixNano) <= BigInt(readSpan.startTimeUnixNano)) {
      return fail(details, "completed read span is zero-length")
    }
    details.push(
      "D2: rejected push span ends at the audit-recorded denial time (non-zero duration)",
    )

    // D3 — the root span must ENCLOSE every child. The push span ends at its
    // audit time (:04), one second past the last event envelope (:03), so a
    // root bounded only by envelope timestamps would let the child extend
    // past it. Assert root.start ≤ every child start and root.end ≥ every end.
    const rootStart = BigInt(root.startTimeUnixNano)
    const rootEnd = BigInt(root.endTimeUnixNano)
    for (const s of [readSpan, pushSpan]) {
      if (BigInt(s.startTimeUnixNano) < rootStart || BigInt(s.endTimeUnixNano) > rootEnd) {
        return fail(details, `child span ${s.name} extends outside the root span bounds`)
      }
    }
    if (rootEnd < expectedEnd) {
      return fail(details, "root span end did not widen to cover the push's audit-time end")
    }
    details.push("D3: root span encloses every child span (bounds widened past the envelope range)")

    // D4 — delivery targets are mutually exclusive: endpoint + out must throw
    // (fail fast, before any I/O), not POST and silently drop the file.
    let conflictThrew = false
    try {
      await exportSession({
        sessionId: SESSION,
        projectId: PROJECT,
        logRoot: rootDir,
        endpoint: "http://127.0.0.1:4318",
        out: "/tmp/lodestar-otel-probe-should-not-exist.json",
      })
    } catch {
      conflictThrew = true
    }
    if (!conflictThrew) {
      return fail(details, "endpoint + out did not throw — the requested file is silently dropped")
    }
    details.push("D4: endpoint + out are mutually exclusive (throws before any I/O)")

    // E — idempotent: re-export → byte-identical trace.
    const again = await exportSession({ sessionId: SESSION, projectId: PROJECT, logRoot: rootDir })
    if (again.trace_id !== summary.trace_id) {
      return fail(details, "trace id changed on re-export (non-deterministic)")
    }
    if (JSON.stringify(again.otlp) !== JSON.stringify(summary.otlp)) {
      return fail(details, "re-export produced different bytes (non-deterministic)")
    }
    details.push("E: re-export is byte-identical (deterministic ids)")

    return {
      passed: true,
      details: [
        ...details,
        "OTel export projects a well-formed action-centric span tree: an invoke_agent root, " +
          "execute_tool children, policy verdicts as span status, deterministic ids.",
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
interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: number; message?: string }
  attributes: OtlpKeyValue[]
}
interface OtlpDoc {
  resourceSpans: Array<{
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>
  }>
}

function findSpan(spans: OtlpSpan[], name: string): OtlpSpan | undefined {
  return spans.find((s) => s.name === name)
}

function attr(attributes: OtlpKeyValue[], key: string): string | boolean | undefined {
  const kv = attributes.find((a) => a.key === key)
  if (!kv) return undefined
  if (typeof kv.value.stringValue === "string") return kv.value.stringValue
  if (typeof kv.value.boolValue === "boolean") return kv.value.boolValue
  if (typeof kv.value.intValue === "string") return kv.value.intValue
  return undefined
}

function fail(details: string[], message: string): ProbeResult {
  return { passed: false, details: [...details, `FAIL: ${message}`] }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: otel_export_projects_action_spans")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
