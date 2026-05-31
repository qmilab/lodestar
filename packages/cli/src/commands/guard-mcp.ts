import { resolve } from "node:path"
import { MCPProxy, type MCPProxyOverrides, loadProxyConfig } from "@qmilab/lodestar-guard-mcp"

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
 * Persistence: when the config sets `persistence.backend: "postgres"`,
 * this command resolves the connection string from the named environment
 * variable, opens the Postgres-backed firewall stores, ensures their
 * schema, and injects them into the proxy. The proxy never opens a
 * database connection itself — the CLI owns the connection's lifecycle
 * and closes it after the session ends (on clean exit, error, or signal).
 *
 * Exit codes:
 *   0  — session ended cleanly
 *   1  — runtime error (downstream startup failed, config invalid,
 *         postgres env var unset, store init failed)
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
  let config: Awaited<ReturnType<typeof loadProxyConfig>>
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

  // Resolve the persistence backend into injected stores. The proxy
  // itself never opens a database connection (that keeps `bun:sql` out of
  // its import graph); the CLI owns the connection and closes it when the
  // session ends. `closeStores` is a no-op for the in-memory default.
  let storeOverride: MCPProxyOverrides["stores"] | undefined
  let closeStores: (() => Promise<void>) | undefined
  if (config.persistence?.backend === "postgres") {
    const envName = config.persistence.connection_string_env
    const connectionString = process.env[envName]
    if (connectionString === undefined || connectionString === "") {
      process.stderr.write(
        `[mcp-proxy] persistence.backend is 'postgres' but the connection-string env var '${envName}' is not set\n`,
      )
      return 1
    }
    try {
      // Dynamic import so the in-memory default never pulls `bun:sql`
      // (and so npm consumers of the CLI who never select postgres don't
      // transitively load it). Subpath export, per the memory-firewall
      // package's deliberate split.
      const { createPostgresStores } = await import("@qmilab/lodestar-memory-firewall/postgres")
      const pg = createPostgresStores(connectionString)
      // Register the close BEFORE ensureSchema: the connection is open
      // now, so if ensureSchema() throws the catch below must still tear
      // it down. (A dynamic-import failure leaves `closeStores` unset, so
      // the catch correctly skips closing a connection that never opened.)
      closeStores = () => pg.close()
      await pg.ensureSchema()
      storeOverride = { claims: pg.claims, beliefs: pg.beliefs, evidence: pg.evidence }
      process.stderr.write(`[mcp-proxy] persistence postgres (connection from $${envName})\n`)
    } catch (err) {
      // Close anything ensureSchema() opened before it failed, so an init
      // error can't leak the connection.
      if (closeStores) {
        await closeStores()
        closeStores = undefined
      }
      const raw = err instanceof Error ? err.message : String(err)
      // Redact the DSN (which usually carries a password) before it
      // reaches stderr / CI logs — driver errors routinely echo it back.
      process.stderr.write(
        `[mcp-proxy] failed to initialise postgres persistence: ${redactDsn(raw, connectionString)}\n`,
      )
      return 1
    }
  }

  const proxy = new MCPProxy(config, storeOverride ? { stores: storeOverride } : undefined)
  process.stderr.write(`[mcp-proxy] session ${proxy.session_id}\n`)
  process.stderr.write(`[mcp-proxy] log root ${proxy.log_root}\n`)
  // Always include `--project` and `--log-root` in the hint so the
  // command works regardless of whether the config uses defaults.
  // Pre-fix, a config that pointed `log_root` anywhere outside the
  // cwd's default produced a hint that couldn't find the session.
  process.stderr.write(
    `[mcp-proxy] render with: lodestar report ${proxy.session_id} ` +
      `--project ${config.project_id} --log-root ${proxy.log_root}\n`,
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
    await closeStores?.()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  try {
    await proxy.start()
    // `proxy.start()` returns as soon as the stdio listeners are
    // wired; the process must stay alive until the wrapped agent
    // closes its end of stdin/stdout (or SIGINT/SIGTERM fires).
    // The CLI dispatcher calls `process.exit(code)` as soon as this
    // function returns, so without the wait below the process would
    // exit before the wrapped agent could so much as list a tool.
    await proxy.waitUntilClosed()
    await proxy.stop()
    await closeStores?.()
    return 0
  } catch (err) {
    process.stderr.write(
      `[mcp-proxy] session failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    await proxy.stop()
    await closeStores?.()
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

/**
 * Strip a Postgres connection string out of a free-text error message so
 * the credentials it usually carries (`postgres://user:password@host/db`)
 * don't land in stderr / CI logs. Redacts the exact DSN we hold, then any
 * `scheme://userinfo@` shape the driver may have reconstructed.
 */
function redactDsn(message: string, dsn: string): string {
  const withoutExact = dsn.length > 0 ? message.split(dsn).join("[redacted-dsn]") : message
  return withoutExact.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
}
