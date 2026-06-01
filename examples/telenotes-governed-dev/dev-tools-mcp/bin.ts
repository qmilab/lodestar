#!/usr/bin/env bun
/**
 * stdio entry point for the Telenotes dev-tools MCP server. The Lodestar
 * MCP proxy spawns this as a downstream child process:
 *
 *   bun run examples/telenotes-governed-dev/dev-tools-mcp/bin.ts <workspace>
 *
 * The single positional argument is the path to the workspace the tools
 * operate on (the throwaway copy of the Telenotes fixture). stdout is the MCP
 * protocol channel — all logging goes to stderr.
 */

import { resolve } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildDevToolsServer } from "./server.js"

const workspaceArg = process.argv[2]
if (workspaceArg === undefined || workspaceArg === "") {
  process.stderr.write("usage: bun run dev-tools-mcp/bin.ts <workspace>\n")
  process.exit(2)
}

const workspace = resolve(workspaceArg)
const server = buildDevToolsServer(workspace)
const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[telenotes-dev-tools] connected; workspace=${workspace}\n`)
