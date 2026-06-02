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
 * Each tool runs a fixed binary (`bun` / `git`) with a fixed argv shape via
 * `Bun.spawn` (an argv array, never a shell string), so tool inputs cannot
 * inject extra commands or arguments; inputs are Zod-validated. Note the
 * boundary this does NOT claim: `shell_test` runs the workspace's *own* test
 * suite, so it executes whatever test code lives in the workspace — it is an
 * audit/governance boundary, not an OS sandbox against the code under test
 * (OS-level sandboxing is deferred; see `docs/roadmap.md`). git runs with hooks
 * and host config disabled so the workspace cannot smuggle code execution
 * through a git hook or a planted `~/.gitconfig`. Spawned processes inherit
 * only `PATH` (HOME is a fresh empty dir); stdout is the MCP protocol channel
 * — all logging goes to stderr.
 *
 * This server is the reusable asset of the Telenotes batch: it finally
 * realizes the write/shell/commit surface `policy.lodestar.ts` has always
 * named, and any wrapped agent (Claude Code, Cursor, Aider) can be pointed
 * at it through the proxy. See CLAUDE.md for its intended graduation path
 * into `packages/adapters/{shell,github}`.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

/**
 * The environment spawned tools see. Only `PATH` is inherited from the host;
 * `HOME` is a fresh empty directory so git/bun read no host dotfiles, and git's
 * global/system config are neutralised outright — so an attacker-controlled
 * `~/.gitconfig` or `/etc/gitconfig` (hook paths, includes, filters, credential
 * helpers) cannot influence the git commands this server runs. Mirrors the
 * Action Kernel's "no host env to sandboxes" rule.
 */
function scopedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  }
  const path = process.env.PATH
  if (path !== undefined) env.PATH = path
  return env
}

async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
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
  // A fresh, empty HOME for every spawned subprocess — no host dotfiles leak in.
  const env = scopedEnv(mkdtempSync(join(tmpdir(), "telenotes-devtools-home-")))

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
          const { code, output } = await run(cmd, workspace, env)
          return textResult(`$ ${cmd.join(" ")}\n${output}`, code !== 0)
        }
        case "git_commit": {
          const input = GitCommitInputSchema.parse(args)
          const add = await run(["git", "add", "-A"], workspace, env)
          if (add.code !== 0) return textResult(`git add failed:\n${add.output}`, true)
          const commit = await run(
            [
              "git",
              // Disable repo hooks so the workspace cannot smuggle code
              // execution through .git/hooks; pin identity so the commit does
              // not depend on (now-disabled) host config.
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "user.email=lodestar-demo@example.invalid",
              "-c",
              "user.name=Lodestar Demo",
              "commit",
              "--no-verify",
              "-m",
              input.message,
            ],
            workspace,
            env,
          )
          if (commit.code !== 0) return textResult(`git commit failed:\n${commit.output}`, true)
          const head = await run(["git", "rev-parse", "HEAD"], workspace, env)
          return textResult(`committed ${head.output.trim()}\n${commit.output}`)
        }
        case "git_push": {
          const input = GitPushInputSchema.parse(args)
          // This demo server has no remote and never pushes. git_push exists
          // only so the proxy's policy gate has a genuine L4, irreversible,
          // external-blast-radius action to govern; under the demo ceiling the
          // call is denied before it reaches here. If it IS reached (called
          // directly, or mis-declared below L4), refuse loudly with
          // isError:true rather than returning a success-shaped no-op that
          // would mask the misconfiguration.
          const remote = input.remote ?? "origin"
          const branch = input.branch ?? "(current)"
          return textResult(
            `git_push refused: the Telenotes dev-tools server has no remote and never pushes (would have targeted ${branch} → ${remote}). This tool exists only to be governed at L4; reaching its implementation means it was not blocked by policy.`,
            true,
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
