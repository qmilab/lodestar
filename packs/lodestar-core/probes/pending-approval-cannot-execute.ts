#!/usr/bin/env bun
/**
 * Probe: pending_approval_cannot_execute
 *
 * The two-phase discipline must hold for the new `pending_approval` state: a
 * parked action cannot be driven to `execute()`. Only un-parking it via the
 * Action Kernel's `resolve()` (on a granted approval) reaches `approved`, and
 * only then can it execute.
 *
 * Assertions:
 * 1. `execute()` on a `pending_approval` action throws (world untouched).
 * 2. `resolve()` from the wrong phase (e.g. `proposed`) throws — only a parked
 *    action can be un-parked.
 * 3. A qualified approver's grant → `authorizeResolution` → `resolve()`
 *    transitions the action to `approved`, recording the ApprovalEvent.
 * 3b. The outcome is bound to its action: applying a grant authorized for one
 *    parked action to a DIFFERENT pending action is refused (both sit at
 *    `pending_approval`, so the phase check alone is not enough).
 * 4. The now-`approved` action executes to `completed` and the tool runs
 *    exactly once.
 *
 * Why this matters: `pending_approval` is a real gate, not a label. If a held
 * action could be executed directly, the approval workflow would be advisory.
 */

import { ActionKernel, _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type ActionContract, type Actor, type Policy, registry } from "@qmilab/lodestar-core"
import { authorizeResolution, compile, openApprovalRequest } from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.pending@1"

const L4_CONTRACT: ActionContract = {
  required_level: 4,
  blast_radius: "external",
  reversibility: "irreversible",
  scope: { level: "repo", identifier: "probe-repo" },
  data_sensitivity: "private",
  preconditions: [],
}

const APPROVER: Actor = {
  id: "human-approver",
  kind: "human",
  display_name: "Approver",
  authority_scope: [{ level: "global", identifier: "*" }],
  trust_baseline: 1,
  sensitivity_clearance: "secret",
  created_at: "2026-06-04T00:00:00Z",
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  _resetToolsForTests()

  let executeCalls = 0
  registerTool({
    name: "probe.push",
    inputs: z.object({}),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async () => {
      executeCalls += 1
      return { ran: true }
    },
  })

  // Hold-everything policy: a single require_approval rule.
  const policy: Policy = {
    id: "hold-all",
    version: "1",
    rules: [{ match: {}, effect: "require_approval", reason: "everything needs approval (probe)" }],
  }
  const compiled = compile(policy, { decider_id: "probe-policy", allow_unsigned: true })
  const kernel = new ActionKernel(
    compiled.gate,
    async () => ({ holds: true, observed: null }),
    async () => {},
    {
      useStubsForTests: true,
    },
  )

  const proposed = kernel.propose({
    intent: "push to main",
    tool: "probe.push",
    inputs: {},
    contract: L4_CONTRACT,
    proposed_by: "agent",
  })
  const parked = await kernel.arbitrate(proposed)
  if (parked.phase !== "pending_approval") {
    return { passed: false, details: `setup: expected 'pending_approval', got '${parked.phase}'.` }
  }

  // 1. execute() refuses a parked action.
  let executeRefused = false
  try {
    await kernel.execute(parked)
  } catch (err) {
    executeRefused = /pending_approval|cannot execute/i.test(
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!executeRefused)
    return { passed: false, details: "[1] execute() did not refuse a pending_approval action." }
  if (executeCalls !== 0)
    return { passed: false, details: `[1] tool ran ${executeCalls}x from a parked action.` }

  // 2. resolve() refuses the wrong phase.
  let resolveRefused = false
  try {
    kernel.resolve(proposed, {
      kind: "granted",
      action_id: proposed.id,
      request_id: "req-x",
      approver_id: APPROVER.id,
    })
  } catch (err) {
    resolveRefused = /cannot resolve|pending_approval|proposed/i.test(
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!resolveRefused)
    return {
      passed: false,
      details: "[2] resolve() did not refuse a non-parked (proposed) action.",
    }

  // 3. A qualified approver grants → authorize → resolve → approved.
  const request = openApprovalRequest(parked, compiled.evaluate(parked))
  const auth = authorizeResolution(request, APPROVER, "granted", { reason: "looks good" })
  if (!auth.authorized)
    return { passed: false, details: `[3] qualified approver was refused: ${auth.reason}` }

  // 3b. The outcome is bound to its action: applying it to a DIFFERENT parked
  //     action is refused, even though that action is also pending_approval.
  const other = await kernel.arbitrate(
    kernel.propose({
      intent: "push elsewhere",
      tool: "probe.push",
      inputs: {},
      contract: L4_CONTRACT,
      proposed_by: "agent",
    }),
  )
  if (other.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[3b] setup: second action expected 'pending_approval', got '${other.phase}'.`,
    }
  }
  let misbindRefused = false
  try {
    kernel.resolve(other, auth.outcome)
  } catch (err) {
    misbindRefused = /bound|outcome/i.test(err instanceof Error ? err.message : String(err))
  }
  if (!misbindRefused) {
    return {
      passed: false,
      details:
        "[3b] resolve() applied an outcome authorized for one action to a DIFFERENT pending action.",
    }
  }

  const resolved = kernel.resolve(parked, auth.outcome)
  if (resolved.phase !== "approved") {
    return {
      passed: false,
      details: `[3] resolve(granted) reached '${resolved.phase}'; expected 'approved'.`,
    }
  }
  if (resolved.approval?.approved !== true || resolved.approval.approver_id !== APPROVER.id) {
    return {
      passed: false,
      details: "[3] resolved action did not record a granting ApprovalEvent for the approver.",
    }
  }

  // 4. The approved action executes to completed.
  const done = await kernel.execute(resolved)
  if (done.phase !== "completed")
    return {
      passed: false,
      details: `[4] execute(approved) reached '${done.phase}'; expected 'completed'.`,
    }
  if (executeCalls !== 1)
    return { passed: false, details: `[4] tool ran ${executeCalls}x; expected exactly 1.` }

  return {
    passed: true,
    details:
      "pending_approval refused execute() and a wrong-phase resolve(); a qualified grant un-parked the action to approved; it then executed exactly once.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: pending_approval_cannot_execute")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
