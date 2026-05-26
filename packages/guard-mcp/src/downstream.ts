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
    // List tools and cache. v0 does not subscribe to tools/list_changed
    // notifications; if a downstream's tool catalog changes after
    // startup, the proxy will not pick it up until restart.
    const list = await this.client.listTools()
    this.tools = list.tools
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
   * Close the transport and let the child process exit. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.started) return
    try {
      await this.transport?.close()
    } finally {
      this.started = false
      this.client = undefined
      this.transport = undefined
    }
  }
}
