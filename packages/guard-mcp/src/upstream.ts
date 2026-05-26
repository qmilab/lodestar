import type { Readable, Writable } from "node:stream"
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
  /** Listener installed on `stdin` so we can detach it in `stop()`. */
  private stdinEndHandler?: () => void

  constructor(
    /** Tool definitions to advertise to the wrapped agent, names already namespaced. */
    private readonly tools: MCPTool[],
    /** Delegate for `tools/call` requests. */
    private readonly handler: UpstreamCallToolHandler,
    /** Server identity reported in the MCP handshake. */
    private readonly serverInfo: { name: string; version: string },
    /**
     * stdin the StdioServerTransport reads from. Defaults to
     * `process.stdin` (production path). Tests inject a `PassThrough`
     * so they can drive EOF without touching the real process
     * stdin, and so multiple proxies can be exercised in one test
     * process without colliding on the singleton.
     */
    private readonly stdin: Readable = process.stdin,
    /**
     * stdout the StdioServerTransport writes to. Defaults to
     * `process.stdout`. Tests inject a `PassThrough`.
     */
    private readonly stdout: Writable = process.stdout,
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
    this.transport = new StdioServerTransport(this.stdin, this.stdout)
    // The SDK's `Server.connect` installs its own `transport.onclose`
    // handler to drive its internal cleanup. If we set
    // `transport.onclose` BEFORE `connect`, the SDK overwrites it and
    // `waitUntilClosed()` never resolves when stdio closes. Two-
    // pronged fix:
    //
    //   1. After `connect`, wrap the SDK's `transport.onclose`. The
    //      wrapper runs the SDK's handler first (so its cleanup runs)
    //      and then resolves our close promise.
    //   2. Also set `server.onclose` (the Protocol base class's
    //      documented hook). On most SDK versions this is the path
    //      the transport handler ends up calling; on the rest, the
    //      wrapped transport handler covers us. Both paths resolve
    //      the same idempotent promise, so double-resolve is fine.
    await this.server.connect(this.transport)
    const sdkInstalledOnClose = this.transport.onclose
    this.transport.onclose = () => {
      try {
        sdkInstalledOnClose?.()
      } finally {
        this.closeResolver()
      }
    }
    this.server.onclose = () => this.closeResolver()
    // Codex round 6: the SDK's StdioServerTransport does NOT fire
    // `onclose` when stdin EOFs naturally — it only fires on
    // explicit `transport.close()`. When the parent MCP client
    // (Claude Code, Cursor, Aider) ends its end of the pipe,
    // `waitUntilClosed()` would hang forever without this listener
    // and the proxy CLI would never reach `stop()`, leaving every
    // downstream child process alive after the wrapped agent exits.
    //
    // Listen on the same stdin we passed to the transport for both
    // 'end' (no more data) and 'close' (file descriptor closed).
    // Resolving our close promise unblocks the CLI's
    // `await proxy.waitUntilClosed()` so cleanup proceeds.
    this.stdinEndHandler = () => this.closeResolver()
    this.stdin.once("end", this.stdinEndHandler)
    this.stdin.once("close", this.stdinEndHandler)
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
      // Detach the stdin listeners we installed in start(). Without
      // this, tests that construct multiple proxies sequentially
      // would leak handlers on the shared `process.stdin` singleton.
      if (this.stdinEndHandler !== undefined) {
        this.stdin.off("end", this.stdinEndHandler)
        this.stdin.off("close", this.stdinEndHandler)
        this.stdinEndHandler = undefined
      }
      this.started = false
      this.server = undefined
      this.transport = undefined
      this.closeResolver()
    }
  }
}
