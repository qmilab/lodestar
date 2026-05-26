import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResultLike } from "./policy-result.js"

/**
 * Handler the upstream face delegates `tools/call` requests to.
 * Returns the result the wrapped agent should see — either a real
 * downstream CallToolResult (forwarded through the kernel) or a
 * synthetic policy_denied result.
 */
export type UpstreamCallToolHandler = (req: {
  name: string
  arguments: Record<string, unknown>
}) => Promise<CallToolResultLike>

/**
 * The MCP server that the wrapped agent (Claude Code, Cursor,
 * Aider, ...) talks to. Speaks stdio. Aggregates the tools from all
 * downstream connections and forwards every `tools/call` through the
 * provided handler (which threads the call through the Action Kernel
 * before forwarding to the appropriate downstream).
 *
 * Lifetime is owned by `MCPProxy`.
 */
export class UpstreamServer {
  private server?: Server
  private transport?: StdioServerTransport
  private started = false

  constructor(
    /** Tool definitions to advertise to the wrapped agent, names already namespaced. */
    private readonly tools: MCPTool[],
    /** Delegate for `tools/call` requests. */
    private readonly handler: UpstreamCallToolHandler,
    /** Server identity reported in the MCP handshake. */
    private readonly serverInfo: { name: string; version: string },
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("UpstreamServer: already started")
    }
    this.server = new Server(this.serverInfo, {
      capabilities: {
        tools: {
          // v0 freezes the tool catalog at startup. If a future
          // version of the proxy supports downstream tools/list_changed
          // notifications, this flips to true and the proxy will
          // re-emit notifications/tools/list_changed upstream.
          listChanged: false,
        },
      },
    })
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.tools }
    })
    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>
      const result = await this.handler({ name: req.params.name, arguments: args })
      return result
    })
    this.transport = new StdioServerTransport()
    await this.server.connect(this.transport)
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    try {
      await this.server?.close()
    } finally {
      this.started = false
      this.server = undefined
      this.transport = undefined
    }
  }
}
