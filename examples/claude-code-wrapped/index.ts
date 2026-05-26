/**
 * Example: claude-code-wrapped
 *
 * End-to-end demonstration of the Batch 3 MCP proxy. A stand-in
 * MCP-speaking agent drives a small "coding task" against a sandboxed
 * filesystem MCP server, with Lodestar's proxy in the middle. Every
 * tool call passes through the Action Kernel; every result through
 * the Cognitive Core. The resulting event log is rendered into a
 * trust report at the end.
 *
 * The "stand-in agent" is this script itself: rather than spawning a
 * real Claude Code subprocess, the demo drives the proxy in-process
 * via `proxy.handleCallTool(...)`. That makes the demo deterministic
 * for CI and reproducible for screenshots without losing the
 * important architectural test — the proxy still owns a real
 * subprocess MCP server downstream
 * (`@modelcontextprotocol/server-filesystem`).
 *
 * In production, a real agent (Claude Code, Cursor, Aider) replaces
 * the in-process driver: configure the agent's MCP server list to
 * spawn `lodestar guard mcp-proxy --config <path>`, and the same
 * pipeline runs without code changes here.
 *
 *   bun run examples/claude-code-wrapped/index.ts
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import {
  MCPProxy,
  UpstreamServer,
  type ProxyConfig,
} from "@qmilab/lodestar-guard-mcp"
import {
  loadSessionEvents,
  projectChain,
  renderReport,
} from "@qmilab/lodestar-trace"

const PROJECT_ROOT = resolve(import.meta.dirname ?? ".", "..", "..")
const EXAMPLE_DIR = resolve(import.meta.dirname ?? ".")
const WORKSPACE_DIR = resolve(EXAMPLE_DIR, "workspace")
const LOG_ROOT = resolve(EXAMPLE_DIR, ".lodestar", "events")

const PROJECT_ID = "claude-code-wrapped"
const ACTOR_ID = "agent:standin-claude-code"
const SESSION_ID = `session-${randomUUID()}`

/**
 * No-op upstream server. In production the proxy speaks stdio to the
 * wrapped MCP agent here; in the demo the agent is in-process, so we
 * stub the start/stop. The proxy's `handleCallTool` stays public for
 * exactly this kind of in-process driver.
 */
class InProcessAgentUpstream extends UpstreamServer {
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
}

async function main(): Promise<void> {
  process.stderr.write(`[example] project root: ${PROJECT_ROOT}\n`)
  process.stderr.write(`[example] workspace:    ${WORKSPACE_DIR}\n`)
  process.stderr.write(`[example] event log:    ${LOG_ROOT}\n`)
  process.stderr.write(`[example] session_id:   ${SESSION_ID}\n`)

  const config: ProxyConfig = {
    project_id: PROJECT_ID,
    actor_id: ACTOR_ID,
    session_id: SESSION_ID,
    log_root: LOG_ROOT,
    default_scope: { level: "project", identifier: PROJECT_ID },
    default_sensitivity: "internal",
    auto_approve_ceiling: 2,
    downstream_servers: [
      {
        name: "fs",
        // Local-install path: the package is in this workspace as a
        // dev dep; `bunx` resolves the bin from the workspace's
        // node_modules without needing the network.
        command: "bunx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", WORKSPACE_DIR],
      },
    ],
    tool_defaults: {
      "mcp.fs.read_file": {
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
      "mcp.fs.list_directory": {
        reversibility: "reversible",
        permissions: ["fs.read"],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
      "mcp.fs.list_allowed_directories": {
        reversibility: "reversible",
        permissions: ["fs.read"],
        sandbox: "read",
        required_trust_level: 0,
        blast_radius: "self",
      },
    },
  }

  const proxy = new MCPProxy(config, {
    upstreamFactory: (tools, handler) =>
      new InProcessAgentUpstream(tools, handler, {
        name: "in-process-agent",
        version: "0.1.5",
      }),
  })

  process.stderr.write("[example] starting proxy + downstream filesystem MCP server\n")
  await proxy.start()
  process.stderr.write(`[example] proxy ready; session = ${proxy.session_id}\n`)

  try {
    // Stand-in agent's "small coding task": list the workspace,
    // then read both files. The notes.md file contains a planted
    // prompt-injection payload — the injection-defense probe asserts
    // the firewall holds; here we let it land in the event log so
    // the trust report shows exactly what arrived.
    process.stderr.write("[agent] step 1: list_directory\n")
    await proxy.handleCallTool({
      name: "mcp.fs.list_directory",
      arguments: { path: WORKSPACE_DIR },
    })

    process.stderr.write("[agent] step 2: read README.md\n")
    await proxy.handleCallTool({
      name: "mcp.fs.read_text_file",
      arguments: { path: `${WORKSPACE_DIR}/README.md` },
    })

    process.stderr.write("[agent] step 3: read notes.md (planted-injection file)\n")
    await proxy.handleCallTool({
      name: "mcp.fs.read_text_file",
      arguments: { path: `${WORKSPACE_DIR}/notes.md` },
    })
  } finally {
    process.stderr.write("[example] stopping proxy\n")
    await proxy.stop()
  }

  // Render the trust report inline. In a real session the operator
  // would run `lodestar report <session-id>`; the trace library
  // exposes the same pipeline so we can render here without shelling
  // out.
  process.stderr.write("[example] rendering trust report\n")
  const loaded = await loadSessionEvents({
    project_id: PROJECT_ID,
    session_id: proxy.session_id,
    logRoot: LOG_ROOT,
  })
  const chain = projectChain(loaded.events, {
    session_id: proxy.session_id,
    project_id: PROJECT_ID,
  })
  const report = renderReport(chain, {
    title: `Lodestar trust report — ${PROJECT_ID}/${proxy.session_id}`,
  })

  process.stdout.write(report)
  process.stdout.write("\n")
  process.stderr.write(
    `[example] done. Render again any time with:\n` +
      `  bun run --filter @qmilab/lodestar-cli lodestar -- report ${proxy.session_id} ` +
      `--project ${PROJECT_ID} --log-root ${LOG_ROOT}\n`,
  )
}

await main()
