#!/usr/bin/env bun
/**
 * Probe: sentinel_alert_gates_dependent_action
 *
 * The arbitrate hook `sentinels.md` anticipated, and the slice-2 spec in
 * `policy-kernel.md`: a `suspicious-memory-origin` alert on belief B causes the
 * Policy Kernel to escalate the next action whose `belief_dependencies` include
 * B — while the sentinel itself still ONLY emitted an alert. Enforcement lives
 * in policy, not in the sentinel.
 *
 * Setup:
 *  - The REAL `SuspiciousMemoryOriginSentinel` is driven over a synthetic
 *    evidence→belief→decision stream so it emits a genuine `belief`-subject
 *    alert on `belief-B`. The sentinel does nothing else — it cannot block.
 *  - A permissive policy `[{ match: { required_level_lte: 3 }, effect: allow }]`
 *    that, absent the hook, auto-approves the L3 action.
 *  - The gate is compiled WITH the arbitrate hook (alert snapshot injected
 *    host-side) and, as a control, WITHOUT it.
 *
 * Assertions:
 *  1. The sentinel emitted exactly one alert, `belief`/`belief-B`, severity
 *     `warning` — it observed; it did not gate.
 *  2. Through the hooked gate, the action backed by `belief-B` arbitrates to
 *     `pending_approval`. `evaluate(action, ctx).escalation` shows the base
 *     verdict was `allow` (from a `rule`) and a single `sentinel_alert` signal
 *     lifted it to a hold, naming `belief-B`.
 *  3. A control action backed by `belief-C` (same alert snapshot) arbitrates to
 *     `approved` — the alert is scoped to `belief_dependencies`, so it does not
 *     gate an action that does not lean on the flagged belief.
 *  4. Through the un-hooked gate, the `belief-B` action arbitrates to
 *     `approved`. The alert alone changes nothing: only the Policy Kernel
 *     consuming it gates. This is the line the probe pins.
 */

import {
  ActionKernel,
  type PolicyGate,
  _resetToolsForTests,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import {
  type Action,
  type ActionContract,
  type EventEnvelope,
  type Policy,
  registry,
} from "@qmilab/lodestar-core"
import { SentinelRunner, SuspiciousMemoryOriginSentinel } from "@qmilab/lodestar-harness"
import {
  type ArbitrationContext,
  type BackingBelief,
  compile,
} from "@qmilab/lodestar-policy-kernel"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const OUT_KEY = "probe.arb_alert@1"

let seq = 0
function evt(type: string, payload: unknown): EventEnvelope {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    type,
    schema_version: "0.1.0",
    project_id: "proj",
    session_id: "sess",
    actor_id: "agent",
    timestamp: "2026-06-04T00:00:00.000Z",
    logical_clock: seq,
    causal_parent_ids: [],
    payload_hash: "hash",
    payload,
    versions: { schema_registry_version: "0.1.0" },
  }
}

function l3Contract(): ActionContract {
  return {
    required_level: 3,
    blast_radius: "project",
    reversibility: "reversible",
    scope: { level: "repo", identifier: "probe-repo" },
    data_sensitivity: "private",
    preconditions: [],
  }
}

function mkKernel(gate: PolicyGate) {
  return new ActionKernel(
    gate,
    async () => ({ holds: true, observed: null }),
    async () => {},
    { useStubsForTests: true },
  )
}

async function run(): Promise<ProbeResult> {
  if (!registry.has(OUT_KEY)) registry.register(OUT_KEY, z.object({ ran: z.boolean() }))
  _resetToolsForTests()
  registerTool({
    name: "memory.commit",
    inputs: z.object({}),
    output_schema_key: OUT_KEY,
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async () => ({ ran: true }),
  })

  // 1. Drive the real sentinel: external_document evidence → belief-B → a
  //    decision that leans on belief-B. It must emit one belief-scoped alert.
  const runner = new SentinelRunner([new SuspiciousMemoryOriginSentinel()])
  const alerts = await runner.sweep([
    evt("evidence.assessed", {
      claim_id: "claim-B",
      items: [{ source_id: "doc-1", quality: "external_document", relation: "supports" }],
    }),
    evt("belief.adopted", { id: "belief-B", claim_id: "claim-B" }),
    evt("decision.made", { id: "decision-1", belief_dependencies: ["belief-B"] }),
  ])
  if (alerts.length !== 1) {
    return {
      passed: false,
      details: `[1] sentinel emitted ${alerts.length} alerts; expected exactly 1.`,
    }
  }
  const alert = alerts[0]
  if (
    alert === undefined ||
    alert.payload.subject.kind !== "belief" ||
    alert.payload.subject.id !== "belief-B"
  ) {
    return {
      passed: false,
      details: `[1] alert subject was ${JSON.stringify(alert?.payload.subject)}; expected belief/belief-B.`,
    }
  }

  // The host hands the gate the recent alerts uniformly; the GATE scopes them to
  // each action's own beliefs. So `decision-1` leans on belief-B (the flagged
  // one), `decision-2` on belief-C (clean). Both beliefs are strong, so the
  // synchronous low-confidence check never fires — the alert is the only signal.
  const recentAlerts = [alert.payload]
  const beliefsByDecision: Record<string, BackingBelief[]> = {
    "decision-1": [
      { id: "belief-B", calibration_class: "general", confidence: 0.9, truth_status: "supported" },
    ],
    "decision-2": [
      { id: "belief-C", calibration_class: "general", confidence: 0.9, truth_status: "supported" },
    ],
  }
  const resolveContext = (action: Action): ArbitrationContext => ({
    alerts: recentAlerts,
    beliefs: action.decision_id ? (beliefsByDecision[action.decision_id] ?? []) : [],
  })

  const policy: Policy = {
    id: "allow-l3",
    version: "1",
    rules: [
      { match: { required_level_lte: 3 }, effect: "allow", reason: "auto-approve at or below L3" },
    ],
  }
  const hooked = compile(policy, {
    decider_id: "probe-policy",
    allow_unsigned: true,
    arbitration: { resolveContext },
  })
  const plain = compile(policy, { decider_id: "probe-policy", allow_unsigned: true })

  const kernel = mkKernel(hooked.gate)
  const kernelNoHook = mkKernel(plain.gate)

  const propose = (decision_id: string): Action =>
    kernel.propose({
      decision_id,
      intent: "commit memory",
      tool: "memory.commit",
      inputs: {},
      contract: l3Contract(),
      proposed_by: "agent",
    })

  // 2. Dependent action (belief-B) through the hooked gate → held by the alert.
  const dep = propose("decision-1")
  const depEval = hooked.evaluate(dep, resolveContext(dep))
  const depDone = await kernel.arbitrate(dep)
  if (depDone.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[2] belief-B action reached '${depDone.phase}'; expected 'pending_approval' (alert escalated allow→hold).`,
    }
  }
  if (depEval.matched.source !== "rule" || depEval.escalation?.from !== "allow") {
    return {
      passed: false,
      details: `[2] expected base verdict 'allow' from a 'rule'; got source '${depEval.matched.source}', escalation.from '${depEval.escalation?.from}'.`,
    }
  }
  const fired = depEval.escalation?.fired ?? []
  const alertSignal = fired.find((f) => f.signal === "sentinel_alert")
  if (fired.length !== 1 || !alertSignal || alertSignal.effect !== "hold") {
    return {
      passed: false,
      details: `[2] expected exactly one 'sentinel_alert' hold signal; got ${JSON.stringify(fired.map((f) => `${f.signal}:${f.effect}`))}.`,
    }
  }
  if ((alertSignal.detail?.subject as { id?: string } | undefined)?.id !== "belief-B") {
    return {
      passed: false,
      details: `[2] the firing alert did not name belief-B: ${JSON.stringify(alertSignal.detail)}.`,
    }
  }

  // 3. Control action (belief-C) through the same hooked gate → approved.
  const ctrl = propose("decision-2")
  const ctrlDone = await kernel.arbitrate(ctrl)
  if (ctrlDone.phase !== "approved") {
    return {
      passed: false,
      details: `[3] belief-C action reached '${ctrlDone.phase}'; expected 'approved' — the belief-B alert must not gate it.`,
    }
  }

  // 4. The belief-B action through the UN-hooked gate → approved. The alert
  //    alone gates nothing; only the Policy Kernel consuming it does.
  const depNoHook = kernelNoHook.propose({
    decision_id: "decision-1",
    intent: "commit memory",
    tool: "memory.commit",
    inputs: {},
    contract: l3Contract(),
    proposed_by: "agent",
  })
  const depNoHookDone = await kernelNoHook.arbitrate(depNoHook)
  if (depNoHookDone.phase !== "approved") {
    return {
      passed: false,
      details: `[4] without the hook the belief-B action reached '${depNoHookDone.phase}'; expected 'approved' — enforcement must come from the kernel consuming the alert, not the sentinel.`,
    }
  }

  return {
    passed: true,
    details:
      "The suspicious-memory-origin sentinel only emitted a belief-scoped alert; the Policy Kernel's arbitrate hook escalated the action depending on that belief (allow→pending_approval), left an unrelated action approved, and — without the hook — the same alert gated nothing. Enforcement lives in policy.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: sentinel_alert_gates_dependent_action")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
