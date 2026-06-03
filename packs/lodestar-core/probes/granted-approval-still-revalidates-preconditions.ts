#!/usr/bin/env bun
/**
 * Probe: granted_approval_still_revalidates_preconditions
 *
 * Approval authorises *intent*, not a stale world. A granted L4 action
 * re-enters `execute()` through the normal `approved` gate, so its
 * `must_revalidate_at_execution` preconditions still fire. A human approving
 * "push to main" at T0 does not authorise a push against a different HEAD at
 * T1.
 *
 * Setup: a tool declaring a precondition with `must_revalidate_at_execution:
 * true`; a hold-everything policy; a `precondition_checker` that reports the
 * precondition NO LONGER holds (a TOCTOU race between approval and execution).
 *
 * Assertions:
 * 1. The L4 action is held, then a qualified grant un-parks it to `approved`.
 * 2. `execute()` on the granted action re-runs the precondition and, finding
 *    it no longer holds, transitions to `rejected` — the tool never runs.
 * 3. The rejection mentions the failed precondition (auditability).
 *
 * Why this matters: if approval skipped TOCTOU revalidation, a stale grant
 * could push against a world that changed under it.
 */

import { ActionKernel, _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type ActionContract, type Actor, type Policy, registry } from "@qmilab/lodestar-core"
import { authorizeResolution, compile, openApprovalRequest } from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.revalidate@1"

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
  let preconditionChecks = 0

  registerTool({
    name: "git.push",
    inputs: z.object({ head: z.string() }),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: (inputs) => [
      {
        check_id: "probe.head_unchanged",
        parameters: { head: inputs.head },
        expected_at_approval: inputs.head,
        must_revalidate_at_execution: true,
      },
    ],
    execute: async () => {
      executeCalls += 1
      return { ran: true }
    },
  })

  const policy: Policy = {
    id: "hold-all",
    version: "1",
    rules: [{ match: {}, effect: "require_approval", reason: "everything needs approval (probe)" }],
  }
  const compiled = compile(policy, { decider_id: "probe-policy", allow_unsigned: true })

  const kernel = new ActionKernel(
    compiled.gate,
    async (check) => {
      preconditionChecks += 1
      // The world changed since approval: HEAD moved.
      const stillHolds = check.check_id !== "probe.head_unchanged"
      return { holds: stillHolds, observed: "different-head" }
    },
    async () => {},
    { useStubsForTests: true },
  )

  // 1. Hold, then grant → approved.
  const parked = await kernel.arbitrate(
    kernel.propose({
      intent: "push",
      tool: "git.push",
      inputs: { head: "abc123" },
      contract: L4_CONTRACT,
      proposed_by: "agent",
    }),
  )
  if (parked.phase !== "pending_approval") {
    return { passed: false, details: `setup: expected 'pending_approval', got '${parked.phase}'.` }
  }
  const auth = authorizeResolution(
    openApprovalRequest(parked, compiled.evaluate(parked)),
    APPROVER,
    "granted",
  )
  if (!auth.authorized)
    return { passed: false, details: `[1] qualified approver refused: ${auth.reason}` }
  const approved = kernel.resolve(parked, auth.outcome)
  if (approved.phase !== "approved") {
    return {
      passed: false,
      details: `[1] resolve(granted) reached '${approved.phase}'; expected 'approved'.`,
    }
  }

  // 2. execute() re-validates and rejects the stale grant.
  const executed = await kernel.execute(approved)
  if (executed.phase !== "rejected") {
    return {
      passed: false,
      details: `[2] execute() on a granted-but-stale action reached '${executed.phase}'; expected 'rejected'. Approval must not skip TOCTOU revalidation.`,
    }
  }
  if (preconditionChecks !== 1) {
    return {
      passed: false,
      details: `[2] precondition_checker ran ${preconditionChecks}x; expected exactly 1 at execute time.`,
    }
  }
  if (executeCalls !== 0) {
    return {
      passed: false,
      details: `[2] tool.execute ran ${executeCalls}x; expected 0 — the stale precondition should have blocked it.`,
    }
  }

  // 3. The rejection is legible.
  const detail = executed.audit.at(-1)?.detail ?? ""
  if (!/precondition/i.test(detail)) {
    return {
      passed: false,
      details: `[3] rejection audit did not mention the failed precondition. Got: ${detail}`,
    }
  }

  return {
    passed: true,
    details:
      "A granted L4 action re-validated its must_revalidate precondition at execute time; finding the world changed, it was rejected and the tool never ran. Approval authorised intent, not a stale world.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: granted_approval_still_revalidates_preconditions")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
