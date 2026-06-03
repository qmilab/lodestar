#!/usr/bin/env bun
/**
 * Probe: ladder_floor_overrides_allow_rule
 *
 * A policy whose first rule would `allow` an L4 action must still yield a hold:
 * the structural trust-ladder floor runs BEFORE the rule list and no rule can
 * lift it.
 *
 * Setup: policy `[{ match: { tool: "git.*" }, effect: allow }]`.
 *
 * Assertions:
 * 1. An L4 `git.push` action — which the allow rule *matches* — arbitrates to
 *    `pending_approval`, and `evaluate().matched.source` is `"floor"`, not
 *    `"rule"`. The floor pre-empted the rule.
 * 2. An L2 `git.push` action IS approved via the same rule, with
 *    `matched.source === "rule"` — the rule works for everything below the
 *    floor, so the hold in (1) is specifically the floor, not a broken rule.
 *
 * Why this matters: without the structural floor, the safe outcome would be a
 * rule someone must remember to add. The floor makes it impossible to forget.
 */

import { ActionKernel, _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type ActionContract, type Policy, registry } from "@qmilab/lodestar-core"
import { compile } from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.floor@1"

function gitContract(level: 2 | 4): ActionContract {
  return {
    required_level: level,
    blast_radius: level === 4 ? "external" : "self",
    reversibility: level === 4 ? "irreversible" : "reversible",
    scope: { level: "repo", identifier: "probe-repo" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  _resetToolsForTests()
  registerTool({
    name: "git.push",
    inputs: z.object({}),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "irreversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async () => ({ ran: true }),
  })

  const policy: Policy = {
    id: "git-allow",
    version: "1",
    rules: [{ match: { tool: "git.*" }, effect: "allow", reason: "git.* is allowed" }],
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

  // 1. L4 git.push — matched by the allow rule, but the floor wins.
  const l4 = kernel.propose({
    intent: "push",
    tool: "git.push",
    inputs: {},
    contract: gitContract(4),
    proposed_by: "agent",
  })
  const l4eval = compiled.evaluate(l4)
  const l4done = await kernel.arbitrate(l4)
  if (l4done.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[1] L4 git.push reached '${l4done.phase}'; expected 'pending_approval'.`,
    }
  }
  if (l4eval.matched.source !== "floor") {
    return {
      passed: false,
      details: `[1] L4 git.push verdict came from '${l4eval.matched.source}'; expected 'floor'. A rule must not be able to allow an L4 action.`,
    }
  }

  // 2. L2 git.push — approved via the rule.
  const l2 = kernel.propose({
    intent: "push",
    tool: "git.push",
    inputs: {},
    contract: gitContract(2),
    proposed_by: "agent",
  })
  const l2eval = compiled.evaluate(l2)
  const l2done = await kernel.arbitrate(l2)
  if (l2done.phase !== "approved") {
    return {
      passed: false,
      details: `[2] L2 git.push reached '${l2done.phase}'; expected 'approved' via the rule.`,
    }
  }
  if (l2eval.matched.source !== "rule") {
    return {
      passed: false,
      details: `[2] L2 git.push verdict came from '${l2eval.matched.source}'; expected 'rule'.`,
    }
  }

  return {
    passed: true,
    details:
      "An allow rule matching git.* approved an L2 action but could NOT lift the floor on an L4 action — the L4 hold's verdict came from the floor, evaluated before the rule list.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: ladder_floor_overrides_allow_rule")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
