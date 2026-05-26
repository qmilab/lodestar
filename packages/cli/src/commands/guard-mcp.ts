import { resolve } from "node:path"
import { loadProxyConfig, MCPProxy } from "@qmilab/lodestar-guard-mcp"

/**
 * `lodestar guard mcp-proxy --config <path>`
 *
 * Start an MCP proxy session. The wrapped agent (Claude Code,
 * Cursor, Aider, anything that speaks MCP over stdio) is the parent
 * process: it spawns `lodestar guard mcp-proxy` and talks to it over
 * stdin/stdout. The proxy forwards every tool call through Lodestar's
 * Action Kernel and routes every result through the Cognitive Core,
 * then forwards to the appropriate downstream MCP server declared in
 * the config file.
 *
 * The session_id used for the run is printed to stderr at startup so
 * the operator can render `lodestar report <session-id>` once the
 * session ends. stdout is reserved for MCP traffic — never write
 * anything else there.
 *
 * Exit codes:
 *   0  — session ended cleanly
 *   1  — runtime error (downstream startup failed, config invalid)
 *   2  — usage error (missing --config or unknown flag)
 *   3  — config file not found
 */
export async function guardMCPProxyCommand(argv: string[]): Promise<number> {
  let configPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--config" || arg === "-c") {
      configPath = argv[++i]
    } else if (arg === "--help" || arg === "-h") {
      writeUsage(process.stdout)
      return 0
    } else {
      process.stderr.write(`unknown flag: ${arg}\n`)
      writeUsage(process.stderr)
      return 2
    }
  }

  if (configPath === undefined) {
    writeUsage(process.stderr)
    return 2
  }

  const resolved = resolve(process.cwd(), configPath)
  let config
  try {
    config = await loadProxyConfig(resolved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("ENOENT")) {
      process.stderr.write(`[mcp-proxy] config file not found: ${resolved}\n`)
      return 3
    }
    process.stderr.write(`[mcp-proxy] config invalid: ${message}\n`)
    return 1
  }

  const proxy = new MCPProxy(config)
  process.stderr.write(`[mcp-proxy] session ${proxy.session_id}\n`)
  process.stderr.write(`[mcp-proxy] log root ${proxy.log_root}\n`)
  process.stderr.write(
    `[mcp-proxy] render with: lodestar report ${proxy.session_id}\n`,
  )

  // SIGINT and SIGTERM hand control to a graceful shutdown so the
  // event log gets a `guard.session.ended` record instead of a torn
  // tail.
  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[mcp-proxy] received ${signal}, stopping\n`)
    await proxy.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  try {
    await proxy.start()
    return 0
  } catch (err) {
    process.stderr.write(
      `[mcp-proxy] session failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    await proxy.stop()
    return 1
  }
}

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    "usage: lodestar guard mcp-proxy --config <path>\n" +
      "       The wrapped agent spawns this process; configure your agent's MCP\n" +
      "       server list to point at `lodestar guard mcp-proxy --config <path>`.\n",
  )
}
