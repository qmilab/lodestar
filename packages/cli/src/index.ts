#!/usr/bin/env bun
/**
 * orrery — command-line interface
 *
 * Week-1 surface: propose an action, arbitrate it through a hard-coded
 * policy, execute it, and write events to the log.
 *
 * Usage:
 *   orrery action propose <tool> <inputs-json>
 *   orrery log tail [--project=<id>]
 *   orrery tools list
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { EventLogWriter, canonicalHash } from "@orrery/event-log"
import {
  ActionKernel,
  type PolicyDecision,
  listTools,
  lookupTool,
} from "@orrery/action-kernel"
import { registerFsReadTool } from "@orrery/adapter-filesystem"
import { registerGitStatusTool } from "@orrery/adapter-git"

const args = process.argv.slice(2)
const command = args[0] ?? "help"

const PROJECT_ID = "orrery-dev"
const SESSION_ID = `session-${Date.now()}`
const ACTOR_ID = "human-nandan"
const PROJECT_ROOT = process.cwd()
const LOG_DIR = resolve(PROJECT_ROOT, ".orrery", "events")

// -----------------------------------------------------------------------------
// Hard-coded policy gate for week 1.
//
// L0 and L1: auto-approve.
// L2: auto-approve.
// L3: auto-approve with notification on stderr.
// L4 and L5: prompt for confirmation (L4) or reject outright (L5).
//
// This is the simplest possible policy. The real policy kernel arrives
// in week 4 with the trust ladder properly enforced per (tool × scope).
// -----------------------------------------------------------------------------

async function policyGate(action: import("@orrery/core").Action): Promise<PolicyDecision> {
  const level = action.contract.required_level
  if (level <= 2) {
    return { approved: true, reason: `auto-approved at L${level}`, approver_id: "policy-stub" }
  }
  if (level === 3) {
    console.error(`[policy] L3 action approved with notification: ${action.intent}`)
    return { approved: true, reason: "L3 auto-approved with notification", approver_id: "policy-stub" }
  }
  if (level === 4) {
    // Week 1: prompt on stderr. Week 4 will use a proper approval surface.
    const summary = `L4 action: ${action.intent} via ${action.tool}`
    console.error(`[policy] ${summary}`)
    console.error("[policy] week-1 stub: rejecting L4 by default; real approval surface comes in week 6")
    return { approved: false, reason: "L4 requires explicit approval (not yet implemented)", approver_id: "policy-stub" }
  }
  return { approved: false, reason: `L${level} prohibited`, approver_id: "policy-stub" }
}

// Week 1: no live precondition checker. Returns "holds" for everything.
// Week 5 will plug in the real checker.
async function preconditionStub(): Promise<{ holds: boolean; observed: unknown }> {
  return { holds: true, observed: null }
}

const writer = new EventLogWriter(LOG_DIR)

async function emitEvent(type: string, payload: unknown): Promise<void> {
  const now = new Date().toISOString()
  await writer.append({
    id: randomUUID(),
    type,
    schema_version: "0.1.0",
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    actor_id: ACTOR_ID,
    timestamp: now,
    causal_parent_ids: [],
    payload,
    payload_hash: canonicalHash(payload),
    versions: {
      schema_registry_version: "0.1.0",
    },
  })
}

// Register the v0 tool set bound to the current working directory.
registerFsReadTool(PROJECT_ROOT)
registerGitStatusTool(PROJECT_ROOT)

const kernel = new ActionKernel(policyGate, preconditionStub, async (obs) => {
  await emitEvent("observation.recorded", obs)
})

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function cmdActionPropose(): Promise<void> {
  const toolName = args[2]
  const inputsJson = args[3] ?? "{}"

  if (!toolName) {
    console.error("usage: orrery action propose <tool> <inputs-json>")
    process.exit(2)
  }

  const tool = lookupTool(toolName)
  if (!tool) {
    console.error(`unknown tool: ${toolName}`)
    console.error(`available: ${listTools().join(", ")}`)
    process.exit(2)
  }

  let inputs: unknown
  try {
    inputs = JSON.parse(inputsJson)
  } catch {
    console.error(`invalid inputs JSON: ${inputsJson}`)
    process.exit(2)
  }

  const proposed = kernel.propose({
    intent: `invoke ${toolName}`,
    tool: toolName,
    inputs,
    contract: {
      required_level: tool.required_trust_level as 0 | 1 | 2 | 3 | 4 | 5,
      blast_radius: "self",
      reversibility: tool.reversibility,
      scope: { level: "project", identifier: PROJECT_ID },
      data_sensitivity: "private",
      preconditions: [],
    },
    proposed_by: ACTOR_ID,
  })
  await emitEvent("action.proposed", proposed)

  const arbitrated = await kernel.arbitrate(proposed)
  await emitEvent(
    arbitrated.phase === "approved" ? "action.approved" : "action.rejected",
    arbitrated,
  )

  if (arbitrated.phase !== "approved") {
    console.error(`action rejected: ${arbitrated.approval?.reason ?? "no reason"}`)
    process.exit(1)
  }

  const executed = await kernel.execute(arbitrated)
  await emitEvent(
    executed.phase === "completed" ? "action.completed" : "action.failed",
    executed,
  )

  console.log(JSON.stringify({ id: executed.id, phase: executed.phase }, null, 2))
}

function cmdToolsList(): void {
  const tools = listTools()
  for (const name of tools) {
    const t = lookupTool(name)
    if (!t) continue
    console.log(`${name}  L${t.required_trust_level}  ${t.sandbox}  ${t.permissions.join(",")}`)
  }
}

function cmdHelp(): void {
  console.log(`orrery — governed agentic cognition CLI

Usage:
  orrery action propose <tool> <inputs-json>
  orrery tools list
  orrery help

Examples:
  orrery action propose fs.read '{"path": "README.md"}'
  orrery action propose git.status '{"repo": "."}'
`)
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

switch (command) {
  case "action":
    if (args[1] === "propose") {
      await cmdActionPropose()
    } else {
      console.error("usage: orrery action propose <tool> <inputs-json>")
      process.exit(2)
    }
    break
  case "tools":
    if (args[1] === "list") {
      cmdToolsList()
    } else {
      console.error("usage: orrery tools list")
      process.exit(2)
    }
    break
  case "help":
  case "--help":
  case "-h":
    cmdHelp()
    break
  default:
    console.error(`unknown command: ${command}`)
    cmdHelp()
    process.exit(2)
}
