#!/usr/bin/env bun
/**
 * Probe: l4_floor_preserves_stricter_rule
 *
 * The trust-ladder floor for L4 is a *lower bound*, not a fixed verdict. It
 * guarantees an L4 action never auto-approves, but a matching rule can still
 * make it MORE restrictive — and the floor must not silently drop that. (A
 * literal "L4 → hold, ignore rules" floor would let an under-authorized
 * approver grant a high-risk action whose policy demanded a senior approver,
 * or would soften an explicit `deny` into an approvable hold.)
 *
 * Assertions:
 * 1. A matching `require_approval` rule's stricter `required_authority`
 *    (min_trust_baseline 0.9) is PRESERVED in the opened ApprovalRequest — a
 *    junior approver (trust 0.5) is refused, a senior (0.95) is authorized.
 * 2. A matching `deny` rule on an L4 action still DENIES (→ rejected), the
 *    floor does not soften it to a hold; the verdict source is the rule.
 * 3. Contrast: an L4 action matching NO rule gets the floor's baseline hold
 *    with no trust requirement — the SAME junior approver CAN grant it. This
 *    is exactly the authority a stricter rule must be able to raise above.
 *
 * Why this matters: this is the highest-risk path. Under-enforcing the
 * approver requirement on an L4 push/deploy is a real privilege gap (Codex
 * P1 on the engine PR).
 */

import { ActionKernel, _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type ActionContract, type Actor, type Policy, registry } from "@qmilab/lodestar-core"
import { authorizeResolution, compile, openApprovalRequest } from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.floor_lb@1"

const L4_CONTRACT: ActionContract = {
  required_level: 4,
  blast_radius: "external",
  reversibility: "irreversible",
  scope: { level: "repo", identifier: "probe-repo" },
  data_sensitivity: "private",
  preconditions: [],
}

function approver(id: string, trust_baseline: number): Actor {
  return {
    id,
    kind: "human",
    display_name: id,
    authority_scope: [{ level: "global", identifier: "*" }],
    trust_baseline,
    sensitivity_clearance: "secret",
    created_at: "2026-06-04T00:00:00Z",
  }
}

const JUNIOR = approver("junior", 0.5)
const SENIOR = approver("senior", 0.95)

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  _resetToolsForTests()
  for (const name of ["git.push", "git.fetch", "danger.deploy"]) {
    registerTool({
      name,
      inputs: z.object({}),
      output_schema_key: OUT_KEY,
      effects: [],
      reversibility: "irreversible",
      permissions: [],
      required_trust_level: 0,
      sandbox: "read",
      execute: async () => ({ ran: true }),
    })
  }

  const sink = async () => {}
  const checker = async () => ({ holds: true, observed: null })

  // 1. Stricter require_approval rule — authority preserved.
  const strict: Policy = {
    id: "strict-push",
    version: "1",
    rules: [
      {
        match: { tool: "git.push" },
        effect: "require_approval",
        approval: { required_authority: { min_trust_baseline: 0.9 } },
        reason: "L4 push needs a senior approver",
      },
    ],
  }
  const strictC = compile(strict, { decider_id: "p", allow_unsigned: true })
  const strictK = new ActionKernel(strictC.gate, checker, sink, { useStubsForTests: true })
  const pushAction = strictK.propose({
    intent: "push",
    tool: "git.push",
    inputs: {},
    contract: L4_CONTRACT,
    proposed_by: "agent",
  })
  const pushParked = await strictK.arbitrate(pushAction)
  if (pushParked.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[1] L4 git.push under a require_approval rule reached '${pushParked.phase}'; expected 'pending_approval'.`,
    }
  }
  const strictReq = openApprovalRequest(pushParked, strictC.evaluate(pushParked))
  if (strictReq.required_authority.min_trust_baseline !== 0.9) {
    return {
      passed: false,
      details: `[1] opened request lost the rule's min_trust_baseline; got ${String(strictReq.required_authority.min_trust_baseline)}, expected 0.9. The floor dropped the stricter authority.`,
    }
  }
  if (authorizeResolution(strictReq, JUNIOR, "granted").authorized) {
    return {
      passed: false,
      details:
        "[1] a junior approver (trust 0.5) was allowed to grant a request demanding trust ≥ 0.9.",
    }
  }
  if (!authorizeResolution(strictReq, SENIOR, "granted").authorized) {
    return {
      passed: false,
      details: "[1] a senior approver (trust 0.95) was refused a request demanding trust ≥ 0.9.",
    }
  }

  // 2. A matching deny rule on an L4 action still denies.
  const denyPolicy: Policy = {
    id: "deny-deploy",
    version: "1",
    rules: [{ match: { tool: "danger.deploy" }, effect: "deny", reason: "never deploy from here" }],
  }
  const denyC = compile(denyPolicy, { decider_id: "p", allow_unsigned: true })
  const denyK = new ActionKernel(denyC.gate, checker, sink, { useStubsForTests: true })
  const deployAction = denyK.propose({
    intent: "deploy",
    tool: "danger.deploy",
    inputs: {},
    contract: L4_CONTRACT,
    proposed_by: "agent",
  })
  const deployEval = denyC.evaluate(deployAction)
  const deployArb = await denyK.arbitrate(deployAction)
  if (deployArb.phase !== "rejected") {
    return {
      passed: false,
      details: `[2] an L4 deny rule produced '${deployArb.phase}'; expected 'rejected' — the floor must not soften deny to a hold.`,
    }
  }
  if (deployEval.matched.source !== "rule") {
    return {
      passed: false,
      details: `[2] the L4 deny verdict came from '${deployEval.matched.source}'; expected 'rule'.`,
    }
  }

  // 3. Contrast: an L4 action matching no rule gets only the floor baseline —
  //    the junior approver CAN grant it (no trust requirement to raise).
  const unmatched = strictK.propose({
    intent: "fetch",
    tool: "git.fetch",
    inputs: {},
    contract: L4_CONTRACT,
    proposed_by: "agent",
  })
  const unmatchedParked = await strictK.arbitrate(unmatched)
  if (unmatchedParked.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[3] an unmatched L4 action reached '${unmatchedParked.phase}'; expected 'pending_approval' (floor baseline).`,
    }
  }
  const baselineReq = openApprovalRequest(unmatchedParked, strictC.evaluate(unmatchedParked))
  if (baselineReq.required_authority.min_trust_baseline !== undefined) {
    return {
      passed: false,
      details: `[3] the baseline floor hold carried an unexpected min_trust_baseline ${String(baselineReq.required_authority.min_trust_baseline)}.`,
    }
  }
  if (!authorizeResolution(baselineReq, JUNIOR, "granted").authorized) {
    return {
      passed: false,
      details:
        "[3] the junior approver was refused the baseline floor hold — the baseline should carry no trust floor.",
    }
  }

  return {
    passed: true,
    details:
      "An L4 require_approval rule's min_trust_baseline survived into the request (junior refused, senior allowed); an L4 deny rule still denied; an unmatched L4 fell to the floor baseline (junior allowed). The floor strengthens, never weakens.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: l4_floor_preserves_stricter_rule")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
