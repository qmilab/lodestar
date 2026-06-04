#!/usr/bin/env bun
/**
 * Probe: l4_action_requires_approval
 *
 * The trust-ladder floor is non-overridable: an action at `required_level: 4`
 * (external/shared — push, deploy, spend, publish) can NEVER auto-approve. The
 * Policy Kernel routes it to a hold (`pending_approval`) regardless of any
 * allow rule or ceiling, and without an approval it never executes.
 *
 * Assertions:
 * 1. Under an allow-EVERYTHING policy (`{ match: {}, effect: allow }`), an L4
 *    action arbitrates to `pending_approval` — the floor runs before the rule.
 * 2. Under `autoApprovePolicy({ auto_approve_up_to: 3 })`, the same L4 action
 *    also lands at `pending_approval` (the ceiling cannot reach L4).
 * 3. A parked (`pending_approval`) action cannot be executed — `execute()`
 *    throws, so the world stays untouched while it waits.
 * 4. Sanity: an L2 action under the allow-all policy IS approved — the floor
 *    only bites L4/L5, it does not block everything.
 *
 * Why this matters: if a broad `allow` (or a misconfigured ceiling) could
 * auto-approve an L4 push, the entire human-approval workflow would be
 * silently skipped. The floor makes "L4 always waits" structural.
 */

import { ActionKernel, _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type ActionContract, type Policy, registry } from "@qmilab/lodestar-core"
import { autoApprovePolicy, compile } from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.l4@1"

function contractAt(level: 0 | 1 | 2 | 3 | 4): ActionContract {
  return {
    required_level: level,
    blast_radius: level >= 4 ? "external" : "self",
    reversibility: level >= 4 ? "irreversible" : "reversible",
    scope: { level: "repo", identifier: "probe-repo" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  _resetToolsForTests()
  registerTool({
    name: "probe.push",
    inputs: z.object({}),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async () => ({ ran: true }),
  })

  const allowEverything: Policy = {
    id: "allow-all",
    version: "1",
    rules: [{ match: {}, effect: "allow", reason: "allow everything (adversarial)" }],
  }
  const allowAllGate = compile(allowEverything, {
    decider_id: "probe-policy",
    allow_unsigned: true,
  }).gate
  const ceilingGate = autoApprovePolicy({ auto_approve_up_to: 3, approver_id: "probe-policy" })

  const sink = async () => {}

  // 1. allow-all policy still holds L4.
  const k1 = new ActionKernel(allowAllGate, async () => ({ holds: true, observed: null }), sink, {
    useStubsForTests: true,
  })
  const l4a = await k1.arbitrate(
    k1.propose({
      intent: "push to main",
      tool: "probe.push",
      inputs: {},
      contract: contractAt(4),
      proposed_by: "agent",
    }),
  )
  if (l4a.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[1] L4 action under allow-all policy reached phase '${l4a.phase}'; expected 'pending_approval'. The floor must override the allow rule.`,
    }
  }

  // 2. autoApprovePolicy(3) also holds L4.
  const k2 = new ActionKernel(ceilingGate, async () => ({ holds: true, observed: null }), sink, {
    useStubsForTests: true,
  })
  const l4b = await k2.arbitrate(
    k2.propose({
      intent: "push to main",
      tool: "probe.push",
      inputs: {},
      contract: contractAt(4),
      proposed_by: "agent",
    }),
  )
  if (l4b.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[2] L4 action under autoApprovePolicy(3) reached phase '${l4b.phase}'; expected 'pending_approval'. The ceiling must not reach L4.`,
    }
  }

  // 3. A parked action cannot execute.
  let executeRefused = false
  try {
    await k1.execute(l4a)
  } catch (err) {
    executeRefused = /pending_approval|cannot execute/i.test(
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!executeRefused) {
    return {
      passed: false,
      details:
        "[3] execute() did not refuse a 'pending_approval' action. A held action must not be able to touch the world.",
    }
  }

  // 4. Sanity: L2 IS approved under allow-all.
  const l2 = await k1.arbitrate(
    k1.propose({
      intent: "read a file",
      tool: "probe.push",
      inputs: {},
      contract: contractAt(2),
      proposed_by: "agent",
    }),
  )
  if (l2.phase !== "approved") {
    return {
      passed: false,
      details: `[4] L2 action under allow-all reached '${l2.phase}'; expected 'approved'. The floor must only gate L4/L5.`,
    }
  }

  return {
    passed: true,
    details:
      "L4 actions held at pending_approval under both an allow-all policy and a ceiling-3 preset; a parked action could not execute; L2 still auto-approved.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: l4_action_requires_approval")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
