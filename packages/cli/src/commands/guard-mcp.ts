import { dirname, resolve } from "node:path"
import type { CompiledPolicy, SentinelArbiter } from "@qmilab/lodestar-guard"
import {
  MCPProxy,
  type MCPProxyOverrides,
  compileProxyPolicy,
  compileProxyPolicyWithSentinels,
  loadProxyConfig,
} from "@qmilab/lodestar-guard-mcp"
import { FIRST_PARTY_SENTINELS } from "@qmilab/lodestar-harness"

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
 * Policy: when the config sets `policy`, this command loads + `compile()`s the
 * referenced (signed) `Policy` document and injects the resulting gate into the
 * proxy — the same host-owns-the-I/O separation as persistence, and the path to
 * richer holds (a `require_approval` rule whose `required_authority` an approver
 * must clear). Done before any DB connection opens so a bad policy fails fast.
 * Without `policy`, the gate is the `auto_approve_ceiling` preset.
 *
 * Exit codes:
 *   0  — session ended cleanly
 *   1  — runtime error (downstream startup failed, config invalid,
 *         policy invalid — unsigned/tampered/missing,
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

  // Compile a declarative policy document, if one is configured, into the gate
  // the proxy uses. Done before opening any database connection so a bad policy
  // fails fast without leaking a store. The proxy never reads the file itself —
  // the CLI owns the I/O and signature check (same separation as persistence)
  // and injects the resulting CompiledPolicy via the policyGate seam. The
  // `file` path resolves against the config file's own directory.
  // Declared sentinels (ADR-0003) arm the gate's arbitrate hook. They require a
  // declarative `policy` to compile *with* arbitration (the `ProxyConfigSchema`
  // already rejects a `sentinels`-without-`policy` config at load). Resolve the
  // ids against the first-party registry here — the CLI owns the registry, so the
  // proxy package stays free of a harness runtime dependency.
  const declaredSentinelIds = config.sentinels ?? []
  let policyOverride: CompiledPolicy | undefined
  let arbiterOverride: SentinelArbiter | undefined
  if (config.policy !== undefined) {
    try {
      if (declaredSentinelIds.length > 0) {
        const sentinels = declaredSentinelIds.map((id) => {
          const factory = FIRST_PARTY_SENTINELS[id]
          if (factory === undefined) {
            throw new Error(
              `unknown sentinel id '${id}' — known: ${Object.keys(FIRST_PARTY_SENTINELS).join(", ")}`,
            )
          }
          return factory()
        })
        const compiled = await compileProxyPolicyWithSentinels(
          config.policy,
          dirname(resolved),
          sentinels,
        )
        policyOverride = compiled.gate
        arbiterOverride = compiled.arbiter
        process.stderr.write(
          `[mcp-proxy] policy gate compiled from ${config.policy.file} with ${sentinels.length} sentinel(s): ${declaredSentinelIds.join(", ")}\n`,
        )
      } else {
        policyOverride = await compileProxyPolicy(config.policy, dirname(resolved))
        process.stderr.write(`[mcp-proxy] policy gate compiled from ${config.policy.file}\n`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[mcp-proxy] policy invalid: ${message}\n`)
      return 1
    }
  }

  // Resolve the HTTP approval channel's bearer token from its named env var
  // (ADR-0015). Secrets stay in the environment, never in the config file — the
  // same discipline as `persistence.connection_string_env`. The proxy never reads
  // `process.env` itself; the CLI (the process owner) injects a resolver. Validate
  // here — alongside the policy compile, BEFORE opening any database connection —
  // so a `token_env` naming an unset var fails fast with a clear message and never
  // leaks a Postgres store the persistence block below would otherwise have opened.
  // (The schema accepts the config; only the runtime can know the env var.)
  let resolveApprovalToken: MCPProxyOverrides["resolveApprovalToken"] | undefined
  const approvalChannel = config.approvals?.channel
  if (approvalChannel?.kind === "http" && approvalChannel.token_env !== undefined) {
    const envName = approvalChannel.token_env
    const token = process.env[envName]
    if (token === undefined || token === "") {
      process.stderr.write(
        `[mcp-proxy] approvals.channel.token_env is '${envName}' but that env var is not set\n`,
      )
      return 1
    }
    resolveApprovalToken = () => token
    process.stderr.write(`[mcp-proxy] approval channel http (bearer from $${envName})\n`)
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
      // Best-effort close of anything ensureSchema() opened before it
      // failed, so an init error can't leak the connection. Guard the
      // close itself: a rejecting pg.close() must not mask the original
      // init error (the useful one) or skip the redacted report below.
      if (closeStores) {
        try {
          await closeStores()
        } catch {
          // ignore — the init error we're about to report is what matters
        }
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

  const overrides: MCPProxyOverrides = {}
  if (storeOverride !== undefined) overrides.stores = storeOverride
  if (policyOverride !== undefined) overrides.policyGate = policyOverride
  if (arbiterOverride !== undefined) overrides.arbiter = arbiterOverride
  if (resolveApprovalToken !== undefined) overrides.resolveApprovalToken = resolveApprovalToken
  const proxy = new MCPProxy(config, overrides)
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
 * don't land in stderr / CI logs. Three layers, because drivers echo the
 * DSN back in more than one shape:
 *   1. the exact DSN literal we hold;
 *   2. any `scheme://userinfo@` URL form (the DSN reconstructed/reordered);
 *   3. libpq key/value form — `password=secret`, `pass='se cret'` — which a
 *      driver may emit even when the operator passed a URL DSN.
 * Only the password is scrubbed in (3); the host/user/db stay for debugging.
 */
function redactDsn(message: string, dsn: string): string {
  let out = dsn.length > 0 ? message.split(dsn).join("[redacted-dsn]") : message
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
  out = out.replace(/(\bpass(?:word)?\s*=\s*)('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]")
  return out
}
