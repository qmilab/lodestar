#!/usr/bin/env bun
/**
 * Telenotes governed development — deterministic scripted run.
 *
 * The Batch 5 primary proving ground. A coding agent, wrapped via the MCP
 * proxy, is asked to add a `clientTag` feature to the Telenotes fixture. It
 * observes the codebase, decides on a plan, edits files, runs tests, commits,
 * and attempts to push — every tool call governed by the Action Kernel and
 * recorded in the epistemic chain.
 *
 * The "agent" here is this script: rather than spawning a real Claude Code
 * subprocess, it drives the proxy in-process via `proxy.handleCallTool(...)`,
 * so the run is deterministic and reproducible. The architecture under test is
 * real — the proxy owns two live downstream MCP servers (the official
 * filesystem server for reads/writes, and the first-party dev-tools server for
 * test/commit/push). See `real-claude-code/RECIPE.md` (a later PR) for driving
 * the same pipeline with a real agent.
 *
 *   bun run examples/telenotes-governed-dev/scripted-run/index.ts
 *
 * The trust report is written to stdout; progress goes to stderr. Capture the
 * committed report with:
 *
 *   bun run examples/telenotes-governed-dev/scripted-run/index.ts \
 *     > examples/telenotes-governed-dev/reports/scripted-run.report.md
 */

import { randomUUID } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { EventEnvelope } from "@qmilab/lodestar-core"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
  isPolicyDeniedResult,
} from "@qmilab/lodestar-guard-mcp"
import { loadSessionEvents, projectChain, renderReport } from "@qmilab/lodestar-trace"

const EXAMPLE_DIR = resolve(import.meta.dirname, "..")
const FIXTURE_SRC = resolve(EXAMPLE_DIR, "fixture", "telenotes")
const FEATURE_DIR = resolve(import.meta.dirname, "feature")
const DEVTOOLS_BIN = resolve(EXAMPLE_DIR, "dev-tools-mcp", "bin.ts")
const LOG_ROOT = resolve(EXAMPLE_DIR, ".lodestar", "events")

const PROJECT_ID = "telenotes-governed-dev"
const ACTOR_ID = "agent:claude-code"
const SESSION_ID = `session-${randomUUID()}`

/** No-op upstream: the agent is in-process, so there is no stdio peer. */
class InProcessAgentUpstream extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

// ── Event-log correlation helpers ──────────────────────────────────────────
// The proxy emits the full Claim/Belief/Action records; the driver reads them
// back to cite real ids in the decision/outcome events it emits.

interface ClaimLike {
  id: string
  structured_predicate?: { relation?: string; object?: { text?: unknown } }
}
interface BeliefLike {
  id: string
  claim_id: string
}
interface ActionLike {
  id: string
  tool: string
}

/** The belief id backing an external-document content claim whose text contains `marker`. */
function findContentBeliefId(events: EventEnvelope[], marker: string): string | undefined {
  const claimsById = new Map<string, ClaimLike>()
  for (const e of events) {
    if (e.type === "claim.extracted") {
      const claim = e.payload as ClaimLike
      claimsById.set(claim.id, claim)
    }
  }
  for (const e of events) {
    if (e.type !== "belief.adopted") continue
    const belief = e.payload as BeliefLike
    const claim = claimsById.get(belief.claim_id)
    const relation = claim?.structured_predicate?.relation
    const text = claim?.structured_predicate?.object?.text
    if (
      relation === "mcp.external_document_content" &&
      typeof text === "string" &&
      text.includes(marker)
    ) {
      return belief.id
    }
  }
  return undefined
}

/** The id of the most recent action for a given namespaced tool. */
function latestActionIdByTool(events: EventEnvelope[], tool: string): string | undefined {
  let id: string | undefined
  for (const e of events) {
    if (!e.type.startsWith("action.")) continue
    const action = e.payload as ActionLike
    if (action?.tool === tool) id = action.id
  }
  return id
}

function outcomeFor(actionId: string, result: "success" | "failure"): Record<string, unknown> {
  return {
    id: randomUUID(),
    action_id: actionId,
    result,
    effect_observation_ids: [],
    side_effects_observed: [],
    duration_ms: 0,
    observed_at: new Date().toISOString(),
  }
}

async function spawnQuiet(cmd: string[], cwd: string): Promise<void> {
  await Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" }).exited
}

/** Initialise a throwaway git repo so `git_commit` has somewhere to commit. */
async function gitInit(cwd: string): Promise<void> {
  await spawnQuiet(["git", "init", "-q"], cwd)
  await spawnQuiet(["git", "add", "-A"], cwd)
  await spawnQuiet(
    [
      "git",
      "-c",
      "user.email=lodestar-demo@example.invalid",
      "-c",
      "user.name=Lodestar Demo",
      "commit",
      "-q",
      "-m",
      "chore: import Telenotes fixture",
    ],
    cwd,
  )
}

async function main(): Promise<void> {
  // Fresh log + a throwaway working tree, so each run is hermetic and the
  // committed copy of the fixture is never touched.
  rmSync(LOG_ROOT, { recursive: true, force: true })
  // realpath the temp dir: on macOS /tmp is a symlink to /private/tmp, and the
  // filesystem MCP server canonicalises its allowed root — so the agent's file
  // paths must be canonical too or every op is denied as "outside allowed dir".
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "telenotes-scripted-")))
  cpSync(FIXTURE_SRC, workspace, { recursive: true })
  await gitInit(workspace)

  process.stderr.write(`[telenotes] session   ${SESSION_ID}\n`)
  process.stderr.write(`[telenotes] workspace ${workspace}\n`)
  process.stderr.write(`[telenotes] log root  ${LOG_ROOT}\n`)

  const config: ProxyConfig = {
    project_id: PROJECT_ID,
    actor_id: ACTOR_ID,
    session_id: SESSION_ID,
    log_root: LOG_ROOT,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    downstream_servers: [
      {
        name: "fs",
        // Local-install path: `bunx` resolves the bin from node_modules
        // without the network. Do NOT pass `-y` (an npx-ism that bunx reads
        // as a package name).
        command: "bunx",
        args: ["@modelcontextprotocol/server-filesystem", workspace],
      },
      {
        name: "devtools",
        command: "bun",
        args: ["run", DEVTOOLS_BIN, workspace],
      },
    ],
    tool_defaults: {
      "mcp.fs.list_directory": {
        reversibility: "reversible",
        permissions: ["fs.read"],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
      "mcp.fs.read_text_file": {
        reversibility: "reversible",
        permissions: ["fs.read"],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
      "mcp.fs.write_file": {
        reversibility: "compensable",
        permissions: ["fs.write"],
        sandbox: "write-local",
        required_trust_level: 3,
        blast_radius: "project",
      },
      "mcp.devtools.shell_test": {
        reversibility: "reversible",
        permissions: ["shell.exec"],
        sandbox: "controlled-shell",
        required_trust_level: 3,
        blast_radius: "session",
      },
      "mcp.devtools.git_commit": {
        reversibility: "compensable",
        permissions: ["fs.write"],
        sandbox: "write-local",
        required_trust_level: 3,
        blast_radius: "project",
      },
      "mcp.devtools.git_push": {
        reversibility: "irreversible",
        permissions: ["network.egress"],
        sandbox: "controlled-shell",
        required_trust_level: 4,
        blast_radius: "external",
      },
    },
  }

  const proxy = new MCPProxy(config, {
    upstreamFactory: (tools, handler) =>
      new InProcessAgentUpstream(tools, handler, { name: "in-process-agent", version: "0.1.0" }),
  })
  await proxy.start()

  const driverWriter = new EventLogWriter(proxy.log_root)
  async function emit(type: string, payload: unknown): Promise<void> {
    await driverWriter.append({
      id: randomUUID(),
      type,
      schema_version: "0.1.0",
      project_id: PROJECT_ID,
      session_id: proxy.session_id,
      actor_id: ACTOR_ID,
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
  }

  async function loadEvents(): Promise<EventEnvelope[]> {
    const { events } = await loadSessionEvents({
      project_id: PROJECT_ID,
      session_id: proxy.session_id,
      logRoot: proxy.log_root,
    })
    return events
  }

  async function call(name: string, args: Record<string, unknown>, label: string) {
    process.stderr.write(`[agent] ${label}\n`)
    return proxy.handleCallTool({ name, arguments: args })
  }

  try {
    // 1. Observe the codebase.
    await call("mcp.fs.list_directory", { path: workspace }, "list workspace")
    await call("mcp.fs.read_text_file", { path: join(workspace, "README.md") }, "read README.md")
    await call("mcp.fs.read_text_file", { path: join(workspace, "note.ts") }, "read note.ts")
    await call("mcp.fs.read_text_file", { path: join(workspace, "publish.ts") }, "read publish.ts")

    // 2. Decide on a plan, citing the (read-not-verified) belief about Note's
    //    shape that reading note.ts produced.
    const archBeliefId = findContentBeliefId(await loadEvents(), "export function buildNote")
    if (archBeliefId === undefined) {
      process.stderr.write("[telenotes] WARN: could not locate the note.ts architecture belief\n")
    }
    await emit("decision.made", {
      id: randomUUID(),
      intent: "Add a clientTag field to Note and stamp it on publish",
      chosen_option: {
        id: "add-client-tag",
        label: "Add an optional clientTag to Note and PublishResult",
        rationale:
          "note.ts exposes content/createdAt/tags (observed by reading the file — external_document, " +
          "unverified). Adding an optional clientTag is additive and keeps the existing tests green.",
      },
      belief_dependencies: archBeliefId ? [archBeliefId] : [],
      decided_by: ACTOR_ID,
      decided_at: new Date().toISOString(),
    })

    // 3. Edit the files (governed L3 writes through the filesystem server).
    const noteAfter = readFileSync(join(FEATURE_DIR, "note.ts"), "utf8")
    const publishAfter = readFileSync(join(FEATURE_DIR, "publish.ts"), "utf8")
    await call(
      "mcp.fs.write_file",
      { path: join(workspace, "note.ts"), content: noteAfter },
      "edit note.ts",
    )
    await call(
      "mcp.fs.write_file",
      { path: join(workspace, "publish.ts"), content: publishAfter },
      "edit publish.ts",
    )

    // 4. Run the test suite (governed L3 shell action).
    const testResult = await call("mcp.devtools.shell_test", {}, "run tests")
    const testActionId = latestActionIdByTool(await loadEvents(), "mcp.devtools.shell_test")
    if (testActionId) {
      await emit(
        "outcome.observed",
        outcomeFor(testActionId, testResult.isError ? "failure" : "success"),
      )
    }

    // 5. Commit (governed L3 write action).
    await call(
      "mcp.devtools.git_commit",
      { message: "feat(note): add clientTag field" },
      "commit the change",
    )

    // 6. Attempt to push — L4, above the auto-approve ceiling. The policy gate
    //    denies it; the agent records the block and revises its plan.
    const pushResult = await call(
      "mcp.devtools.git_push",
      { branch: "feature/client-tag" },
      "attempt push (expect policy block)",
    )
    if (isPolicyDeniedResult(pushResult)) {
      process.stderr.write("[agent] push denied by policy — recording revision\n")
      const pushActionId = latestActionIdByTool(await loadEvents(), "mcp.devtools.git_push")
      if (pushActionId) await emit("outcome.observed", outcomeFor(pushActionId, "failure"))
      await emit("decision.made", {
        id: randomUUID(),
        intent: "Push blocked by policy; defer to human approval",
        chosen_option: {
          id: "request-approval",
          label: "Stop and request approval for the L4 push",
          rationale:
            "git_push is L4 (irreversible, external blast radius); the auto-approve ceiling is L3. " +
            "The change is committed locally and awaits human approval to push.",
        },
        belief_dependencies: [],
        decided_by: ACTOR_ID,
        decided_at: new Date().toISOString(),
      })
    } else {
      process.stderr.write("[telenotes] WARN: push was NOT blocked — policy gate misconfigured\n")
    }
  } finally {
    await proxy.stop()
  }

  // Render the trust report from the full event log (proxy + driver events).
  const { events } = await loadSessionEvents({
    project_id: PROJECT_ID,
    session_id: proxy.session_id,
    logRoot: proxy.log_root,
  })
  const chain = projectChain(events, { session_id: proxy.session_id, project_id: PROJECT_ID })
  const report = renderReport(chain, {
    title: `Lodestar trust report — Telenotes governed dev (${proxy.session_id})`,
  })
  process.stdout.write(`${report}\n`)
  process.stderr.write(
    `[telenotes] done. Re-render any time with:\n  bun run lodestar report ${proxy.session_id} --project ${PROJECT_ID} --log-root ${proxy.log_root}\n`,
  )
}

await main()
