#!/usr/bin/env bun
/**
 * Probe: unmatched_action_defaults_to_deny
 *
 * An action matching no rule hits the structural deny default — there is no
 * silent allow, no `default` field to misconfigure.
 *
 * Setup: policy `[{ match: { tool: "git.*" }, effect: allow }]`.
 *
 * Assertions:
 * 1. An L1 `fs.read` action (no rule matches it) arbitrates to `rejected`, and
 *    `evaluate().matched.source` is `"default"` — not `"rule"`, not `"allow"`.
 * 2. The rejected action never reaches `approved`/`pending_approval`, and
 *    cannot be executed.
 * 3. Sanity: a matching `git.fetch` action at the same level IS approved — the
 *    deny is specifically the *unmatched* default, not a dead policy.
 *
 * Why this matters: the architecture's through-line is "refuse unless
 * explicitly approved". The deny default makes the safe outcome structural.
 */

import { ActionKernel, _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type ActionContract, type Policy, registry } from "@qmilab/lodestar-core"
import { compile } from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.deny@1"

const L1_CONTRACT: ActionContract = {
  required_level: 1,
  blast_radius: "self",
  reversibility: "reversible",
  scope: { level: "repo", identifier: "probe-repo" },
  data_sensitivity: "public",
  preconditions: [],
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  _resetToolsForTests()

  let executeCalls = 0
  for (const name of ["fs.read", "git.fetch"]) {
    registerTool({
      name,
      inputs: z.object({}),
      output_schema_key: OUT_KEY,
      effects: [],
      reversibility: "reversible",
      permissions: [],
      required_trust_level: 0,
      sandbox: "read",
      execute: async () => {
        executeCalls += 1
        return { ran: true }
      },
    })
  }

  const policy: Policy = {
    id: "git-only",
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

  // 1. Unmatched fs.read → deny default.
  const unmatched = kernel.propose({
    intent: "read",
    tool: "fs.read",
    inputs: {},
    contract: L1_CONTRACT,
    proposed_by: "agent",
  })
  const unmatchedEval = compiled.evaluate(unmatched)
  const denied = await kernel.arbitrate(unmatched)
  if (denied.phase !== "rejected") {
    return {
      passed: false,
      details: `[1] unmatched fs.read reached '${denied.phase}'; expected 'rejected' (deny default).`,
    }
  }
  if (unmatchedEval.matched.source !== "default") {
    return {
      passed: false,
      details: `[1] unmatched fs.read verdict came from '${unmatchedEval.matched.source}'; expected 'default'.`,
    }
  }

  // 2. A rejected action cannot execute.
  let executeRefused = false
  try {
    await kernel.execute(denied)
  } catch (err) {
    executeRefused = /cannot execute|rejected|approved/i.test(
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!executeRefused)
    return { passed: false, details: "[2] execute() did not refuse a rejected action." }

  // 3. Sanity: matching git.fetch IS approved.
  const matched = await kernel.arbitrate(
    kernel.propose({
      intent: "fetch",
      tool: "git.fetch",
      inputs: {},
      contract: L1_CONTRACT,
      proposed_by: "agent",
    }),
  )
  if (matched.phase !== "approved") {
    return {
      passed: false,
      details: `[3] matching git.fetch reached '${matched.phase}'; expected 'approved'.`,
    }
  }

  if (executeCalls !== 0) {
    return {
      passed: false,
      details: `[*] tool.execute ran ${executeCalls}x; no probe action was executed.`,
    }
  }

  return {
    passed: true,
    details:
      "An action matching no rule was rejected by the structural deny default (verdict source 'default'); it could not execute; a matching action still approved.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: unmatched_action_defaults_to_deny")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
