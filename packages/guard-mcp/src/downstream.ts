import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type {
  CallToolResult,
  Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"
import type { DownstreamServerConfig } from "./config.js"

/**
 * One connection to a downstream MCP server. The proxy spawns the
 * downstream as a child process (stdio transport), runs the MCP
 * initialize handshake, and caches the tool catalog at startup.
 *
 * Lifetime is owned by `MCPProxy`. Callers do not construct
 * `DownstreamConnection` directly outside tests.
 */
export class DownstreamConnection {
  private client?: Client
  private transport?: StdioClientTransport
  private tools: MCPTool[] = []
  private started = false

  constructor(
    /** Operator-supplied config block from the proxy config file. */
    public readonly config: DownstreamServerConfig,
    /** Client identity reported in the MCP handshake. */
    private readonly clientInfo: { name: string; version: string },
  ) {}

  /**
   * Spawn the downstream MCP server, complete the MCP handshake, and
   * cache the tool catalog.
   *
   * Throws on transport failure, handshake mismatch, or downstream
   * server startup error. The proxy treats a failed downstream as
   * fatal: an MCP proxy with one missing server cannot honestly
   * advertise the tools the operator declared.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error(`DownstreamConnection '${this.config.name}': already started`)
    }
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
      ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
    })
    this.client = new Client(this.clientInfo)
    await this.client.connect(this.transport)
    // Drain ALL pages of tools/list. MCP servers can paginate their
    // tool catalog via `nextCursor`; capturing only the first page
    // would silently drop tools, which then get refused as
    // `tool_not_advertised` even though the downstream offers them.
    // v0 still does not subscribe to tools/list_changed
    // notifications; if a downstream's catalog changes after
    // startup, the proxy will not pick it up until restart.
    const client = this.client
    this.tools = await collectPaginatedTools(
      (params) => client.listTools(params),
      this.config.name,
    )
    this.started = true
  }

  /**
   * The MCP-tool catalog advertised by this downstream, frozen at
   * connection-start time.
   */
  getTools(): readonly MCPTool[] {
    return this.tools
  }

  /**
   * Forward a tool call to the downstream server and return its raw
   * CallToolResult unchanged. The proxy wraps the result into a
   * Lodestar observation; this method is the bare wire-level call.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error(`DownstreamConnection '${this.config.name}': not started`)
    }
    const result = await this.client.callTool({ name, arguments: args })
    return result as CallToolResult
  }

  /**
   * Drain all pages of an MCP `tools/list` call. Loops on
   * `nextCursor` until the downstream stops returning one,
   * accumulating tools across pages. Exposed so probes can drive
   * the pagination logic directly with a fake `listTools`
   * callable rather than spinning up a real subprocess.
   *
   * Throws after 1000 pages — a hard ceiling against a misbehaving
   * downstream that returns a non-empty `nextCursor` forever.
   */
  /**
   * Close the transport and let the child process exit. Idempotent.
   *
   * Gates on `this.transport` rather than `this.started` so we still
   * clean up after a partial-start failure: e.g., `client.connect()`
   * succeeded (the child process is alive and the transport is wired)
   * but `client.listTools()` threw before we could flip `started =
   * true`. Pre-Codex this branch returned early and the child
   * downstream MCP server stayed running indefinitely after the
   * proxy's startup rollback called us.
   */
  async stop(): Promise<void> {
    if (this.transport === undefined) return
    try {
      await this.transport.close()
    } finally {
      this.started = false
      this.client = undefined
      this.transport = undefined
    }
  }
}

/**
 * Drain all pages of an MCP `tools/list` call.
 *
 * `listToolsFn` is the SDK client's `listTools` method (or any
 * compatible callable for tests). The function calls it repeatedly
 * with the previous page's `nextCursor` until the downstream stops
 * returning one. Tools accumulate across pages in the order they
 * arrive.
 *
 * Throws after `maxPages` (default 1000) — a hard ceiling against a
 * misbehaving downstream that returns a non-empty `nextCursor`
 * forever. The cap is well past any real catalog; if a downstream
 * hits it, the operator wants to hear about it loudly rather than
 * have the proxy spin.
 */
export async function collectPaginatedTools(
  listToolsFn: (
    params?: { cursor?: string },
  ) => Promise<{ tools: MCPTool[]; nextCursor?: string }>,
  downstreamLabel: string,
  maxPages = 1000,
): Promise<MCPTool[]> {
  const allTools: MCPTool[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const params = cursor !== undefined ? { cursor } : undefined
    const page = await listToolsFn(params)
    allTools.push(...page.tools)
    cursor = page.nextCursor
    pages += 1
    if (pages >= maxPages) {
      throw new Error(
        `DownstreamConnection '${downstreamLabel}': tools/list returned ` +
          `${maxPages} pages without exhausting nextCursor; aborting to ` +
          `avoid an infinite loop. The downstream is likely misbehaving.`,
      )
    }
  } while (cursor !== undefined)
  return allTools
}
