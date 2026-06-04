/**
 * Shared driver for the Telenotes governed-dev demos.
 *
 * Both the clean scripted run and the poisoned-file run drive the same
 * sequence through the MCP proxy — observe → decide → edit → test → commit →
 * blocked push → revise. The only difference is whether a poisoned file is
 * planted in the workspace and read during observation, so the flow lives here
 * once and each entry point parameterises it.
 *
 * The "agent" is the driver: it calls `proxy.handleCallTool(...)` in-process so
 * the run is deterministic. The architecture under test is real — the proxy
 * owns two live downstream MCP servers (the official filesystem server for
 * reads/writes; the first-party dev-tools server for test/commit/push).
 */

import { randomUUID } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Belief, Claim, EventEnvelope } from "@qmilab/lodestar-core"
import { EventLogWriter, canonicalHash } from "@qmilab/lodestar-event-log"
import {
  MCPProxy,
  type ProxyConfig,
  UpstreamServer,
  isPolicyDeniedResult,
} from "@qmilab/lodestar-guard-mcp"
import { loadSessionEvents, projectChain, renderReport } from "@qmilab/lodestar-trace"

export interface GovernedDevDemoOptions {
  /** Absolute path to the example directory (the parent of fixture/, dev-tools-mcp/, …). */
  exampleDir: string
  /** Project id for this run; scopes its own event-log partition. */
  projectId: string
  /** Actor id recorded on every event. */
  actorId: string
  /**
   * When set, the named file is planted in the workspace with these contents
   * and read during the observation phase — the poisoned-file scenario.
   */
  poisonFile?: { name: string; contents: string }
}

export interface GovernedDevDemoResult {
  sessionId: string
  logRoot: string
  /** Every event in the session, in log order. */
  events: EventEnvelope[]
  /** The rendered markdown trust report. */
  report: string
  /** The belief id the feature decision cited (the note.ts architecture belief), if found. */
  citedBeliefId?: string
}

/** The fixture source file the feature decision rests on. */
export const ARCH_SOURCE_FILE = "note.ts"

interface ObservationLike {
  id?: string
  payload?: { args?: { path?: unknown } }
}
interface ContentClaimLike {
  id: string
  source_observation_ids?: string[]
  structured_predicate?: { relation?: string }
}
interface ActionLike {
  id: string
  tool: string
}

/** Verbatim content text from a content claim's structured predicate. */
export function contentClaimText(claim: Claim): string {
  const obj = claim.structured_predicate?.object
  if (obj && typeof obj === "object" && "text" in obj && typeof obj.text === "string") {
    return obj.text
  }
  return claim.statement
}

/**
 * The belief id backing the external-document content claim that came from
 * reading the file whose path ends with `pathSuffix`. Resolved by observation
 * provenance (the read's tool-call `path` argument), not by marker substring,
 * so it always cites the belief from the intended file even if another file's
 * contents happen to share text.
 */
export function findContentBeliefIdByPath(
  events: EventEnvelope[],
  pathSuffix: string,
): string | undefined {
  // Observation ids whose tool call read a path ending in `pathSuffix`.
  const obsIds = new Set<string>()
  for (const e of events) {
    if (e.type !== "observation.recorded") continue
    const obs = e.payload as ObservationLike
    const path = obs.payload?.args?.path
    if (typeof path === "string" && path.endsWith(pathSuffix) && typeof obs.id === "string") {
      obsIds.add(obs.id)
    }
  }
  if (obsIds.size === 0) return undefined
  const claimsById = new Map<string, ContentClaimLike>()
  for (const e of events) {
    if (e.type === "claim.extracted") {
      const claim = e.payload as ContentClaimLike
      claimsById.set(claim.id, claim)
    }
  }
  for (const e of events) {
    if (e.type !== "belief.adopted") continue
    const belief = e.payload as Belief
    const claim = claimsById.get(belief.claim_id)
    if (claim?.structured_predicate?.relation !== "mcp.external_document_content") continue
    if ((claim.source_observation_ids ?? []).some((id) => obsIds.has(id))) {
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

async function spawnQuiet(cmd: string[], cwd: string): Promise<number> {
  return Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" }).exited
}

/** Initialise a throwaway git repo so `git_commit` has somewhere to commit. */
async function gitInit(cwd: string): Promise<void> {
  const steps: string[][] = [
    ["git", "init", "-q"],
    ["git", "add", "-A"],
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
  ]
  for (const step of steps) {
    const code = await spawnQuiet(step, cwd)
    if (code !== 0) {
      throw new Error(`workspace git init failed (exit ${code}): ${step.join(" ")}`)
    }
  }
}

class InProcessAgentUpstream extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

export async function runGovernedDevDemo(
  opts: GovernedDevDemoOptions,
): Promise<GovernedDevDemoResult> {
  const { exampleDir, projectId, actorId } = opts
  const fixtureSrc = resolve(exampleDir, "fixture", "telenotes")
  const featureDir = resolve(exampleDir, "scripted-run", "feature")
  const devtoolsBin = resolve(exampleDir, "dev-tools-mcp", "bin.ts")
  const logRoot = resolve(exampleDir, ".lodestar", "events")
  const sessionId = `session-${randomUUID()}`

  // Fresh partition for this project + a throwaway working tree. realpath the
  // temp dir: on macOS /tmp is a symlink to /private/tmp, and the filesystem
  // MCP server canonicalises its allowed root — so the agent's paths must be
  // canonical too or every op is denied as "outside allowed dir".
  rmSync(resolve(logRoot, projectId), { recursive: true, force: true })
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "telenotes-")))
  cpSync(fixtureSrc, workspace, { recursive: true })
  if (opts.poisonFile) {
    writeFileSync(join(workspace, opts.poisonFile.name), opts.poisonFile.contents, "utf8")
  }
  await gitInit(workspace)

  process.stderr.write(`[telenotes] project   ${projectId}\n`)
  process.stderr.write(`[telenotes] session   ${sessionId}\n`)
  process.stderr.write(`[telenotes] workspace ${workspace}\n`)

  const config: ProxyConfig = {
    project_id: projectId,
    actor_id: actorId,
    session_id: sessionId,
    log_root: logRoot,
    default_scope: { level: "project", identifier: projectId },
    default_sensitivity: "internal",
    auto_approve_ceiling: 3,
    // No out-of-band resolver in this demo: a held L4 action (the push) is
    // surfaced immediately as `approval_required` rather than waited on.
    approval_timeout_ms: 0,
    downstream_servers: [
      {
        name: "fs",
        // Local-install path: `bunx` resolves the bin from node_modules without
        // the network. Do NOT pass `-y` (an npx-ism bunx reads as a package).
        command: "bunx",
        args: ["@modelcontextprotocol/server-filesystem", workspace],
      },
      { name: "devtools", command: "bun", args: ["run", devtoolsBin, workspace] },
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
      project_id: projectId,
      session_id: proxy.session_id,
      actor_id: actorId,
      timestamp: new Date().toISOString(),
      causal_parent_ids: [],
      payload,
      payload_hash: canonicalHash(payload),
      versions: { schema_registry_version: "0.1.0" },
    })
  }

  async function loadEvents(): Promise<EventEnvelope[]> {
    const { events } = await loadSessionEvents({
      project_id: projectId,
      session_id: proxy.session_id,
      logRoot: proxy.log_root,
    })
    return events
  }

  async function call(name: string, args: Record<string, unknown>, label: string) {
    process.stderr.write(`[agent] ${label}\n`)
    return proxy.handleCallTool({ name, arguments: args })
  }

  let citedBeliefId: string | undefined
  try {
    // 1. Observe the codebase.
    await call("mcp.fs.list_directory", { path: workspace }, "list workspace")
    await call("mcp.fs.read_text_file", { path: join(workspace, "README.md") }, "read README.md")
    if (opts.poisonFile) {
      await call(
        "mcp.fs.read_text_file",
        { path: join(workspace, opts.poisonFile.name) },
        `read ${opts.poisonFile.name} (planted poison)`,
      )
    }
    await call("mcp.fs.read_text_file", { path: join(workspace, "note.ts") }, "read note.ts")
    await call("mcp.fs.read_text_file", { path: join(workspace, "publish.ts") }, "read publish.ts")

    // 2. Decide on a plan, citing the (read-not-verified) belief about Note's
    //    shape that reading note.ts produced.
    citedBeliefId = findContentBeliefIdByPath(await loadEvents(), ARCH_SOURCE_FILE)
    if (citedBeliefId === undefined) {
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
      belief_dependencies: citedBeliefId ? [citedBeliefId] : [],
      decided_by: actorId,
      decided_at: new Date().toISOString(),
    })

    // 3. Edit the files (governed L3 writes through the filesystem server).
    const noteAfter = readFileSync(join(featureDir, "note.ts"), "utf8")
    const publishAfter = readFileSync(join(featureDir, "publish.ts"), "utf8")
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
        decided_by: actorId,
        decided_at: new Date().toISOString(),
      })
    } else {
      process.stderr.write("[telenotes] WARN: push was NOT blocked — policy gate misconfigured\n")
    }
  } finally {
    await proxy.stop()
  }

  const events = await loadEvents()
  const chain = projectChain(events, { session_id: proxy.session_id, project_id: projectId })
  const report = renderReport(chain, {
    title: `Lodestar trust report — ${projectId} (${proxy.session_id})`,
  })

  const result: GovernedDevDemoResult = {
    sessionId: proxy.session_id,
    logRoot: proxy.log_root,
    events,
    report,
  }
  if (citedBeliefId !== undefined) result.citedBeliefId = citedBeliefId
  return result
}
