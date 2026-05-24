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

import { z } from "zod"
import { registry } from "@orrery/core"
import { _resetToolsForTests, registerTool } from "@orrery/action-kernel"
import { registerBuiltInExtractors } from "@orrery/cognitive-core"
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

async function run(): Promise<ProbeResult> {
  const cases: Array<{ name: string; fn: () => Promise<string | undefined> }> = [
    { name: "A: caller cannot drop tool preconditions", fn: caseA },
    { name: "B: secret session → secret action sensitivity", fn: caseB },
    { name: "C: built-in extractor registration is idempotent", fn: caseC },
    { name: "D: caller cannot lower contract.data_sensitivity", fn: caseD },
    { name: "E: default session_ids are collision-resistant", fn: caseE },
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
