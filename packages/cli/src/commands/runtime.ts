import { dirname, resolve } from "node:path"
import type { CompiledPolicy, SentinelArbiter } from "@qmilab/lodestar-guard"
import { FIRST_PARTY_SENTINELS } from "@qmilab/lodestar-harness"
import {
  RuntimeGate,
  type RuntimeGateOverrides,
  compileRuntimePolicy,
  compileRuntimePolicyWithSentinels,
  loadRuntimeGateConfig,
  stdioChannel,
} from "@qmilab/lodestar-runtime-core"

/**
 * `lodestar runtime gate --config <path>`
 *
 * Start a governance-gate sidecar for a non-MCP agent runtime (LangGraph,
 * CrewAI, AutoGen — ADR-0024). The native runtime hook (e.g. the Python
 * `lodestar-langgraph` package) is the parent process: it spawns
 * `lodestar runtime gate` and speaks newline-delimited JSON-RPC to it over
 * stdin/stdout. Every native tool call the agent makes is routed through the
 * Action Kernel; every result through the Cognitive Core; an L4 action holds for
 * a *signed* approval. stdout is reserved for protocol JSON — never write
 * anything else there; diagnostics go to stderr.
 *
 * This is the exact host-owns-the-I/O wiring of `lodestar guard mcp-proxy`: the
 * CLI loads + compiles the (signed) policy document, resolves declared sentinel
 * ids, opens the Postgres stores when configured, and injects them — the gate
 * itself never reads policy off disk or opens a database connection.
 *
 * Exit codes:
 *   0  — session ended cleanly (the hook disconnected)
 *   1  — runtime error (config/policy invalid, postgres env unset, store init)
 *   2  — usage error (missing --config or unknown flag)
 *   3  — config file not found
 */
export async function runtimeGateCommand(argv: string[]): Promise<number> {
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
  let config: Awaited<ReturnType<typeof loadRuntimeGateConfig>>
  try {
    config = await loadRuntimeGateConfig(resolved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("ENOENT")) {
      process.stderr.write(`[runtime-gate] config file not found: ${resolved}\n`)
      return 3
    }
    process.stderr.write(`[runtime-gate] config invalid: ${message}\n`)
    return 1
  }

  // Compile a declarative policy + resolve sentinels, exactly as guard mcp-proxy.
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
        const compiled = await compileRuntimePolicyWithSentinels(
          config.policy,
          dirname(resolved),
          sentinels,
        )
        policyOverride = compiled.gate
        arbiterOverride = compiled.arbiter
        process.stderr.write(
          `[runtime-gate] policy gate compiled from ${config.policy.file} with ${sentinels.length} sentinel(s): ${declaredSentinelIds.join(", ")}\n`,
        )
      } else {
        policyOverride = await compileRuntimePolicy(config.policy, dirname(resolved))
        process.stderr.write(`[runtime-gate] policy gate compiled from ${config.policy.file}\n`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[runtime-gate] policy invalid: ${message}\n`)
      return 1
    }
  }

  // Resolve persistence into injected stores; the CLI owns the connection.
  let storeOverride: RuntimeGateOverrides["stores"] | undefined
  let closeStores: (() => Promise<void>) | undefined
  if (config.persistence?.backend === "postgres") {
    const envName = config.persistence.connection_string_env
    const connectionString = process.env[envName]
    if (connectionString === undefined || connectionString === "") {
      process.stderr.write(
        `[runtime-gate] persistence.backend is 'postgres' but the connection-string env var '${envName}' is not set\n`,
      )
      return 1
    }
    try {
      const { createPostgresStores } = await import("@qmilab/lodestar-memory-firewall/postgres")
      const pg = createPostgresStores(connectionString)
      closeStores = () => pg.close()
      await pg.ensureSchema()
      storeOverride = { claims: pg.claims, beliefs: pg.beliefs, evidence: pg.evidence }
      process.stderr.write(`[runtime-gate] persistence postgres (connection from $${envName})\n`)
    } catch (err) {
      if (closeStores) {
        try {
          await closeStores()
        } catch {
          // ignore — the init error below is the useful one
        }
        closeStores = undefined
      }
      const raw = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `[runtime-gate] failed to initialise postgres persistence: ${redactDsn(raw, connectionString)}\n`,
      )
      return 1
    }
  }

  const overrides: RuntimeGateOverrides = {}
  if (storeOverride !== undefined) overrides.stores = storeOverride
  if (policyOverride !== undefined) overrides.policyGate = policyOverride
  if (arbiterOverride !== undefined) overrides.arbiter = arbiterOverride

  let gate: RuntimeGate
  try {
    gate = new RuntimeGate(config, overrides)
  } catch (err) {
    process.stderr.write(
      `[runtime-gate] could not start: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    await closeStores?.()
    return 1
  }
  process.stderr.write(`[runtime-gate] session ${gate.session_id}\n`)
  process.stderr.write(`[runtime-gate] log root ${gate.log_root}\n`)
  process.stderr.write(
    `[runtime-gate] render with: lodestar report ${gate.session_id} ` +
      `--project ${config.project_id} --log-root ${gate.log_root}\n`,
  )

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[runtime-gate] received ${signal}, stopping\n`)
    await gate.stop()
    await closeStores?.()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  try {
    await gate.init()
    // serve() resolves when the hook closes its end of the stdio channel.
    await gate.serve(stdioChannel(process.stdin, process.stdout))
    await gate.stop()
    await closeStores?.()
    return 0
  } catch (err) {
    process.stderr.write(
      `[runtime-gate] session failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    await gate.stop()
    await closeStores?.()
    return 1
  }
}

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    "usage: lodestar runtime gate --config <path>\n" +
      "       The native runtime hook (e.g. lodestar-langgraph) spawns this process\n" +
      "       and speaks newline-delimited JSON-RPC to it over stdin/stdout.\n",
  )
}

/** Strip a Postgres DSN out of an error message (same discipline as guard-mcp). */
function redactDsn(message: string, dsn: string): string {
  let out = dsn.length > 0 ? message.split(dsn).join("[redacted-dsn]") : message
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
  out = out.replace(/(\bpass(?:word)?\s*=\s*)('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]")
  return out
}
