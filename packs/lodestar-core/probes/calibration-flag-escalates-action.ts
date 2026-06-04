#!/usr/bin/env bun
/**
 * Probe: calibration_flag_escalates_action
 *
 * The calibrator side of the slice-2 arbitrate hook (`policy-kernel.md`): an
 * action backed by a belief whose `calibration_class` the calibrator flagged as
 * miscalibrated is escalated to `require_approval` — while the calibrator itself
 * only measured. Acting on a flag is the Policy Kernel's job, not the harness's.
 *
 * Setup:
 *  - The REAL `Calibrator` is run over a synthetic log: an
 *    `overconfident-class` whose beliefs all state confidence 0.95 yet are all
 *    contradicted (6 samples > min_samples), and a `calibrated-class` whose
 *    confidence tracks accuracy. The calibrator returns a `CalibrationReport`;
 *    it writes nothing and transitions no belief.
 *  - A permissive policy `[{ match: { required_level_lte: 3 }, effect: allow }]`
 *    that, absent the hook, auto-approves the L3 action.
 *  - The gate is compiled WITH the arbitrate hook (the report injected
 *    host-side) and, as a control, WITHOUT it.
 *
 * Assertions:
 *  1. The calibrator flagged `overconfident-class` and NOT `calibrated-class` —
 *     it measured; it enforced nothing.
 *  2. Through the hooked gate, an action backed by a belief in the flagged class
 *     arbitrates to `pending_approval`. `evaluate(action, ctx).escalation` shows
 *     the base verdict was `allow` (from a `rule`) and a `calibration_flag`
 *     signal lifted it to a hold, naming the flagged class.
 *  3. A control action backed by the well-calibrated class arbitrates to
 *     `approved` — escalation is scoped to the action's backing belief classes.
 *  4. Through the un-hooked gate, the flagged-class action arbitrates to
 *     `approved`. The report alone enforces nothing: only the Policy Kernel
 *     consuming it gates.
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
import { calibrate } from "@qmilab/lodestar-harness"
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

const OUT_KEY = "probe.arb_calib@1"
const FLAGGED = "overconfident-class"
const WELL = "calibrated-class"

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

/** A belief.adopted + a truth_status adjudication, the calibrator's sample. */
function sample(
  id: string,
  calibration_class: string,
  confidence: number,
  supported: boolean,
): EventEnvelope[] {
  return [
    evt("belief.adopted", {
      id,
      claim_id: `claim-${id}`,
      confidence,
      calibration_class,
      authority: "observed",
    }),
    evt("firewall.belief.transitioned", {
      belief_id: id,
      axis: "truth_status",
      to_value: supported ? "supported" : "contradicted",
    }),
  ]
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

  // 1. Run the real calibrator. overconfident-class: confidence 0.95, all wrong
  //    → big gap, flagged. calibrated-class: confidence 0.8, ~0.83 accuracy →
  //    within threshold, not flagged.
  const stream: EventEnvelope[] = []
  for (let i = 0; i < 6; i += 1) stream.push(...sample(`oc-${i}`, FLAGGED, 0.95, false))
  for (let i = 0; i < 6; i += 1) stream.push(...sample(`wc-${i}`, WELL, 0.8, i < 5))
  const report = calibrate(stream)

  if (!report.flagged_classes.includes(FLAGGED) || report.flagged_classes.includes(WELL)) {
    return {
      passed: false,
      details: `[1] calibrator flagged ${JSON.stringify(report.flagged_classes)}; expected to include '${FLAGGED}' and exclude '${WELL}'.`,
    }
  }

  // The host hands the gate the report; the GATE scopes flagged classes to each
  // action's backing belief classes. Both beliefs are confident+supported, so
  // the synchronous low-confidence check never fires — the flag is the only
  // signal in play.
  const beliefsByDecision: Record<string, BackingBelief[]> = {
    "decision-flagged": [
      { id: "belief-f", calibration_class: FLAGGED, confidence: 0.95, truth_status: "supported" },
    ],
    "decision-well": [
      { id: "belief-w", calibration_class: WELL, confidence: 0.95, truth_status: "supported" },
    ],
  }
  const resolveContext = (action: Action): ArbitrationContext => ({
    calibration: report,
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

  const propose = (k: ActionKernel, decision_id: string): Action =>
    k.propose({
      decision_id,
      intent: "commit memory",
      tool: "memory.commit",
      inputs: {},
      contract: l3Contract(),
      proposed_by: "agent",
    })

  // 2. Flagged-class action through the hooked gate → held by the flag.
  const flagged = propose(kernel, "decision-flagged")
  const flaggedEval = hooked.evaluate(flagged, resolveContext(flagged))
  const flaggedDone = await kernel.arbitrate(flagged)
  if (flaggedDone.phase !== "pending_approval") {
    return {
      passed: false,
      details: `[2] flagged-class action reached '${flaggedDone.phase}'; expected 'pending_approval' (calibration flag escalated allow→hold).`,
    }
  }
  if (flaggedEval.matched.source !== "rule" || flaggedEval.escalation?.from !== "allow") {
    return {
      passed: false,
      details: `[2] expected base verdict 'allow' from a 'rule'; got source '${flaggedEval.matched.source}', escalation.from '${flaggedEval.escalation?.from}'.`,
    }
  }
  const fired = flaggedEval.escalation?.fired ?? []
  const calibSignal = fired.find((f) => f.signal === "calibration_flag")
  if (fired.length !== 1 || !calibSignal || calibSignal.effect !== "hold") {
    return {
      passed: false,
      details: `[2] expected exactly one 'calibration_flag' hold signal; got ${JSON.stringify(fired.map((f) => `${f.signal}:${f.effect}`))}.`,
    }
  }
  const flaggedInDetail = (calibSignal.detail?.flagged_classes as string[] | undefined) ?? []
  if (!flaggedInDetail.includes(FLAGGED)) {
    return {
      passed: false,
      details: `[2] the firing signal did not name '${FLAGGED}': ${JSON.stringify(calibSignal.detail)}.`,
    }
  }

  // 3. Well-calibrated-class action through the same hooked gate → approved.
  const well = propose(kernel, "decision-well")
  const wellDone = await kernel.arbitrate(well)
  if (wellDone.phase !== "approved") {
    return {
      passed: false,
      details: `[3] calibrated-class action reached '${wellDone.phase}'; expected 'approved' — the flag must not gate an action outside the flagged class.`,
    }
  }

  // 4. Flagged-class action through the UN-hooked gate → approved.
  const flaggedNoHook = propose(kernelNoHook, "decision-flagged")
  const flaggedNoHookDone = await kernelNoHook.arbitrate(flaggedNoHook)
  if (flaggedNoHookDone.phase !== "approved") {
    return {
      passed: false,
      details: `[4] without the hook the flagged-class action reached '${flaggedNoHookDone.phase}'; expected 'approved' — enforcement must come from the kernel consuming the report, not the calibrator.`,
    }
  }

  return {
    passed: true,
    details:
      "The calibrator only flagged the overconfident class in its report; the Policy Kernel's arbitrate hook escalated the action backed by that class (allow→pending_approval), left a well-calibrated action approved, and — without the hook — the same report gated nothing. Enforcement lives in policy.",
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: calibration_flag_escalates_action")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
