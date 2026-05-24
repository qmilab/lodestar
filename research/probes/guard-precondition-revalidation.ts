#!/usr/bin/env bun
/**
 * Probe: guard_precondition_revalidation
 *
 * Verifies that tool-declared preconditions reach the Action Kernel's
 * revalidation step when a tool is invoked through `@orrery/guard`.
 *
 * Setup:
 * - Register a synthetic tool whose `preconditions` factory returns a
 *   single precondition with `must_revalidate_at_execution: true`.
 * - Configure a guarded session whose `precondition_checker` reports
 *   that the precondition no longer holds (simulating a TOCTOU race).
 * - Call the tool through `ctx.callTool`.
 *
 * Assertions:
 * 1. The host's `precondition_checker` is invoked exactly once for the
 *    synthetic check.
 * 2. The tool's `execute` function is never called — the kernel
 *    rejected the action at the revalidation step.
 * 3. `callTool` throws a rejection error mentioning "precondition".
 *
 * Why this matters:
 * Guard advertises that tool calls flow through the Action Kernel's
 * two-phase execution, including precondition revalidation. If Guard
 * silently drops a tool's declared preconditions when constructing
 * the contract, the kernel sees an empty list at execution time and
 * skips the TOCTOU check the tool author published. This is what
 * Codex caught in the Batch 2 review.
 */

import { z } from "zod"
import { registry } from "@orrery/core"
import { registerTool, _resetToolsForTests } from "@orrery/action-kernel"
import { autoApprovePolicy, runGuarded } from "@orrery/guard"

interface ProbeResult {
  passed: boolean
  details: string
}

async function run(): Promise<ProbeResult> {
  const OUT_KEY = "probe.precondition@1"
  if (!registry.has(OUT_KEY)) {
    registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  }

  _resetToolsForTests()

  let executeCalls = 0
  let preconditionChecks = 0

  const InputSchema = z.object({ token: z.string() })

  registerTool({
    name: "probe.precondition_revalidation",
    inputs: InputSchema,
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
      executeCalls += 1
      return { ran: true }
    },
  })

  const result = await runGuarded(
    async (ctx) => {
      try {
        await ctx.callTool("probe.precondition_revalidation", { token: "abc" })
        return { rejected: false, message: "callTool should have thrown" }
      } catch (err) {
        return {
          rejected: true,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },
    {
      project_id: "probe-precond",
      actor_id: "probe-tester",
      log_root: "/tmp/orrery-probe-precond-log",
      default_scope: { level: "project", identifier: "probe-precond" },
      default_sensitivity: "internal",
      policy_gate: autoApprovePolicy({ auto_approve_up_to: 2, approver_id: "policy" }),
      precondition_checker: async (check) => {
        preconditionChecks += 1
        // Simulate the world having changed since approval time.
        const stillHolds = check.check_id !== "probe.token_unchanged"
        return { holds: stillHolds, observed: "changed-value" }
      },
    },
  )

  const loopResult = result.result as { rejected: boolean; message: string }

  if (preconditionChecks !== 1) {
    return {
      passed: false,
      details:
        `precondition_checker was invoked ${preconditionChecks} time(s); expected 1. ` +
        `Guard probably dropped the tool's declared preconditions when constructing the contract.`,
    }
  }
  if (executeCalls !== 0) {
    return {
      passed: false,
      details:
        `tool.execute ran ${executeCalls} time(s). Expected 0 — the kernel should have ` +
        `rejected the action before execute when the precondition no longer held.`,
    }
  }
  if (!loopResult.rejected) {
    return {
      passed: false,
      details: "callTool returned instead of throwing on a precondition failure.",
    }
  }
  if (!/precondition/i.test(loopResult.message)) {
    return {
      passed: false,
      details:
        `callTool threw but the error did not mention 'precondition'. ` +
        `Got: ${loopResult.message}`,
    }
  }

  return {
    passed: true,
    details:
      `Guard wired the tool's declared preconditions into the action contract. ` +
      `Kernel rejected execution on TOCTOU check; tool.execute was never called.\n` +
      `Rejection: ${loopResult.message}`,
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: guard_precondition_revalidation")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
