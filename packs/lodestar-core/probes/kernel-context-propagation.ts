#!/usr/bin/env bun
/**
 * Probe: kernel_context_propagation
 *
 * Verifies the Round 5 fix: `ActionKernel` accepts explicit
 * `session_id` and `project_id`, and the host-provided values flow
 * through to every event-log entry written by an action.
 *
 * Pre-fix behavior: the kernel silently fell back to
 * `"session-stub"` / `"project-stub"` when no resolver was supplied.
 * Production traces could end up tied to the stubs instead of the
 * real session, which the MCP proxy (Batch 3) cannot tolerate —
 * every action / observation / claim / belief tied to a real MCP
 * client session must carry that session's id.
 *
 * This probe:
 *   1. Constructs an ActionKernel with explicit
 *      `{ session_id, project_id }` (NOT the stub fallback).
 *   2. Runs one action through propose → arbitrate → execute.
 *   3. Routes the resulting observation through an EventLogWriter.
 *   4. Reads the NDJSON log back and verifies every envelope carries
 *      the host-provided session_id and project_id — NOT the stubs.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ActionKernel,
  type PolicyGate,
  type PreconditionChecker,
  _resetToolsForTests,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import type { Action, ActionContract, EventEnvelope, Observation } from "@qmilab/lodestar-core"
import { registry } from "@qmilab/lodestar-core"
import { EventLogReader, EventLogWriter } from "@qmilab/lodestar-event-log"
import { z } from "zod"

interface ProbeResult {
  passed: boolean
  details: string
}

const REAL_SESSION_ID = "probe-session-real-7e3f"
const REAL_PROJECT_ID = "probe-project-real-9a1c"

// Build a trivial echo tool the kernel can execute.
const EchoInputSchema = z.object({ message: z.string() })
const EchoOutputSchema = z.object({ echoed: z.string() })

async function run(): Promise<ProbeResult> {
  _resetToolsForTests()
  registry.register("probe.echo@1", EchoOutputSchema)

  registerTool({
    name: "probe.echo",
    inputs: EchoInputSchema,
    output_schema_key: "probe.echo@1",
    effects: [],
    reversibility: "reversible",
    permissions: [],
    required_trust_level: 0,
    sandbox: "read",
    execute: async (input) => ({ echoed: input.message }),
  })

  const policyGate: PolicyGate = async () => ({
    approved: true,
    reason: "probe always approves",
    approver_id: "probe.kernel-context",
  })
  const preconditionChecker: PreconditionChecker = async () => ({
    holds: true,
    observed: null,
  })

  const logDir = await mkdtemp(join(tmpdir(), "lodestar-probe-kctx-"))
  try {
    const writer = new EventLogWriter(logDir)

    // Observation sink: write the observation to the event log under
    // the REAL session/project ids, then return.
    const observations: Observation[] = []
    const observationSink = async (obs: Observation) => {
      observations.push(obs)
      await writer.append({
        id: crypto.randomUUID(),
        type: "observation.recorded",
        schema_version: "0.1.0",
        timestamp: new Date().toISOString(),
        session_id: obs.context.session_id,
        project_id: obs.context.project_id,
        actor_id: obs.context.actor_id,
        causal_parent_ids: [],
        payload: obs,
        versions: {},
      })
    }

    // Explicit kernel context — no stub fallback. This is the API
    // the MCP proxy will use (it'll pass the per-MCP-request session).
    const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
      session_id: REAL_SESSION_ID,
      project_id: REAL_PROJECT_ID,
    })

    const contract: ActionContract = {
      required_level: 0,
      blast_radius: "self",
      reversibility: "reversible",
      scope: { level: "project", identifier: REAL_PROJECT_ID },
      data_sensitivity: "internal",
      preconditions: [],
    }
    const proposed: Action = kernel.propose({
      intent: "probe propagation",
      tool: "probe.echo",
      inputs: { message: "hello" },
      contract,
      proposed_by: "probe.kernel-context",
    })

    // Mirror the proposal into the event log too, so we have multiple
    // envelopes to verify against.
    await writer.append({
      id: crypto.randomUUID(),
      type: "action.proposed",
      schema_version: "0.1.0",
      timestamp: new Date().toISOString(),
      session_id: REAL_SESSION_ID,
      project_id: REAL_PROJECT_ID,
      actor_id: "probe.kernel-context",
      causal_parent_ids: [],
      payload: proposed,
      versions: {},
    })

    const arbitrated = await kernel.arbitrate(proposed)
    if (arbitrated.phase !== "approved") {
      return { passed: false, details: `arbitration failed: phase=${arbitrated.phase}` }
    }

    const executed = await kernel.execute(arbitrated)
    if (executed.phase !== "completed") {
      return { passed: false, details: `execute did not complete: phase=${executed.phase}` }
    }

    // 1. Inline check on the observation captured during execute() —
    //    must carry the host-provided session/project, NOT stubs.
    if (observations.length !== 1) {
      return {
        passed: false,
        details: `expected exactly 1 observation, got ${observations.length}`,
      }
    }
    const [obs] = observations
    if (!obs) {
      return { passed: false, details: "observation slot 0 was undefined" }
    }
    if (obs.context.session_id !== REAL_SESSION_ID) {
      return {
        passed: false,
        details:
          `observation.context.session_id = '${obs.context.session_id}', ` +
          `expected '${REAL_SESSION_ID}'. Likely the kernel fell back to a stub.`,
      }
    }
    if (obs.context.project_id !== REAL_PROJECT_ID) {
      return {
        passed: false,
        details:
          `observation.context.project_id = '${obs.context.project_id}', ` +
          `expected '${REAL_PROJECT_ID}'. Likely the kernel fell back to a stub.`,
      }
    }

    // 2. Read the persisted event log back and check every envelope.
    const reader = new EventLogReader(logDir)
    const envelopes: EventEnvelope[] = await reader.readAll(REAL_PROJECT_ID)

    if (envelopes.length < 2) {
      return {
        passed: false,
        details: `expected at least 2 event log envelopes, got ${envelopes.length}`,
      }
    }

    for (const env of envelopes) {
      if (env.session_id === "session-stub" || env.project_id === "project-stub") {
        return {
          passed: false,
          details: `event log envelope ${env.id} carries a stub id (session_id='${env.session_id}', project_id='${env.project_id}'). The kernel stub fallback is leaking into persisted events.`,
        }
      }
      if (env.session_id !== REAL_SESSION_ID) {
        return {
          passed: false,
          details:
            `event log envelope ${env.id} has session_id='${env.session_id}', ` +
            `expected '${REAL_SESSION_ID}'.`,
        }
      }
      if (env.project_id !== REAL_PROJECT_ID) {
        return {
          passed: false,
          details:
            `event log envelope ${env.id} has project_id='${env.project_id}', ` +
            `expected '${REAL_PROJECT_ID}'.`,
        }
      }
    }

    return {
      passed: true,
      details: `Kernel constructed with explicit { session_id, project_id }; the host-provided values propagated through the observation context and into all ${envelopes.length} persisted event log envelopes. No stub leak.`,
    }
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
}

const result = await run()
console.log("─".repeat(72))
console.log("probe: kernel_context_propagation")
console.log("─".repeat(72))
console.log(`status: ${result.passed ? "PASS ✓" : "FAIL ✗"}`)
console.log(result.details)
console.log("─".repeat(72))

if (!result.passed) process.exit(1)
