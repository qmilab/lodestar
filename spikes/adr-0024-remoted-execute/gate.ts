/**
 * ADR-0024 spike — the governance-gate sidecar (TS side).
 *
 * Throwaway proof-of-concept (NOT production; not part of PR #124). It validates
 * the one riskiest claim in ADR-0024: "from the kernel's perspective the Python
 * hook is just another downstream" — i.e. the REAL ActionKernel can register a
 * tool whose execute() remotes BACK over a bidirectional stdio NDJSON-RPC to
 * Python, and two-phase still holds (the Python tool body runs ONLY inside the
 * execute phase, never before approval).
 *
 * Run indirectly via hook.py, which spawns `bun run gate.ts` from the repo root.
 * stdout carries ONLY protocol JSON (one object per line); all diagnostics go to
 * stderr so they never corrupt the wire.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import {
  type Action,
  ActionKernel,
  type ApprovalOutcome,
  type PolicyDecision,
  type Tool,
  registerTool,
} from "@qmilab/lodestar-action-kernel"
import type { ActionContract, Observation } from "@qmilab/lodestar-core"
import { registry } from "@qmilab/lodestar-core"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Wire helpers — protocol JSON on stdout, diagnostics on stderr.
// ---------------------------------------------------------------------------
function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}
function log(...args: unknown[]): void {
  console.error("[gate]", ...args)
}

// ---------------------------------------------------------------------------
// The remoting tool. Its execute() is a re-entrant RPC back to Python.
// AsyncLocalStorage threads the action id into execute() concurrency-safely —
// the kernel does not pass the action id to tool.execute(inputs, ctx), so this
// is the seam the real adapter must use (a finding worth recording).
// ---------------------------------------------------------------------------
const RemoteResultSchema = z
  .object({ ran: z.boolean(), echo: z.string(), seq: z.number().int() })
  .describe("ADR-0024 spike remote tool result")
registry.register("spike.remote_result@1", RemoteResultSchema)

const RemoteInputSchema = z.object({ msg: z.string() })

const als = new AsyncLocalStorage<{ actionId: string }>()

let corrCounter = 0
const pendingToolRuns = new Map<
  number,
  { resolve: (out: unknown) => void; reject: (err: Error) => void }
>()

/** The re-entrant remoted execute: ask Python to run the real tool body, await it. */
async function remoteExecute(inputs: z.infer<typeof RemoteInputSchema>): Promise<unknown> {
  const actionId = als.getStore()?.actionId ?? "unknown"
  const corr = ++corrCounter
  log(`execute phase reached -> remoting run_tool corr=${corr} action=${actionId}`)
  const out = await new Promise<unknown>((resolve, reject) => {
    pendingToolRuns.set(corr, { resolve, reject })
    send({ type: "run_tool", id: corr, tool: "remote.call", args: inputs, action_id: actionId })
  })
  return out
}

const remoteTool: Tool<z.infer<typeof RemoteInputSchema>, unknown> = {
  name: "remote.call",
  inputs: RemoteInputSchema,
  output_schema_key: "spike.remote_result@1",
  effects: [{ kind: "external_call", description: "remoted to the LangGraph hook" }],
  reversibility: "reversible",
  permissions: [],
  required_trust_level: 0,
  sandbox: "read",
  preconditions: () => [],
  execute: remoteExecute,
}
registerTool(remoteTool)

// ---------------------------------------------------------------------------
// The engine: REAL ActionKernel + a stand-in policy gate (the kernel only ever
// sees a function, so a stand-in is architecturally identical to the real
// compiled gate; the gate is not what this spike is de-risking).
// ---------------------------------------------------------------------------
const policyGate = async (action: Action): Promise<PolicyDecision> => {
  if (action.contract.required_level >= 4) {
    return {
      approved: false,
      requires_human_approval: true,
      reason: "L4 requires human approval",
      approver_id: "spike-gate",
    }
  }
  return { approved: true, reason: "below approval floor", approver_id: "spike-gate" }
}

const preconditionChecker = async () => ({ holds: true, observed: null })

/** Captured observations, keyed by action id — proves the result entered the chain. */
const observations = new Map<string, unknown>()
let observationCount = 0
const observationSink = async (obs: Observation): Promise<void> => {
  observationCount += 1
  observations.set(obs.source.invocation_id, obs.payload)
  log(`observationSink: ingested observation for action=${obs.source.invocation_id}`)
}

const kernel = new ActionKernel(policyGate, preconditionChecker, observationSink, {
  session_id: "spike-session",
  project_id: "spike-project",
})

// ---------------------------------------------------------------------------
// Hold/idempotency state. In-memory here (the spike proves the RPC mechanic);
// ADR-0024 §5 specifies the REAL adapter reconstructs this from the durable
// event log + signed side-channel so it survives a sidecar restart.
// ---------------------------------------------------------------------------
const pendingActions = new Map<string, Action>()
const executedOutcomes = new Map<string, Record<string, unknown>>() // exactly-once cache

function contractFor(requiredLevel: number): ActionContract {
  return {
    required_level: requiredLevel,
    blast_radius: requiredLevel >= 4 ? "external" : "session",
    reversibility: "reversible",
    scope: { level: "session", identifier: "spike-session" },
    data_sensitivity: "public",
    preconditions: [],
  }
}

async function runExecute(action: Action): Promise<Record<string, unknown>> {
  const executed = await als.run({ actionId: action.id }, () => kernel.execute(action))
  const result = {
    type: "govern_result",
    phase: executed.phase,
    action_id: action.id,
    output: observations.get(action.id) ?? null,
  }
  executedOutcomes.set(action.id, result)
  pendingActions.delete(action.id)
  return result
}

// ---------------------------------------------------------------------------
// Message handlers.
// ---------------------------------------------------------------------------
async function handleGovern(msg: {
  id: number
  tool: string
  args: { msg: string }
  required_level: number
}): Promise<void> {
  const proposed = kernel.propose({
    intent: "spike govern",
    tool: "remote.call",
    inputs: msg.args,
    contract: contractFor(msg.required_level),
    proposed_by: "spike-agent",
  })
  const arbitrated = await kernel.arbitrate(proposed)

  if (arbitrated.phase === "pending_approval") {
    pendingActions.set(arbitrated.id, arbitrated)
    log(`govern id=${msg.id} HELD at pending_approval action=${arbitrated.id} (no execute)`)
    send({ type: "govern_result", id: msg.id, phase: "pending_approval", action_id: arbitrated.id })
    return
  }
  if (arbitrated.phase === "rejected") {
    send({ type: "govern_result", id: msg.id, phase: "rejected", action_id: arbitrated.id })
    return
  }
  const result = await runExecute(arbitrated)
  send({ ...result, id: msg.id })
}

async function handleResolve(msg: {
  id: number
  action_id: string
  kind: "granted" | "denied"
  approver_id: string
}): Promise<void> {
  // Exactly-once: a duplicate resolve returns the cached outcome, never re-runs.
  const cached = executedOutcomes.get(msg.action_id)
  if (cached) {
    log(`resolve id=${msg.id} action=${msg.action_id} IDEMPOTENT (cached; no re-execute)`)
    send({ ...cached, id: msg.id })
    return
  }
  const parked = pendingActions.get(msg.action_id)
  if (!parked) {
    send({ type: "govern_result", id: msg.id, phase: "error", action_id: msg.action_id })
    return
  }
  const outcome: ApprovalOutcome = {
    kind: msg.kind,
    action_id: msg.action_id,
    request_id: "spike-request",
    approver_id: msg.approver_id,
  }
  const resolved = kernel.resolve(parked, outcome)
  if (resolved.phase !== "approved") {
    const denied = { type: "govern_result", phase: "rejected", action_id: msg.action_id, output: null }
    executedOutcomes.set(msg.action_id, denied)
    pendingActions.delete(msg.action_id)
    send({ ...denied, id: msg.id })
    return
  }
  const result = await runExecute(resolved)
  send({ ...result, id: msg.id })
}

function handleToolResult(msg: { id: number; output: unknown }): void {
  const pending = pendingToolRuns.get(msg.id)
  if (!pending) {
    log(`stray tool_result corr=${msg.id}`)
    return
  }
  pendingToolRuns.delete(msg.id)
  pending.resolve(msg.output)
}

function dispatch(line: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch (err) {
    log("bad JSON:", line)
    return
  }
  switch (msg.type) {
    case "govern":
      void handleGovern(msg as never)
      break
    case "resolve":
      void handleResolve(msg as never)
      break
    case "tool_result":
      handleToolResult(msg as never)
      break
    case "shutdown":
      log(`shutting down (observations ingested: ${observationCount})`)
      process.exit(0)
      break
    default:
      log("unknown message type:", msg.type)
  }
}

// ---------------------------------------------------------------------------
// stdin line reader.
// ---------------------------------------------------------------------------
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let idx: number
  // biome-ignore lint/suspicious/noAssignInExpressions: standard line-split loop
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.trim()) dispatch(line)
  }
})
process.stdin.on("end", () => process.exit(0))

log("gate ready (real ActionKernel; remote.call registered)")
send({ type: "ready" })
