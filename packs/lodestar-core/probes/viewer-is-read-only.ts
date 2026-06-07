#!/usr/bin/env bun
/**
 * Probe: viewer_is_read_only
 *
 * The Governing UI read-side viewer (`@qmilab/lodestar-viewer`,
 * `lodestar view`) is the open-core read surface. Its load-bearing
 * invariant is that it is *strictly read-only*: it must surface the
 * epistemic chain — including pending `approval.requested@1` items — while
 * exposing no way to mutate the event log. Resolving approvals is the
 * separate write-side surface; the proxy stays the sole event-log writer.
 *
 * This probe builds a fixture log containing one unresolved approval
 * request, serves it through the real viewer on an ephemeral loopback
 * port, and asserts:
 *
 *   A — the read API surfaces the session, the projected chain, the
 *       rendered markdown report, and the pending approval;
 *   B — there is NO mutation surface: a POST/PUT/DELETE against every
 *       plausible "resolve / write" path is refused (404/405);
 *   C — the bytes on disk are byte-for-byte identical before and after
 *       serving — the viewer never touched the log.
 *
 * If a future change adds a write route (e.g. an in-viewer "approve"
 * button), B trips. If a read path ever writes (a cache file, a snapshot),
 * C trips.
 */

import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  APPROVAL_REQUESTED_EVENT_TYPE,
  APPROVAL_REQUESTED_SCHEMA_VERSION,
} from "@qmilab/lodestar-core"
import { EventLogWriter, _resetEventLogStateForTests } from "@qmilab/lodestar-event-log"
import { startViewer } from "@qmilab/lodestar-viewer"

interface ProbeResult {
  passed: boolean
  details: string[]
}

const PROJECT = "viewer-probe"
const SESSION = "viewer-probe-session"
const ACTOR = "viewer-probe-actor"
const REQUEST_ID = "req-viewer-probe-1"
const ACTION_ID = "act-viewer-probe-1"

function hashTree(dir: string): string {
  const hash = createHash("sha256")
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        hash.update(full)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return hash.digest("hex")
}

async function seedLog(rootDir: string): Promise<void> {
  const writer = new EventLogWriter(rootDir)
  const now = "2026-06-04T12:00:00.000Z"
  const common = {
    schema_version: "1",
    project_id: PROJECT,
    session_id: SESSION,
    actor_id: ACTOR,
    timestamp: now,
    causal_parent_ids: [] as string[],
    versions: {},
  }
  // A couple of ordinary chain events so the session is non-trivial.
  await writer.append({
    ...common,
    id: "ev-obs-1",
    type: "observation.recorded",
    payload: { note: "fixture observation" },
  })
  await writer.append({
    ...common,
    id: "ev-decide-1",
    type: "decision.made",
    payload: { id: "d-1", intent: "fixture decision", decided_by: ACTOR, decided_at: now },
  })
  // The pending approval the viewer must surface read-only.
  await writer.append({
    ...common,
    id: "ev-approval-req-1",
    type: APPROVAL_REQUESTED_EVENT_TYPE,
    schema_version: APPROVAL_REQUESTED_SCHEMA_VERSION,
    payload: {
      request_id: REQUEST_ID,
      action_id: ACTION_ID,
      reason: "L4 push requires human approval",
      required_authority: { min_trust_baseline: 0.6 },
      requested_at: now,
    },
  })
}

async function run(): Promise<ProbeResult> {
  const details: string[] = []
  _resetEventLogStateForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "lodestar-probe-viewer-"))

  await seedLog(rootDir)
  const hashBefore = hashTree(rootDir)
  details.push(`seeded fixture log at ${rootDir} (hash ${hashBefore.slice(0, 12)})`)

  const viewer = await startViewer({ logRoot: rootDir, host: "127.0.0.1", port: 0 })
  details.push(`viewer up at ${viewer.url}`)
  const base = viewer.url

  try {
    // ── A — the read API surfaces the chain + the pending approval ────────
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      read_only?: boolean
    }
    if (health?.read_only !== true) {
      return fail(
        details,
        `health endpoint did not self-report read_only: ${JSON.stringify(health)}`,
      )
    }

    const indexHtml = await (await fetch(`${base}/`)).text()
    if (!indexHtml.includes("Governing UI")) {
      return fail(details, "GET / did not serve the SPA shell")
    }

    const sessions = await (await fetch(`${base}/api/sessions`)).json()
    const listed =
      Array.isArray(sessions) &&
      sessions.find((s: { session_id: string }) => s.session_id === SESSION)
    if (!listed) return fail(details, "GET /api/sessions did not list the fixture session")
    details.push(`A1: session listed with ${listed.event_count} events`)

    const chainRes = await fetch(`${base}/api/sessions/${PROJECT}/${SESSION}`)
    const chain = (await chainRes.json()) as {
      session_id?: string
      actor_ids?: unknown
      event_count?: number
    }
    if (chainRes.status !== 200 || chain?.session_id !== SESSION) {
      return fail(details, `GET chain projection failed: status ${chainRes.status}`)
    }
    if (!Array.isArray(chain.actor_ids)) {
      return fail(details, "chain projection did not serialise actor_ids as an array")
    }
    details.push(`A2: chain projection ok (event_count=${chain.event_count})`)

    const reportRes = await fetch(`${base}/api/sessions/${PROJECT}/${SESSION}/report`)
    const report = await reportRes.text()
    const ctype = reportRes.headers.get("content-type") ?? ""
    if (reportRes.status !== 200 || !ctype.includes("markdown") || !report.includes(SESSION)) {
      return fail(details, `GET report failed: status ${reportRes.status} ctype "${ctype}"`)
    }
    details.push("A3: markdown report rendered")

    const approvals = await (await fetch(`${base}/api/approvals`)).json()
    const pending =
      Array.isArray(approvals) &&
      approvals.find((a: { request_id: string }) => a.request_id === REQUEST_ID)
    if (!pending || pending.status !== "pending" || pending.action_id !== ACTION_ID) {
      return fail(details, `pending approval not surfaced: ${JSON.stringify(approvals)}`)
    }
    details.push("A4: pending approval surfaced read-only")

    // ── B — no mutation surface ───────────────────────────────────────────
    const mutationAttempts: Array<[string, string]> = [
      ["POST", "/api/approvals"],
      ["POST", `/api/approvals/${REQUEST_ID}/grant`],
      ["POST", `/api/approvals/${REQUEST_ID}/deny`],
      ["POST", `/api/sessions/${PROJECT}/${SESSION}/approve`],
      ["POST", `/api/sessions/${PROJECT}/${SESSION}/events`],
      ["PUT", `/api/sessions/${PROJECT}/${SESSION}`],
      ["DELETE", `/api/sessions/${PROJECT}/${SESSION}`],
      ["POST", "/api/sessions"],
    ]
    for (const [method, path] of mutationAttempts) {
      const res = await fetch(`${base}${path}`, { method })
      // Drain the body so the connection is released.
      await res.text().catch(() => "")
      if (res.status !== 404 && res.status !== 405) {
        return fail(
          details,
          `mutation surface exists: ${method} ${path} returned ${res.status} (expected 404/405)`,
        )
      }
    }
    details.push(`B: ${mutationAttempts.length} mutation attempts all refused (404/405)`)

    // ── C — the log is byte-for-byte unchanged ────────────────────────────
    const hashAfter = hashTree(rootDir)
    if (hashAfter !== hashBefore) {
      return fail(
        details,
        `event log changed while serving: ${hashBefore.slice(0, 12)} -> ${hashAfter.slice(0, 12)}`,
      )
    }
    details.push("C: event log byte-for-byte unchanged after serving")

    return {
      passed: true,
      details: [
        ...details,
        "Viewer is read-only: it surfaces the chain and pending approvals, exposes no mutation route, " +
          "and never writes the event log.",
      ],
    }
  } finally {
    await viewer.stop()
    rmSync(rootDir, { recursive: true, force: true })
  }
}

function fail(details: string[], message: string): ProbeResult {
  return { passed: false, details: [...details, `FAIL: ${message}`] }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: viewer_is_read_only")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
for (const line of result.details) console.log(`  ${line}`)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
