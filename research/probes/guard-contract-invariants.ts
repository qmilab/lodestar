#!/usr/bin/env bun
/**
 * Probe: guard_contract_invariants
 *
 * Combined regression coverage for three Codex-review findings on
 * guard.wrap's action-contract construction:
 *
 *   A. Tool-declared preconditions cannot be removed by caller
 *      overrides. A caller passing `contract: { preconditions: [] }`
 *      must NOT bypass the tool's `must_revalidate_at_execution`
 *      checks. The kernel still runs them at execution time.
 *
 *   B. `data_sensitivity` derives from the guarded session. A session
 *      configured with `default_sensitivity: "secret"` must propose
 *      actions tagged `data_sensitivity: "secret"`, so policy gates
 *      that check for secret data fire correctly.
 *
 *   C. Built-in extractor registration is idempotent. If a host
 *      already called `registerBuiltInExtractors()` (as several
 *      examples and probes do), `runGuarded` must not throw when it
 *      tries to register them itself.
 *
 * Each sub-case is asserted independently. The probe fails on the
 * first violation.
 */

import * as fs from "node:fs/promises"
import { z } from "zod"
import { registry } from "@orrery/core"
import { _resetToolsForTests, registerTool } from "@orrery/action-kernel"
import { registerBuiltInExtractors } from "@orrery/cognitive-core"
import {
  EventLogReader,
  EventLogWriter,
  _resetEventLogStateForTests,
} from "@orrery/event-log"
import {
  InMemoryBeliefStore,
  InMemoryClaimStore,
  InMemoryEvidenceStore,
  MemoryFirewall,
} from "@orrery/memory-firewall"
import { Mem0Adapter } from "@orrery/memory-firewall-mem0"
import {
  alwaysHoldsChecker,
  autoApprovePolicy,
  runGuarded,
  type PolicyGate,
} from "@orrery/guard"

interface ProbeResult {
  passed: boolean
  details: string
}

// ─── Shared fixture: a synthetic tool with a precondition ─────────────────

const OUT_KEY = "probe.contract@1"
if (!registry.has(OUT_KEY)) {
  registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
}

function registerProbeTool(execCounter: { count: number }): void {
  _resetToolsForTests()
  registerTool({
    name: "probe.contract_tool",
    inputs: z.object({ token: z.string() }),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: (inputs) => [
      {
        check_id: "probe.token_unchanged",
        parameters: { token: inputs.token },
        expected_at_approval: inputs.token,
        must_revalidate_at_execution: true,
      },
    ],
    execute: async () => {
      execCounter.count += 1
      return { ran: true }
    },
  })
}

// ─── Sub-case A: caller overrides MUST NOT drop tool preconditions ──────

async function caseA(): Promise<string | undefined> {
  const execs = { count: 0 }
  registerProbeTool(execs)
  let preconditionChecks = 0
  let rejection = ""

  await runGuarded(
    async (ctx) => {
      try {
        await ctx.callTool(
          "probe.contract_tool",
          { token: "abc" },
          {
            // Hostile override: caller wants no preconditions.
            contract: { preconditions: [] },
          },
        )
      } catch (err) {
        rejection = err instanceof Error ? err.message : String(err)
      }
    },
    {
      project_id: "probe-contract-A",
      actor_id: "tester",
      log_root: "/tmp/orrery-probe-contract-A",
      default_scope: { level: "project", identifier: "probe-contract-A" },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: async (check) => {
        preconditionChecks += 1
        return {
          holds: check.check_id !== "probe.token_unchanged",
          observed: "changed",
        }
      },
    },
  )

  if (preconditionChecks !== 1) {
    return (
      `[A] precondition_checker was invoked ${preconditionChecks} time(s); expected 1. ` +
      `Caller-supplied empty preconditions silently replaced the tool's declarations.`
    )
  }
  if (execs.count !== 0) {
    return (
      `[A] tool.execute ran ${execs.count} time(s); expected 0. ` +
      `Kernel should have rejected before execute.`
    )
  }
  if (!/precondition/i.test(rejection)) {
    return `[A] expected rejection mentioning 'precondition'; got: ${rejection || "(no rejection)"}`
  }
  return undefined
}

// ─── Sub-case B: secret session → secret action sensitivity AND
//                 secret observation sensitivity ───────────────────────

async function caseB(): Promise<string | undefined> {
  const execs = { count: 0 }
  registerProbeTool(execs)
  let seenSensitivity = ""

  const recordingPolicy: PolicyGate = async (action) => {
    seenSensitivity = action.contract.data_sensitivity
    return {
      approved: true,
      reason: `recorded ${action.contract.data_sensitivity}`,
      approver_id: "recorder",
    }
  }

  const run = await runGuarded(
    async (ctx) => {
      return ctx.callTool("probe.contract_tool", { token: "ok" })
    },
    {
      project_id: "probe-contract-B",
      actor_id: "tester",
      log_root: "/tmp/orrery-probe-contract-B",
      default_scope: { level: "project", identifier: "probe-contract-B" },
      default_sensitivity: "secret",
      policy_gate: recordingPolicy,
      precondition_checker: alwaysHoldsChecker,
    },
  )

  if (seenSensitivity !== "secret") {
    return (
      `[B] policy_gate saw data_sensitivity='${seenSensitivity}'; expected 'secret'. ` +
      `Guard is silently downgrading a secret session to a private action.`
    )
  }

  // The kernel hardcodes observation.sensitivity to 'internal'; Guard
  // must lift it to at least the session's default_sensitivity, or a
  // secret session's tool observations leak into the event log
  // labelled 'internal'.
  const observationSensitivity = (run.result as { observation: { sensitivity: string } })
    .observation.sensitivity
  if (observationSensitivity !== "secret") {
    return (
      `[B] callTool returned observation.sensitivity='${observationSensitivity}'; expected 'secret'. ` +
      `Guard is not lifting sensitive observations from the kernel's default 'internal'.`
    )
  }
  return undefined
}

// ─── Sub-case C: extractor registration is idempotent ─────────────────────

async function caseC(): Promise<string | undefined> {
  // Pre-register before runGuarded sees the session — mirrors what
  // examples/telenotes-governed-dev does directly. If Guard is not
  // idempotent it will throw here on the duplicate schema_key.
  try {
    registerBuiltInExtractors()
  } catch {
    // Another sub-case may have already triggered the registration.
    // That's fine — it means the registry was non-empty before this
    // probe even ran, which is still the conditions we want to test.
  }

  const execs = { count: 0 }
  registerProbeTool(execs)

  try {
    await runGuarded(
      async (ctx) => {
        await ctx.callTool("probe.contract_tool", { token: "ok" })
      },
      {
        project_id: "probe-contract-C",
        actor_id: "tester",
        log_root: "/tmp/orrery-probe-contract-C",
        default_scope: { level: "project", identifier: "probe-contract-C" },
        default_sensitivity: "internal",
        policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
        precondition_checker: alwaysHoldsChecker,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/already registered|schema_key/i.test(message)) {
      return (
        `[C] runGuarded threw when built-in extractors were pre-registered: ${message}. ` +
        `Guard must tolerate extractors that another module already registered.`
      )
    }
    return `[C] unexpected error: ${message}`
  }

  if (execs.count !== 1) {
    return `[C] expected 1 tool.execute call; got ${execs.count}`
  }
  return undefined
}

// ─── Sub-case D: caller cannot lower contract.data_sensitivity ────────────

async function caseD(): Promise<string | undefined> {
  const execs = { count: 0 }
  registerProbeTool(execs)
  let seenSensitivity = ""

  const recordingPolicy: PolicyGate = async (action) => {
    seenSensitivity = action.contract.data_sensitivity
    return {
      approved: true,
      reason: `recorded ${action.contract.data_sensitivity}`,
      approver_id: "recorder",
    }
  }

  await runGuarded(
    async (ctx) => {
      // Hostile override: caller tries to understate sensitivity in a
      // secret session.
      await ctx.callTool(
        "probe.contract_tool",
        { token: "ok" },
        { contract: { data_sensitivity: "public" } },
      )
    },
    {
      project_id: "probe-contract-D",
      actor_id: "tester",
      log_root: "/tmp/orrery-probe-contract-D",
      default_scope: { level: "project", identifier: "probe-contract-D" },
      default_sensitivity: "secret",
      policy_gate: recordingPolicy,
      precondition_checker: alwaysHoldsChecker,
    },
  )

  if (seenSensitivity !== "secret") {
    return (
      `[D] policy_gate saw data_sensitivity='${seenSensitivity}' after a caller passed ` +
      `'public' in a secret session. The override should be clamped to the session floor.`
    )
  }
  return undefined
}

// ─── Sub-case E: rapid successive runGuarded → distinct session_ids ───────

async function caseE(): Promise<string | undefined> {
  const execs = { count: 0 }
  registerProbeTool(execs)

  // Kick off N runs in parallel with no session_id supplied. Even
  // millisecond-coincident invocations must end up with distinct ids
  // (otherwise `orrery report` collapses them into one slice).
  const N = 10
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      runGuarded(
        async (ctx) => ctx.session_id,
        {
          project_id: `probe-contract-E-${i}`,
          actor_id: "tester",
          log_root: "/tmp/orrery-probe-contract-E",
          default_scope: { level: "project", identifier: `probe-contract-E-${i}` },
          default_sensitivity: "internal",
          policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
          precondition_checker: alwaysHoldsChecker,
        },
      ),
    ),
  )

  const ids = new Set(runs.map((r) => r.session_id))
  if (ids.size !== N) {
    return (
      `[E] ${N} concurrent runGuarded calls produced only ${ids.size} distinct ` +
      `session_id(s). Date.now()-based defaults can collide; use a UUID.`
    )
  }
  return undefined
}

// ─── Sub-case F: tool.execute receives the guarded session/project ─────────

async function caseF(): Promise<string | undefined> {
  _resetToolsForTests()

  let captured: { session_id?: string; project_id?: string } = {}
  registerTool({
    name: "probe.context_capture",
    inputs: z.object({}),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async (_inputs, ctx) => {
      captured = { session_id: ctx.session_id, project_id: ctx.project_id }
      return { ran: true }
    },
  })

  await runGuarded(
    async (ctx) => {
      await ctx.callTool("probe.context_capture", {})
    },
    {
      project_id: "probe-contract-F",
      actor_id: "tester",
      session_id: "session-probe-F-fixed",
      log_root: "/tmp/orrery-probe-contract-F",
      default_scope: { level: "project", identifier: "probe-contract-F" },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  if (captured.session_id !== "session-probe-F-fixed") {
    return (
      `[F] tool.execute saw ctx.session_id='${captured.session_id}'; ` +
      `expected 'session-probe-F-fixed'. The kernel is still handing tools its stub context.`
    )
  }
  if (captured.project_id !== "probe-contract-F") {
    return (
      `[F] tool.execute saw ctx.project_id='${captured.project_id}'; expected 'probe-contract-F'.`
    )
  }
  return undefined
}

// ─── Sub-case G: event-log seq is monotonic across runGuarded calls ────────

async function caseG(): Promise<string | undefined> {
  const execs = { count: 0 }
  registerProbeTool(execs)

  const LOG_ROOT = "/tmp/orrery-probe-contract-G"
  const PROJECT_ID = "probe-contract-G"
  // Start from a clean slate so the assertion is unambiguous.
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  const sharedConfig = {
    project_id: PROJECT_ID,
    actor_id: "tester",
    log_root: LOG_ROOT,
    default_scope: { level: "project" as const, identifier: PROJECT_ID },
    default_sensitivity: "internal" as const,
    policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
    precondition_checker: alwaysHoldsChecker,
  }

  // Two sequential runGuarded calls for the same project. Each starts
  // a fresh writer; without the hydrate fix the second one would
  // restart at seq=0 and overwrite the first session's sequence range.
  await runGuarded(async (ctx) => {
    await ctx.callTool("probe.contract_tool", { token: "ok" })
  }, sharedConfig)
  await runGuarded(async (ctx) => {
    await ctx.callTool("probe.contract_tool", { token: "ok" })
  }, sharedConfig)

  // Read the combined log and assert all seq values are distinct.
  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readAll(PROJECT_ID)
  const seen = new Map<number, number>()
  for (const e of events) {
    seen.set(e.seq, (seen.get(e.seq) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()].filter(([_, c]) => c > 1)
  if (duplicates.length > 0) {
    const sample = duplicates.slice(0, 3).map(([s, c]) => `seq=${s}×${c}`).join(", ")
    return (
      `[G] event log has duplicate seq values across runGuarded calls: ${sample}. ` +
      `EventLogWriter must hydrate from existing log before writing.`
    )
  }
  // Also sanity-check monotonic increasing order in read result.
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]
    const curr = events[i]
    if (prev && curr && prev.seq >= curr.seq) {
      return `[G] events out of seq order: ${prev.seq} >= ${curr.seq} at index ${i}`
    }
  }
  return undefined
}

// ─── Sub-case H: autoApprovePolicy rejects invalid ceilings ──────────────

function caseH(): string | undefined {
  // TypeScript narrows `auto_approve_up_to` to 0..4, but a JS caller
  // (or a config cast from `unknown`) can sneak through. Without the
  // construction-time check, a ceiling of 5 would auto-approve every
  // L0..L4 action; the runtime check at the gate's call site only
  // catches the L5 action itself, not the broken ceiling.
  let threw = false
  try {
    // biome-ignore lint/suspicious/noExplicitAny: probing invalid input
    autoApprovePolicy({ auto_approve_up_to: 5 as any, approver_id: "p" })
  } catch (err) {
    threw = true
    if (
      !/auto_approve_up_to|L5|prohibited/i.test(
        err instanceof Error ? err.message : String(err),
      )
    ) {
      return `[H] autoApprovePolicy threw on ceiling=5 but the error message did not mention the invalid ceiling: ${String(err)}`
    }
  }
  if (!threw) {
    return "[H] autoApprovePolicy accepted auto_approve_up_to=5 (must reject; L5 is prohibited)"
  }
  return undefined
}

// ─── Sub-case I: ingestObservation rewrites context + lifts sensitivity ───

async function caseI(): Promise<string | undefined> {
  registerProbeTool({ count: 0 }) // ensure registry is non-empty
  let observed: { sensitivity?: string; context?: { session_id?: string; project_id?: string } } = {}

  // Clean the log dir so we read only this run's events (no chance of
  // matching an `observation.recorded` event written by a previous run
  // when the fix was in place).
  await fs.rm("/tmp/orrery-probe-contract-I", { recursive: true, force: true }).catch(() => {})

  await runGuarded(
    async (ctx) => {
      const externalObs: import("@orrery/core").Observation = {
        id: crypto.randomUUID(),
        // Schema doesn't need an extractor for this assertion — we
        // only care about the recorded event, not extracted claims.
        schema: "probe.contract@1",
        payload: { ran: true },
        source: {
          tool: "external.feed",
          invocation_id: crypto.randomUUID(),
          captured_at: new Date().toISOString(),
        },
        // Foreign context + low sensitivity — simulates copying an
        // observation in from a webhook or another agent.
        context: {
          session_id: "foreign-session",
          project_id: "foreign-project",
          actor_id: "foreign-actor",
        },
        trust: "validated",
        sensitivity: "internal",
      }
      // Record what ingestObservation forwarded to the cognitive
      // core (which is what lands in the event log).
      const result = await ctx.ingestObservation(externalObs)
      void result
    },
    {
      project_id: "probe-contract-I",
      actor_id: "tester",
      session_id: "session-probe-I",
      log_root: "/tmp/orrery-probe-contract-I",
      default_scope: { level: "project", identifier: "probe-contract-I" },
      default_sensitivity: "secret",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  // Read the event log and inspect the observation.recorded payload.
  const reader = new EventLogReader("/tmp/orrery-probe-contract-I")
  const events = await reader.readSession("probe-contract-I", "session-probe-I")
  const obsEvent = events.find((e) => e.type === "observation.recorded")
  if (!obsEvent) {
    return "[I] no observation.recorded event was written"
  }
  const payload = obsEvent.payload as {
    sensitivity?: string
    context?: { session_id?: string; project_id?: string }
  }
  observed = { sensitivity: payload.sensitivity, context: payload.context }

  if (observed.context?.session_id !== "session-probe-I") {
    return (
      `[I] observation.recorded.context.session_id='${observed.context?.session_id}'; ` +
      `expected 'session-probe-I'. Manual ingestObservation should rewrite context like callTool.`
    )
  }
  if (observed.context?.project_id !== "probe-contract-I") {
    return `[I] observation.recorded.context.project_id='${observed.context?.project_id}'; expected 'probe-contract-I'.`
  }
  if (observed.sensitivity !== "secret") {
    return (
      `[I] observation.recorded.sensitivity='${observed.sensitivity}'; expected 'secret'. ` +
      `ingestObservation must lift sensitivity to the session floor.`
    )
  }
  return undefined
}

// ─── Sub-case J: mem0 adapter tolerates malformed records ─────────────────

async function caseJ(): Promise<string | undefined> {
  const claims = new InMemoryClaimStore()
  const beliefs = new InMemoryBeliefStore()
  const evidence = new InMemoryEvidenceStore()
  const firewall = new MemoryFirewall(claims, beliefs, evidence, async () => {})
  const adapter = new Mem0Adapter(firewall, evidence)

  const result = await adapter.importMemories(
    {
      source: "mem0",
      memories: [
        { id: "ok-1", memory: "valid record" },
        { id: "bad-2" }, // missing `memory` — should be rejected per-record
        { id: "ok-3", memory: "another valid record" },
      ],
    },
    {
      scope: { level: "project", identifier: "probe-contract-J" },
      sensitivity: "internal",
      source_actor_id: "probe",
      trust_baseline: 0.5,
    },
  )

  if (result.imported_count !== 2) {
    return (
      `[J] expected 2 imported records around 1 bad record; got imported=${result.imported_count}, ` +
      `rejected=${result.rejected_count}. Adapter must validate the envelope only and safeParse each record.`
    )
  }
  if (result.rejected_count !== 1) {
    return `[J] expected 1 rejected record; got ${result.rejected_count}`
  }
  const rejection = result.rejection_reasons[0]
  if (!rejection || rejection.record_index !== 1) {
    return `[J] rejection_reasons did not point at index 1: ${JSON.stringify(result.rejection_reasons)}`
  }
  return undefined
}

// ─── Sub-case K: execution-time rejections emit action.rejected ────────────

async function caseK(): Promise<string | undefined> {
  _resetToolsForTests()

  const OUT = "probe.k_out@1"
  if (!registry.has(OUT)) {
    registry.register(OUT, z.object({ ran: z.boolean() }))
  }

  // Tool publishes a precondition that the host checker will say
  // "no longer holds" → kernel.execute returns phase='rejected'.
  registerTool({
    name: "probe.k_revalidation_tool",
    inputs: z.object({ token: z.string() }),
    output_schema_key: OUT,
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: (inputs) => [
      {
        check_id: "probe.k_token_unchanged",
        parameters: { token: inputs.token },
        expected_at_approval: inputs.token,
        must_revalidate_at_execution: true,
      },
    ],
    execute: async () => ({ ran: true }),
  })

  const LOG_ROOT = "/tmp/orrery-probe-contract-K"
  const SESSION = "session-probe-K"
  const PROJECT = "probe-contract-K"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  await runGuarded(
    async (ctx) => {
      try {
        await ctx.callTool("probe.k_revalidation_tool", { token: "abc" })
      } catch {
        // Expected — the kernel rejects on revalidation.
      }
    },
    {
      project_id: PROJECT,
      actor_id: "tester",
      session_id: SESSION,
      log_root: LOG_ROOT,
      default_scope: { level: "project", identifier: PROJECT },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: async (check) => ({
        holds: check.check_id !== "probe.k_token_unchanged",
        observed: "changed-value",
      }),
    },
  )

  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readSession(PROJECT, SESSION)
  const finalAction = events
    .filter((e) => e.type.startsWith("action.") && e.type !== "action.proposed" && e.type !== "action.approved")
    .pop()
  if (!finalAction) {
    return "[K] no terminal action.* event was written"
  }
  if (finalAction.type !== "action.rejected") {
    return (
      `[K] execution-time precondition rejection landed as event type '${finalAction.type}'; ` +
      `expected 'action.rejected'. Consumers filtering by event type would conflate ` +
      `TOCTOU rejections with tool failures.`
    )
  }
  return undefined
}

// ─── Sub-case L: `orrery probe` works from any working directory ──────────

async function caseL(): Promise<string | undefined> {
  // Run the CLI from a directory other than the repo root. The probe
  // file lookup must be relative to the CLI package location, not the
  // caller's CWD.
  const repoRoot = process.cwd()
  const cliEntry = `${repoRoot}/packages/cli/src/index.ts`
  const runFromSubdir = Bun.spawnSync({
    cmd: ["bun", "run", cliEntry, "probe", "chain"],
    cwd: `${repoRoot}/packages/cli`,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (runFromSubdir.exitCode !== 0) {
    const stderr = runFromSubdir.stderr.toString()
    return (
      `[L] 'orrery probe chain' failed when invoked from packages/cli ` +
      `(exit ${runFromSubdir.exitCode}). The CLI must resolve the probe directory ` +
      `from its own location, not process.cwd(). stderr: ${stderr.slice(0, 200)}`
    )
  }
  return undefined
}

// ─── Sub-case M: hydrate is race-safe under concurrent first appends ──────

async function caseM(): Promise<string | undefined> {
  // Seed an existing log so a fresh writer needs to hydrate. Without
  // serialised hydration, two concurrent first appends both see an
  // empty seq map and allocate seq=0 — duplicates in the log.
  const LOG_ROOT = "/tmp/orrery-probe-contract-M"
  const PROJECT = "probe-contract-M"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  // Pre-populate the log: write 5 events with a first writer so the
  // directory exists with `seq: 0..4`.
  const seeder = new EventLogWriter(LOG_ROOT)
  for (let i = 0; i < 5; i++) {
    await seeder.append({
      id: crypto.randomUUID(),
      type: "probe.seed",
      schema_version: "0.1.0",
      project_id: PROJECT,
      session_id: "seed-session",
      actor_id: "seeder",
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload: { i },
      versions: {},
    })
  }

  // Fresh writer (mimics what `runGuarded` constructs per session).
  // Fire N concurrent first appends — they must all hydrate against
  // the seeded log before any of them allocates a seq number.
  const writer = new EventLogWriter(LOG_ROOT)
  const N = 8
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      writer.append({
        id: crypto.randomUUID(),
        type: "probe.concurrent",
        schema_version: "0.1.0",
        project_id: PROJECT,
        session_id: `session-${i}`,
        actor_id: "tester",
        timestamp: new Date().toISOString(),
        causal_parent_ids: [],
        payload: { i },
        versions: {},
      }),
    ),
  )

  // Read everything back and assert no duplicate seq values.
  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readAll(PROJECT)
  const seen = new Map<number, number>()
  for (const e of events) {
    seen.set(e.seq, (seen.get(e.seq) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()].filter(([_, c]) => c > 1)
  if (duplicates.length > 0) {
    const sample = duplicates.slice(0, 3).map(([s, c]) => `seq=${s}×${c}`).join(", ")
    return (
      `[M] concurrent first appends produced duplicate seq values: ${sample}. ` +
      `EventLogWriter.hydrate must serialise — a Set marker that fires before the ` +
      `async scan completes lets a second append skip hydration and allocate seq=0.`
    )
  }
  return undefined
}

// ─── Sub-case N: caller cannot lower contract.reversibility ───────────────

async function caseN(): Promise<string | undefined> {
  _resetToolsForTests()
  const OUT = "probe.n_out@1"
  if (!registry.has(OUT)) {
    registry.register(OUT, z.object({ ran: z.boolean() }))
  }

  // Tool declares itself irreversible. A hostile caller passes
  // `contract: { reversibility: "reversible" }`. Guard must clamp to
  // the tool's declared (higher-risk) value.
  registerTool({
    name: "probe.irreversible_tool",
    inputs: z.object({}),
    output_schema_key: OUT,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async () => ({ ran: true }),
  })

  let seenReversibility = ""
  const recordingPolicy: PolicyGate = async (action) => {
    seenReversibility = action.contract.reversibility
    return {
      approved: true,
      reason: `recorded ${action.contract.reversibility}`,
      approver_id: "recorder",
    }
  }

  await runGuarded(
    async (ctx) => {
      await ctx.callTool(
        "probe.irreversible_tool",
        {},
        { contract: { reversibility: "reversible" } },
      )
    },
    {
      project_id: "probe-contract-N",
      actor_id: "tester",
      log_root: "/tmp/orrery-probe-contract-N",
      default_scope: { level: "project", identifier: "probe-contract-N" },
      default_sensitivity: "internal",
      policy_gate: recordingPolicy,
      precondition_checker: alwaysHoldsChecker,
    },
  )

  if (seenReversibility !== "irreversible") {
    return (
      `[N] policy_gate saw reversibility='${seenReversibility}' after a caller passed ` +
      `'reversible' for an irreversible tool. The override should be clamped to ` +
      `the tool's declared (higher-risk) value.`
    )
  }
  return undefined
}

// ─── Sub-case O: concurrent writer instances share seq across sessions ────

async function caseO(): Promise<string | undefined> {
  const LOG_ROOT = "/tmp/orrery-probe-contract-O"
  const PROJECT = "probe-contract-O"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})
  _resetEventLogStateForTests()

  // Two concurrent writers for the same project — the runGuarded x
  // runGuarded scenario. Each constructs its own EventLogWriter. They
  // must share allocation state or both will scan an empty log and
  // allocate seq=0 simultaneously.
  const writers = [
    new EventLogWriter(LOG_ROOT),
    new EventLogWriter(LOG_ROOT),
  ]

  const PER_WRITER = 5
  const appends: Promise<unknown>[] = []
  for (let w = 0; w < writers.length; w++) {
    for (let i = 0; i < PER_WRITER; i++) {
      const writer = writers[w]
      if (!writer) continue
      appends.push(
        writer.append({
          id: crypto.randomUUID(),
          type: "probe.concurrent_writers",
          schema_version: "0.1.0",
          project_id: PROJECT,
          session_id: `session-w${w}-${i}`,
          actor_id: "tester",
          timestamp: new Date().toISOString(),
          causal_parent_ids: [],
          payload: { w, i },
          versions: {},
        }),
      )
    }
  }
  await Promise.all(appends)

  // Read everything back and assert no duplicate seq values.
  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readAll(PROJECT)
  const seen = new Map<number, number>()
  for (const e of events) {
    seen.set(e.seq, (seen.get(e.seq) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()].filter(([_, c]) => c > 1)
  if (duplicates.length > 0) {
    const sample = duplicates.slice(0, 3).map(([s, c]) => `seq=${s}×${c}`).join(", ")
    return (
      `[O] concurrent writer instances produced duplicate seq values: ${sample}. ` +
      `EventLogWriter must share seq state across instances pointed at the same root/project.`
    )
  }
  if (events.length !== writers.length * PER_WRITER) {
    return `[O] expected ${writers.length * PER_WRITER} events; got ${events.length}`
  }
  return undefined
}

// ─── Sub-case P: tool inputs are parsed exactly once ──────────────────────

async function caseP(): Promise<string | undefined> {
  _resetToolsForTests()
  const OUT = "probe.p_out@1"
  if (!registry.has(OUT)) {
    registry.register(OUT, z.object({ ran: z.boolean() }))
  }

  // Tool with a non-idempotent transform: every parse appends "+" to
  // the token. If Guard parses once and the kernel parses again, the
  // precondition factory sees `abc+` while tool.execute sees `abc++`
  // — a TOCTOU mismatch.
  const InputSchema = z
    .object({ token: z.string() })
    .transform((value) => ({ token: `${value.token}+` }))

  let preconditionFactoryToken = ""
  let executeToken = ""

  registerTool({
    name: "probe.transform_tool",
    inputs: InputSchema,
    output_schema_key: OUT,
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: (inputs) => {
      preconditionFactoryToken = inputs.token
      return []
    },
    execute: async (inputs) => {
      executeToken = inputs.token
      return { ran: true }
    },
  })

  await runGuarded(
    async (ctx) => {
      await ctx.callTool("probe.transform_tool", { token: "abc" })
    },
    {
      project_id: "probe-contract-P",
      actor_id: "tester",
      log_root: "/tmp/orrery-probe-contract-P",
      default_scope: { level: "project", identifier: "probe-contract-P" },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  // Two assertions:
  //   1. factory and execute see the same token (no mismatch between
  //      what preconditions guarded and what executed)
  //   2. the transform was applied exactly once — `token + "+"`. If
  //      the schema is parsed more than once, the transform compounds
  //      ("abc++", "abc+++", …) which mis-records both factory and
  //      execute against the caller's intent.
  if (preconditionFactoryToken !== executeToken) {
    return (
      `[P] precondition factory saw token='${preconditionFactoryToken}' but ` +
      `tool.execute saw token='${executeToken}'. Inputs are being parsed more than ` +
      `once; the second parse re-applies the transform and shifts the value the ` +
      `tool executes against what its preconditions guarded.`
    )
  }
  if (executeToken !== "abc+") {
    return (
      `[P] tool.execute saw token='${executeToken}'; expected 'abc+' (single transform). ` +
      `Repeated parse compounded the transform — the kernel/Guard pair must parse ` +
      `tool inputs exactly once per callTool.`
    )
  }
  return undefined
}

// ─── Sub-case Q: evidence persists in the event log & renders in report ───

async function caseQ(): Promise<string | undefined> {
  registerProbeTool({ count: 0 })
  const LOG_ROOT = "/tmp/orrery-probe-contract-Q"
  const PROJECT = "probe-contract-Q"
  const SESSION = "session-probe-Q"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  // Register a tool that's plain enough for the built-in extractors
  // to produce claims + evidence. The greenfield git.status is the
  // simplest; we use the cleared registry to add fs.read + git.status
  // here.
  const { registerFsReadTool } = await import("@orrery/adapter-filesystem")
  const { registerGitStatusTool } = await import("@orrery/adapter-git")
  registerFsReadTool(process.cwd())
  registerGitStatusTool(process.cwd())

  await runGuarded(
    async (ctx) => {
      await ctx.callTool("git.status", { repo: "." })
    },
    {
      project_id: PROJECT,
      actor_id: "tester",
      session_id: SESSION,
      log_root: LOG_ROOT,
      default_scope: { level: "project", identifier: PROJECT },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readSession(PROJECT, SESSION)
  const evidenceEvents = events.filter((e) => e.type === "evidence.assessed")
  if (evidenceEvents.length === 0) {
    return (
      `[Q] no 'evidence.assessed' events in the guarded session log. ` +
      `Guard must emit the EvidenceSets the cognitive core produces so the trust ` +
      `report can audit why beliefs were adopted.`
    )
  }

  // Render and confirm the Evidence section is present.
  const { projectChain, renderReport } = await import("@orrery/trace")
  const projection = projectChain(events, {
    session_id: SESSION,
    project_id: PROJECT,
  })
  if (projection.evidence_sets.length === 0) {
    return `[Q] projectChain returned 0 evidence sets despite ${evidenceEvents.length} evidence events in the log`
  }
  const report = renderReport(projection)
  if (!report.includes("## Evidence")) {
    return `[Q] rendered trust report did not include an Evidence section`
  }
  return undefined
}

// ─── Sub-case R: decision.made events render in the report ────────────────

async function caseR(): Promise<string | undefined> {
  registerProbeTool({ count: 0 })
  const LOG_ROOT = "/tmp/orrery-probe-contract-R"
  const PROJECT = "probe-contract-R"
  const SESSION = "session-probe-R"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  await runGuarded(
    async (ctx) => {
      await ctx.emit("decision.made", {
        id: "decision-probe-r",
        intent: "probe decision rendering",
        chosen_option: { label: "test", rationale: "probing the renderer" },
        decided_by: ctx.actor_id,
        decided_at: new Date().toISOString(),
      })
    },
    {
      project_id: PROJECT,
      actor_id: "tester",
      session_id: SESSION,
      log_root: LOG_ROOT,
      default_scope: { level: "project", identifier: PROJECT },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readSession(PROJECT, SESSION)
  const { projectChain, renderReport } = await import("@orrery/trace")
  const projection = projectChain(events, { session_id: SESSION, project_id: PROJECT })
  if (projection.decisions.length === 0) {
    return `[R] projectChain returned 0 decisions despite an emitted decision.made event`
  }
  const report = renderReport(projection)
  if (!report.includes("## Decisions")) {
    return `[R] rendered trust report did not include a Decisions section`
  }
  if (!report.includes("probe decision rendering")) {
    return `[R] rendered trust report did not include the decision's intent`
  }
  if (!report.includes("probing the renderer")) {
    return `[R] rendered trust report did not include the chosen_option rationale`
  }
  return undefined
}

// ─── Sub-case S: outcome.observed events project + render ─────────────────

async function caseS(): Promise<string | undefined> {
  registerProbeTool({ count: 0 })
  const LOG_ROOT = "/tmp/orrery-probe-contract-S"
  const PROJECT = "probe-contract-S"
  const SESSION = "session-probe-S"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  const actionId = crypto.randomUUID()
  await runGuarded(
    async (ctx) => {
      // Emit an Outcome under the documented `outcome.observed` name.
      await ctx.emit("outcome.observed", {
        id: crypto.randomUUID(),
        action_id: actionId,
        result: "success",
        effect_observation_ids: [],
        side_effects_observed: ["probe-side-effect"],
        duration_ms: 7,
        observed_at: new Date().toISOString(),
      })
    },
    {
      project_id: PROJECT,
      actor_id: "tester",
      session_id: SESSION,
      log_root: LOG_ROOT,
      default_scope: { level: "project", identifier: PROJECT },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readSession(PROJECT, SESSION)
  const { projectChain, renderReport } = await import("@orrery/trace")
  const projection = projectChain(events, { session_id: SESSION, project_id: PROJECT })
  // Outcome was emitted without a preceding action — projectChain should
  // still capture it as a standalone ProjectedAction with outcome only.
  const projected = projection.actions.find((a) => a.outcome?.action_id === actionId)
  if (!projected) {
    return `[S] projectChain did not project the outcome.observed event onto its action`
  }
  const report = renderReport(projection)
  if (!report.includes("probe-side-effect")) {
    return `[S] trust report did not include the outcome's side effects`
  }
  return undefined
}

// ─── Sub-case T: per-call data_sensitivity propagates into obs/claim ──────

async function caseT(): Promise<string | undefined> {
  registerProbeTool({ count: 0 })
  const LOG_ROOT = "/tmp/orrery-probe-contract-T"
  const PROJECT = "probe-contract-T"
  const SESSION = "session-probe-T"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  // Internal session, but one specific call raises sensitivity to
  // 'secret' via the contract override. The resulting observation
  // (and the claims/beliefs it extracts) must land at 'secret', not
  // at the session default 'internal'.
  await runGuarded(
    async (ctx) => {
      await ctx.callTool(
        "probe.contract_tool",
        { token: "ok" },
        { contract: { data_sensitivity: "secret" } },
      )
    },
    {
      project_id: PROJECT,
      actor_id: "tester",
      session_id: SESSION,
      log_root: LOG_ROOT,
      default_scope: { level: "project", identifier: PROJECT },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readSession(PROJECT, SESSION)

  const obsEvent = events.find((e) => e.type === "observation.recorded")
  if (!obsEvent) return "[T] no observation.recorded event"
  const obsPayload = obsEvent.payload as { sensitivity?: string }
  if (obsPayload.sensitivity !== "secret") {
    return (
      `[T] per-call override 'secret' did not propagate into the observation ` +
      `(sensitivity='${obsPayload.sensitivity}'). The kernel must derive ` +
      `obs.sensitivity from contract.data_sensitivity, not hardcode 'internal'.`
    )
  }

  // The probe.contract_tool's output schema isn't bound to an
  // extractor, so no claims will be produced — that's expected. We
  // assert the observation is the bound for downstream sensitivity,
  // which is what the report and OTel exporters consume.
  return undefined
}

// ─── Sub-case U: malformed action.* event doesn't crash report rendering ──

async function caseU(): Promise<string | undefined> {
  registerProbeTool({ count: 0 })
  const LOG_ROOT = "/tmp/orrery-probe-contract-U"
  const PROJECT = "probe-contract-U"
  const SESSION = "session-probe-U"
  await fs.rm(LOG_ROOT, { recursive: true, force: true }).catch(() => {})

  // Emit a malformed action event via ctx.emit — has the keys
  // isActionPayload used to check but is missing `contract` and
  // `audit` which the renderer reads. Before the safeParse fix this
  // would land in projection.actions and crash renderActions.
  await runGuarded(
    async (ctx) => {
      await ctx.emit("action.partial", {
        id: "partial-1",
        tool: "fake.tool",
        phase: "completed",
        intent: "malformed action",
      })
    },
    {
      project_id: PROJECT,
      actor_id: "tester",
      session_id: SESSION,
      log_root: LOG_ROOT,
      default_scope: { level: "project", identifier: PROJECT },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "p" }),
      precondition_checker: alwaysHoldsChecker,
    },
  )

  const reader = new EventLogReader(LOG_ROOT)
  const events = await reader.readSession(PROJECT, SESSION)
  const { projectChain, renderReport } = await import("@orrery/trace")
  const projection = projectChain(events, { session_id: SESSION, project_id: PROJECT })

  // The malformed action must NOT be in projection.actions — it
  // failed schema validation, so it's only available in raw_events.
  const projected = projection.actions.find((a) => a.action?.id === "partial-1")
  if (projected) {
    return (
      `[U] projection accepted a malformed action.* payload as a full Action. ` +
      `Schema validation must reject it before it reaches the renderer.`
    )
  }

  // Rendering must not throw. We don't need any specific output —
  // just that calling renderReport completes without an exception.
  try {
    renderReport(projection)
  } catch (err) {
    return (
      `[U] renderReport threw on a session that included a malformed action.* event: ` +
      `${err instanceof Error ? err.message : String(err)}`
    )
  }
  return undefined
}

async function run(): Promise<ProbeResult> {
  const cases: Array<{ name: string; fn: () => Promise<string | undefined> | string | undefined }> = [
    { name: "A: caller cannot drop tool preconditions", fn: caseA },
    { name: "B: secret session → secret action sensitivity", fn: caseB },
    { name: "C: built-in extractor registration is idempotent", fn: caseC },
    { name: "D: caller cannot lower contract.data_sensitivity", fn: caseD },
    { name: "E: default session_ids are collision-resistant", fn: caseE },
    { name: "F: tool.execute receives the guarded session/project", fn: caseF },
    { name: "G: event log seq is monotonic across runGuarded calls", fn: caseG },
    { name: "H: autoApprovePolicy rejects out-of-range ceilings", fn: caseH },
    { name: "I: ingestObservation rewrites context + lifts sensitivity", fn: caseI },
    { name: "J: mem0 adapter tolerates malformed records", fn: caseJ },
    { name: "K: execution-time rejections emit action.rejected", fn: caseK },
    { name: "L: orrery probe works from any working directory", fn: caseL },
    { name: "M: writer hydration is race-safe", fn: caseM },
    { name: "N: caller cannot lower contract.reversibility", fn: caseN },
    { name: "O: concurrent writers share seq across instances", fn: caseO },
    { name: "P: tool inputs are parsed exactly once", fn: caseP },
    { name: "Q: evidence persists in event log + renders in report", fn: caseQ },
    { name: "R: decision.made events render in the trust report", fn: caseR },
    { name: "S: outcome.observed events project + render", fn: caseS },
    { name: "T: per-call data_sensitivity propagates into observations", fn: caseT },
    { name: "U: malformed action.* events don't crash the report", fn: caseU },
  ]
  const passed: string[] = []
  for (const { name, fn } of cases) {
    const failure = await fn()
    if (failure) {
      return {
        passed: false,
        details: `case "${name}" failed.\n  ${failure}\nPassed so far: ${passed.join(", ") || "(none)"}`,
      }
    }
    passed.push(name)
  }
  return {
    passed: true,
    details: `All ${passed.length} sub-cases passed:\n  - ${passed.join("\n  - ")}`,
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: guard_contract_invariants")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
