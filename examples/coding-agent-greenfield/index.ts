/**
 * Coding-agent greenfield example.
 *
 * Demonstrates `guard.wrap()` applied to a tiny home-grown coding-agent
 * loop. The agent is asked: "summarise this repo." It observes the
 * project state, reads a couple of files, forms beliefs, makes a
 * decision, and finishes — without taking any side-effectful action.
 *
 * Every step lands in the event log. After the run, `orrery report
 * <session-id>` (or the trace library used inline below) renders a
 * markdown trust report explaining what the agent did and why.
 *
 *   bun run examples/coding-agent-greenfield/index.ts
 *
 * The example is read-only: it never modifies the project. If you want
 * to see how the policy gate behaves on a denied request, pass
 * `--simulate-denied-tool` to ask the agent to invoke a tool above the
 * auto-approve ceiling.
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import {
  alwaysHoldsChecker,
  autoApprovePolicy,
  wrap,
  type GuardContext,
} from "@orrery/guard"
import { registerFsReadTool } from "@orrery/adapter-filesystem"
import { registerGitStatusTool } from "@orrery/adapter-git"
import {
  defaultLogRoot,
  loadSessionEvents,
  projectChain,
  renderReport,
} from "@orrery/trace"

const PROJECT_ROOT = process.cwd()
const PROJECT_ID = "coding-agent-greenfield"
const ACTOR_ID = "greenfield-agent"
const SIMULATE_DENIED = process.argv.includes("--simulate-denied-tool")

// Register the tools the agent is allowed to call.
registerFsReadTool(PROJECT_ROOT)
registerGitStatusTool(PROJECT_ROOT)

interface AgentResult {
  branch: string
  read_files: string[]
  decision_id: string
  summary: string
}

async function agentLoop(ctx: GuardContext): Promise<AgentResult> {
  // Step 1: observe the repo's git state.
  const { output: gitOut } = await ctx.callTool<{ branch: string; dirty: string[] }>(
    "git.status",
    { repo: "." },
    { intent: "establish baseline of project state" },
  )

  // Step 2: read a couple of files we expect to exist. Each call goes
  // through the full action kernel → cognitive core pipeline and lands
  // claim/belief events in the log.
  const filesToRead = ["README.md", "package.json"]
  const readFiles: string[] = []
  for (const path of filesToRead) {
    try {
      await ctx.callTool("fs.read", { path }, { intent: `read ${path}` })
      readFiles.push(path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ctx.emit("agent.note", { kind: "skipped-file", path, reason: message })
    }
  }

  // Step 3: produce a Decision based on what we believe. The greenfield
  // path does not yet bind decisions to specific belief IDs; the
  // dependency pipeline lands in Batch 4. For now we emit a
  // decision.made event with the actor's rationale.
  const decision_id = randomUUID()
  await ctx.emit("decision.made", {
    id: decision_id,
    project_id: ctx.project_id,
    session_id: ctx.session_id,
    intent: "summarise the repo without modifying it",
    chosen_option: {
      label: "report-only",
      rationale: `${readFiles.length} file(s) read; branch ${gitOut.branch}`,
    },
    decided_by: ctx.actor_id,
    decided_at: new Date().toISOString(),
  })

  // Step 4: optionally attempt an action that should be denied, to
  // demonstrate the policy gate.
  if (SIMULATE_DENIED) {
    try {
      await ctx.callTool(
        "fs.read",
        { path: "README.md" },
        {
          intent: "attempt L4 read above auto-approve ceiling",
          contract: { required_level: 4 },
        },
      )
    } catch (err) {
      await ctx.emit("agent.note", {
        kind: "denied-as-expected",
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    branch: gitOut.branch,
    read_files: readFiles,
    decision_id,
    summary:
      `Greenfield agent inspected the repo on branch ` +
      `'${gitOut.branch}' and read ${readFiles.length} file(s). ` +
      `No side-effectful action was taken.`,
  }
}

const run = wrap(agentLoop)

const LOG_ROOT = defaultLogRoot()

const { result, session_id } = await run({
  project_id: PROJECT_ID,
  actor_id: ACTOR_ID,
  log_root: LOG_ROOT,
  default_scope: { level: "project", identifier: PROJECT_ID },
  default_sensitivity: "internal",
  policy_gate: autoApprovePolicy({
    auto_approve_up_to: 2,
    approver_id: "greenfield-policy",
  }),
  precondition_checker: alwaysHoldsChecker,
})

// Print a short status line then the trust report rendered from the log.
process.stdout.write(`\n[greenfield] session ${session_id}\n`)
process.stdout.write(`[greenfield] ${result.summary}\n\n`)

const { events } = await loadSessionEvents({
  logRoot: LOG_ROOT,
  session_id,
  project_id: PROJECT_ID,
})
const projection = projectChain(events, { session_id, project_id: PROJECT_ID })
process.stdout.write(
  `${renderReport(projection, { title: "Trust report — greenfield agent" })}\n`,
)

process.stdout.write(
  `\n[greenfield] event log: ${resolve(LOG_ROOT, PROJECT_ID)}\n` +
    `[greenfield] re-render later with: orrery report ${session_id}\n`,
)
