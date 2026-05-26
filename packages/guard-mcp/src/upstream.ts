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
 * Lifetime is owned by `MCPProxy`. Subclasses can override `start()`
 * / `stop()` for in-process testing (see `NoOpUpstreamServer` used by
 * the probes and the wrapped example); production paths use the
 * stdio transport set up here.
 */
export class UpstreamServer {
  private server?: Server
  private transport?: StdioServerTransport
  private started = false
  /**
   * Resolves when the upstream transport closes — either because the
   * wrapped agent disconnected (stdio closed) or because `stop()`
   * was called. Resolving is idempotent.
   *
   * `MCPProxy.waitUntilClosed()` exposes this so the CLI can block
   * on it after `start()`; without that wait, the CLI would exit
   * right after startup and the wrapped agent would lose its server
   * before listing or calling a single tool.
   */
  private closeResolver: () => void = () => {}
  protected readonly closePromise: Promise<void>

  constructor(
    /** Tool definitions to advertise to the wrapped agent, names already namespaced. */
    private readonly tools: MCPTool[],
    /** Delegate for `tools/call` requests. */
    private readonly handler: UpstreamCallToolHandler,
    /** Server identity reported in the MCP handshake. */
    private readonly serverInfo: { name: string; version: string },
  ) {
    this.closePromise = new Promise<void>((resolve) => {
      this.closeResolver = resolve
    })
  }

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
    // Wire the transport's close signal to our resolver so callers
    // awaiting `waitUntilClosed()` unblock when the wrapped agent
    // hangs up its end of stdin/stdout. The Protocol base class
    // (which `Server` extends) also exposes its own `onclose`; we
    // attach to the transport directly so we capture the signal
    // even if the SDK's internal handler chain changes.
    this.transport.onclose = () => this.closeResolver()
    await this.server.connect(this.transport)
    this.started = true
  }

  /**
   * Resolves when the upstream transport has closed (or `stop()`
   * has been called). Safe to call before `start()` — in that case
   * the promise resolves only once `stop()` runs.
   *
   * `NoOpUpstreamServer` (the no-stdio variant used by probes /
   * examples) overrides `start()` and `stop()` to be no-ops, so its
   * `closePromise` only resolves if the override explicitly does so.
   * That's fine: probes/examples drive the proxy in-process and
   * never wait on `waitUntilClosed`.
   */
  waitUntilClosed(): Promise<void> {
    return this.closePromise
  }

  async stop(): Promise<void> {
    if (!this.started) {
      // Even if we never started, resolve the close promise so any
      // caller awaiting it does not hang. Idempotent across repeats.
      this.closeResolver()
      return
    }
    try {
      await this.server?.close()
    } finally {
      this.started = false
      this.server = undefined
      this.transport = undefined
      this.closeResolver()
    }
  }
}
