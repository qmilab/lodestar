#!/usr/bin/env bun
/**
 * Smoke check for the dev-tools MCP server. Spawns it over stdio against a
 * throwaway git workspace, lists its tools, and exercises all three:
 * `shell_test` (runs a trivial passing test), `git_commit` (commits the
 * workspace), and `git_push` (the governed no-op). Mirrors guard-mcp's
 * `spike.ts`; exercises no Lodestar code.
 *
 *   bun run examples/telenotes-governed-dev/dev-tools-mcp/smoke.ts
 *
 * Exit 0 on success, 1 on any failed expectation.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const here = import.meta.dirname
const workspace = mkdtempSync(join(tmpdir(), "telenotes-devtools-smoke-"))

// A tiny self-contained workspace: a passing test + a git repo to commit into.
writeFileSync(
  join(workspace, "smoke.test.ts"),
  'import { expect, test } from "bun:test"\ntest("smoke", () => expect(1 + 1).toBe(2))\n',
  "utf8",
)
writeFileSync(join(workspace, "package.json"), '{ "name": "smoke", "private": true }\n', "utf8")
await Bun.spawn(["git", "init", "-q"], { cwd: workspace }).exited

const failures: string[] = []
function check(label: string, ok: boolean): void {
  if (!ok) failures.push(label)
  process.stderr.write(`[smoke] ${ok ? "ok  " : "FAIL"} ${label}\n`)
}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", join(here, "bin.ts"), workspace],
})
const client = new Client({ name: "telenotes-devtools-smoke", version: "0.1.0" })
await client.connect(transport)

try {
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name).sort()
  check(
    `lists shell_test, git_commit, git_push (got: ${names.join(", ")})`,
    ["git_commit", "git_push", "shell_test"].every((n) => names.includes(n)),
  )

  const testResult = await client.callTool({ name: "shell_test", arguments: {} })
  check("shell_test passes on a trivial suite", testResult.isError !== true)

  const commitResult = await client.callTool({
    name: "git_commit",
    arguments: { message: "smoke: initial commit" },
  })
  check("git_commit succeeds", commitResult.isError !== true)

  const pushResult = await client.callTool({
    name: "git_push",
    arguments: { branch: "demo" },
  })
  check("git_push refuses loudly (isError)", pushResult.isError === true)
} finally {
  await transport.close()
}

if (failures.length > 0) {
  process.stderr.write(`[smoke] FAILED: ${failures.length} check(s)\n`)
  process.exit(1)
}
process.stderr.write("[smoke] OK\n")
