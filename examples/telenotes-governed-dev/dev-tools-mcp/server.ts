/**
 * Telenotes dev-tools MCP server.
 *
 * A small, first-party MCP server that exposes the *write-side* developer
 * actions the governed-dev demo needs but the read-only filesystem server
 * does not provide: running the test suite, committing, and pushing.
 *
 * Why a dedicated server (rather than one generic `shell.run`): the proxy's
 * policy gate assigns trust per *tool name*. Distinct tools let the operator
 * auto-approve `shell_test`/`git_commit` (L3) while blocking `git_push` (L4)
 * — the demonstrable teeth of the policy gate. A single shell tool would
 * collapse all three into one trust level.
 *
 * Each tool is allowlisted (no arbitrary command execution), validates its
 * inputs with Zod, runs with a scoped environment (no host-env passthrough
 * beyond PATH/HOME), and pins git identity via `-c` so commits do not depend
 * on the host's global git config. stdout is the MCP protocol channel — all
 * logging goes to stderr.
 *
 * This server is the reusable asset of the Telenotes batch: it finally
 * realizes the write/shell/commit surface `policy.lodestar.ts` has always
 * named, and any wrapped agent (Claude Code, Cursor, Aider) can be pointed
 * at it through the proxy. See CLAUDE.md for its intended graduation path
 * into `packages/adapters/{shell,github}`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const ShellTestInputSchema = z
  .object({
    filter: z.string().min(1).optional(),
  })
  .strict()

const GitCommitInputSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict()

const GitPushInputSchema = z
  .object({
    remote: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  })
  .strict()

/** Tool catalog advertised over `tools/list`. */
const TOOLS: MCPTool[] = [
  {
    name: "shell_test",
    description:
      "Run the project's test suite (`bun test`) in the workspace and report pass/fail. Does not modify source.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional test-name pattern (passed to `bun test -t`).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_commit",
    description: "Stage all changes (`git add -A`) and create a commit in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "git_push",
    description:
      "Push the workspace's commits to a remote. High-trust: irreversible, external blast radius.",
    inputSchema: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name (default: origin)." },
        branch: { type: "string", description: "Branch to push (default: current)." },
      },
      additionalProperties: false,
    },
  },
]

/** Environment variables the spawned tools are allowed to see. */
const ALLOWED_ENV = ["PATH", "HOME"] as const

function scopedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ALLOWED_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: scopedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, output: `${stdout}${stderr}` }
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError }
}

/**
 * Build the dev-tools MCP `Server` bound to a workspace directory. The
 * caller connects it to a transport (see `bin.ts` for the stdio entry).
 */
export function buildDevToolsServer(workspace: string): Server {
  const server = new Server(
    { name: "lodestar-telenotes-dev-tools", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {}
    try {
      switch (req.params.name) {
        case "shell_test": {
          const input = ShellTestInputSchema.parse(args)
          const cmd = ["bun", "test", ...(input.filter ? ["-t", input.filter] : [])]
          const { code, output } = await run(cmd, workspace)
          return textResult(`$ ${cmd.join(" ")}\n${output}`, code !== 0)
        }
        case "git_commit": {
          const input = GitCommitInputSchema.parse(args)
          const add = await run(["git", "add", "-A"], workspace)
          if (add.code !== 0) return textResult(`git add failed:\n${add.output}`, true)
          const commit = await run(
            [
              "git",
              "-c",
              "user.email=lodestar-demo@example.invalid",
              "-c",
              "user.name=Lodestar Demo",
              "commit",
              "-m",
              input.message,
            ],
            workspace,
          )
          if (commit.code !== 0) return textResult(`git commit failed:\n${commit.output}`, true)
          const head = await run(["git", "rev-parse", "HEAD"], workspace)
          return textResult(`committed ${head.output.trim()}\n${commit.output}`)
        }
        case "git_push": {
          const input = GitPushInputSchema.parse(args)
          // Deliberately a no-op: this demo server has no remote. The tool
          // exists so the proxy's policy gate has a genuine L4, irreversible,
          // external-blast-radius action to govern. Under the demo's
          // auto-approve ceiling the call is denied before it ever reaches
          // here; if it is reached directly it must not perform a real push.
          const remote = input.remote ?? "origin"
          const branch = input.branch ?? "(current)"
          return textResult(
            `git_push is a no-op in the Telenotes dev-tools server (no remote configured). Would push ${branch} to ${remote}.`,
          )
        }
        default:
          return textResult(`unknown tool: ${req.params.name}`, true)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return textResult(`dev-tools error: ${message}`, true)
    }
  })

  return server
}
