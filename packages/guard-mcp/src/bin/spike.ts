#!/usr/bin/env bun
/**
 * Protocol verification spike. Spawns a real downstream MCP server
 * (the official `@modelcontextprotocol/server-filesystem`), lists
 * its tools, calls `list_directory`, prints the result, and exits.
 *
 * The point of this file is to confirm that the proxy's mental model
 * of MCP — stdio transport, initialize handshake, tools/list and
 * tools/call request shapes — is correct on the local install. It
 * does NOT exercise any Lodestar code; that's `examples/claude-code-
 * wrapped/` and the two new probes.
 *
 * Run with:
 *
 *   bun run --filter @qmilab/lodestar-guard-mcp spike
 *
 * If this prints a list of tools and the result of one call, the
 * downstream side of the proxy is working. If it errors at the
 * handshake, the SDK install or the downstream server binary is
 * the problem.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

async function main(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "lodestar-mcp-spike-"))
  writeFileSync(join(sandbox, "hello.txt"), "hello from the spike\n", "utf8")

  process.stderr.write(`[spike] sandbox=${sandbox}\n`)
  process.stderr.write("[spike] spawning @modelcontextprotocol/server-filesystem via npx\n")
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", sandbox],
  })

  const client = new Client({ name: "lodestar-mcp-spike", version: "0.1.5" })
  await client.connect(transport)
  process.stderr.write("[spike] connected; listing tools\n")

  const tools = await client.listTools()
  process.stderr.write(`[spike] discovered ${tools.tools.length} tools:\n`)
  for (const t of tools.tools) {
    process.stderr.write(`  - ${t.name}: ${t.description ?? "(no description)"}\n`)
  }

  // Find a "list_directory"-like tool; the canonical
  // @modelcontextprotocol/server-filesystem advertises this name.
  const lister = tools.tools.find((t) => t.name === "list_directory") ?? tools.tools[0]
  if (lister === undefined) {
    process.stderr.write("[spike] no tools advertised; aborting\n")
    await transport.close()
    process.exitCode = 2
    return
  }
  process.stderr.write(`[spike] calling ${lister.name}\n`)
  const result = await client.callTool({
    name: lister.name,
    arguments: { path: sandbox },
  })
  process.stderr.write(`[spike] result.isError=${String(result.isError ?? false)}\n`)
  process.stderr.write(`[spike] result.content=${JSON.stringify(result.content)}\n`)

  await transport.close()
  process.stderr.write("[spike] done\n")
}

main().catch((err) => {
  process.stderr.write(
    `[spike] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exitCode = 1
})
