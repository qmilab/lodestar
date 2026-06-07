#!/usr/bin/env bun
/**
 * Probe: guard_hold_resolves_via_resolver
 *
 * The in-process host wiring for the three-valued gate: when a policy *holds*
 * an action (the trust-ladder floor parks an L4 at `pending_approval`),
 * `guard.wrap()` opens an `ApprovalRequest`, awaits the configured
 * `approval_resolver`, and un-parks the action via the Action Kernel's
 * `resolve()` — emitting the canonical `approval.*` wire events along the way.
 *
 * Assertions:
 * 1. With a granting resolver, a held L4 action un-parks to `approved` and
 *    executes exactly once; the event log carries `approval.requested@1`,
 *    `approval.granted@1`, `action.approved`, and `action.completed`.
 * 2. With a denying resolver, the held action is rejected — `callTool` throws
 *    and the tool never runs; the log carries `approval.denied@1`.
 * 3. Adversarial: a policy that can hold but NO `approval_resolver` makes
 *    `callTool` throw (a clear "no resolver" error) rather than silently
 *    approving or denying — and the tool never runs. No silent default on a
 *    security-relevant path.
 * 4. A `CompiledPolicy` whose arbitrate hook escalates `allow → hold` (a
 *    low-confidence backing belief) still opens a request and resolves. The
 *    context-free `evaluate()` re-run returns the base `allow`, so the resolver
 *    path must fall back to the parked action's audit rather than throwing on a
 *    non-hold re-evaluation.
 *
 * Why this matters: the resolver seam is what makes a hold resolvable in
 * process — the load-bearing guarantee that the solo workflow is never gated.
 * If a hold could execute without a resolution, or silently resolve itself, the
 * whole human-approval workflow would be advisory.
 */

import { _resetToolsForTests, registerTool } from "@qmilab/lodestar-action-kernel"
import { type Actor, registry } from "@qmilab/lodestar-core"
import { EventLogReader } from "@qmilab/lodestar-event-log"
import {
  type ApprovalResolver,
  type GuardConfig,
  type Policy,
  alwaysHoldsChecker,
  authorizeResolution,
  autoApprovePolicy,
  compile,
  runGuarded,
} from "@qmilab/lodestar-guard"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.hold_resolve@1"
const PROJECT_ID = "probe-hold-resolve"
const LOG_ROOT = "/tmp/lodestar-probe-hold-resolve-log"

const APPROVER: Actor = {
  id: "human-approver",
  kind: "human",
  display_name: "Approver",
  authority_scope: [{ level: "global", identifier: "*" }],
  trust_baseline: 1,
  sensitivity_clearance: "secret",
  created_at: "2026-06-04T00:00:00Z",
}

/** A resolver that grants every request it is authorised for. */
const grantingResolver: ApprovalResolver = async (request) => {
  const auth = authorizeResolution(request, APPROVER, "granted", { reason: "probe approves" })
  if (!auth.authorized) throw new Error(`probe approver was refused: ${auth.reason}`)
  return auth.outcome
}

/** A resolver that denies every request it is authorised for. */
const denyingResolver: ApprovalResolver = async (request) => {
  const auth = authorizeResolution(request, APPROVER, "denied", { reason: "probe denies" })
  if (!auth.authorized) throw new Error(`probe approver was refused: ${auth.reason}`)
  return auth.outcome
}

let executeCalls = 0
// Read the counter through a function so the comparisons below see its declared
// `number` type. It is mutated only inside the `execute` closure, which TS
// control-flow analysis cannot follow across the kernel call, so a direct read
// narrows to the literal initializer and flags `!== 0` / `!== 1` as vacuous.
const callCount = (): number => executeCalls

function registerProbeTool(): void {
  _resetToolsForTests()
  executeCalls = 0
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
}

/** Base config shared by every case; the policy holds L4 via the floor. */
function baseConfig(): Omit<GuardConfig, "approval_resolver"> {
  return {
    project_id: PROJECT_ID,
    actor_id: "probe-agent",
    log_root: LOG_ROOT,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    // Ceiling L3: ≤L3 auto-approves, L4 always holds (trust-ladder floor).
    policy_gate: autoApprovePolicy({ auto_approve_up_to: 3, approver_id: "probe-policy" }),
    precondition_checker: alwaysHoldsChecker,
  }
}

async function sessionEventTypes(sessionId: string): Promise<string[]> {
  const events = await new EventLogReader(LOG_ROOT).readSession(PROJECT_ID, sessionId)
  return events.map((e) => e.type)
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))

  // ── 1. Granting resolver: held L4 un-parks and executes once. ──────────────
  registerProbeTool()
  const granted = await runGuarded(
    async (ctx) => {
      await ctx.callTool("probe.push", {}, { contract: { required_level: 4 } })
      return "ok"
    },
    { ...baseConfig(), approval_resolver: grantingResolver },
  )
  if (granted.result !== "ok") {
    return {
      passed: false,
      details: `[1] guarded loop returned '${granted.result}'; expected 'ok'.`,
    }
  }
  if (callCount() !== 1) {
    return {
      passed: false,
      details: `[1] tool ran ${executeCalls}x; expected exactly 1 after a grant.`,
    }
  }
  const grantTypes = await sessionEventTypes(granted.session_id)
  for (const required of [
    "approval.requested",
    "approval.granted",
    "action.approved",
    "action.completed",
  ]) {
    if (!grantTypes.includes(required)) {
      return {
        passed: false,
        details: `[1] event log missing '${required}'. Got: ${grantTypes.join(", ")}`,
      }
    }
  }

  // ── 2. Denying resolver: held L4 is rejected; tool never runs. ─────────────
  registerProbeTool()
  let denyThrew = false
  const denied = await runGuarded(
    async (ctx) => {
      try {
        await ctx.callTool("probe.push", {}, { contract: { required_level: 4 } })
        return "should-have-thrown"
      } catch {
        denyThrew = true
        return "threw"
      }
    },
    { ...baseConfig(), approval_resolver: denyingResolver },
  )
  if (!denyThrew || denied.result !== "threw") {
    return { passed: false, details: "[2] a denied hold did not make callTool throw." }
  }
  if (callCount() !== 0) {
    return { passed: false, details: `[2] tool ran ${executeCalls}x after a denial; expected 0.` }
  }
  const denyTypes = await sessionEventTypes(denied.session_id)
  if (!denyTypes.includes("approval.denied")) {
    return {
      passed: false,
      details: `[2] event log missing 'approval.denied'. Got: ${denyTypes.join(", ")}`,
    }
  }
  if (denyTypes.includes("action.completed")) {
    return { passed: false, details: "[2] a denied action still reached action.completed." }
  }

  // ── 3. Adversarial: hold with NO resolver throws (no silent default). ──────
  registerProbeTool()
  let noResolverThrew = false
  let noResolverMessage = ""
  const noResolver = await runGuarded(
    async (ctx) => {
      try {
        await ctx.callTool("probe.push", {}, { contract: { required_level: 4 } })
        return "should-have-thrown"
      } catch (err) {
        noResolverThrew = true
        noResolverMessage = err instanceof Error ? err.message : String(err)
        return "threw"
      }
    },
    baseConfig(), // <-- deliberately no approval_resolver
  )
  if (!noResolverThrew || noResolver.result !== "threw") {
    return {
      passed: false,
      details: "[3] a hold with no approval_resolver did not throw — it must not silently resolve.",
    }
  }
  if (!/resolver|approval|held|pending_approval/i.test(noResolverMessage)) {
    return {
      passed: false,
      details: `[3] the no-resolver error did not explain the missing resolver. Got: ${noResolverMessage}`,
    }
  }
  if (callCount() !== 0) {
    return { passed: false, details: `[3] tool ran ${executeCalls}x with no resolver; expected 0.` }
  }

  // ── 4. Arbitration-escalated hold (allow → hold) on a CompiledPolicy. ──────
  registerProbeTool()
  const allowAll: Policy = {
    id: "allow-all",
    version: "1",
    rules: [{ match: {}, effect: "allow", reason: "allow everything (probe)" }],
  }
  const escalatingPolicy = compile(allowAll, {
    decider_id: "probe-policy",
    allow_unsigned: true,
    arbitration: {
      // A low-confidence / unverified backing belief escalates an L>=3 `allow`
      // to a `hold` (the synchronous low-confidence check) — a hold the
      // context-free evaluate() re-run cannot see.
      resolveContext: () => ({
        beliefs: [
          {
            id: "weak-belief",
            calibration_class: "probe-class",
            confidence: 0.1,
            truth_status: "unverified",
          },
        ],
      }),
    },
  })
  const escalated = await runGuarded(
    async (ctx) => {
      await ctx.callTool("probe.push", {}, { contract: { required_level: 3 } })
      return "ok"
    },
    { ...baseConfig(), policy_gate: escalatingPolicy, approval_resolver: grantingResolver },
  )
  if (escalated.result !== "ok") {
    return {
      passed: false,
      details: `[4] arbitration-escalated hold did not resolve; loop returned '${escalated.result}'. The resolver path must fall back to the parked action when evaluate() re-runs to a non-hold.`,
    }
  }
  if (callCount() !== 1) {
    return {
      passed: false,
      details: `[4] tool ran ${executeCalls}x after an escalated hold was granted; expected exactly 1.`,
    }
  }
  const escTypes = await sessionEventTypes(escalated.session_id)
  for (const required of [
    "action.pending_approval",
    "approval.requested",
    "approval.granted",
    "action.completed",
  ]) {
    if (!escTypes.includes(required)) {
      return {
        passed: false,
        details: `[4] event log missing '${required}'. Got: ${escTypes.join(", ")}`,
      }
    }
  }

  return {
    passed: true,
    details:
      "A granting resolver un-parked a held L4 action to approved (executed once; approval.requested + approval.granted logged); a denying resolver rejected it (tool never ran; approval.denied logged); a hold with no resolver threw rather than silently resolving; and an arbitration-escalated allow->hold on a compiled policy still opened a request and resolved.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: guard_hold_resolves_via_resolver")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
