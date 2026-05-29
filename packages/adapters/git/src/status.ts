import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { type Tool, registerTool } from "@qmilab/lodestar-action-kernel"
import { registry } from "@qmilab/lodestar-core"
import { z } from "zod"

/**
 * git.status — get the status of a git repository.
 *
 * Trust: L0 (observation only).
 * Sandbox: read.
 *
 * v0 implementation shells out via node:child_process. v0.2 will replace
 * this with a library-based implementation (e.g. isomorphic-git) for
 * sandboxing.
 */

export const GitStatusOutputSchema = z
  .object({
    branch: z.string(),
    dirty: z.array(z.string()).describe("modified or untracked files"),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    detached: z.boolean(),
  })
  .describe("git.status tool output")

registry.register("git.status@1", GitStatusOutputSchema)

const GitStatusInputSchema = z.object({
  repo: z.string().describe("path to repo (must be the project root or below)"),
})

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runGit(repoPath: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolveFn, rejectFn) => {
    const proc = spawn("git", ["-C", repoPath, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    proc.on("close", (code) => {
      resolveFn({ stdout, stderr, exitCode: code ?? 0 })
    })
    proc.on("error", rejectFn)
  })
}

export function makeGitStatusTool(
  projectRoot: string,
): Tool<z.infer<typeof GitStatusInputSchema>, z.infer<typeof GitStatusOutputSchema>> {
  const root = resolve(projectRoot)
  return {
    name: "git.status",
    inputs: GitStatusInputSchema,
    output_schema_key: "git.status@1",
    effects: [],
    reversibility: "reversible",
    permissions: ["fs.read"],
    required_trust_level: 0,
    sandbox: "read",
    preconditions: () => [],
    execute: async (inputs) => {
      const repoPath = resolve(root, inputs.repo)
      if (!repoPath.startsWith(root)) {
        throw new Error(`git.status: repo '${inputs.repo}' is outside project root`)
      }

      const branchRes = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])
      if (branchRes.exitCode !== 0) {
        throw new Error(
          `git.status: failed to read branch in '${inputs.repo}': ${branchRes.stderr.trim()}`,
        )
      }
      const branchOut = branchRes.stdout.trim()
      const detached = branchOut === "HEAD"
      const branch = detached ? "" : branchOut

      const statusRes = await runGit(repoPath, ["status", "--porcelain=v1"])
      const dirty = statusRes.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.slice(3))

      let ahead = 0
      let behind = 0
      if (!detached) {
        const counts = await runGit(repoPath, [
          "rev-list",
          "--left-right",
          "--count",
          `origin/${branch}...${branch}`,
        ])
        if (counts.exitCode === 0) {
          const parts = counts.stdout.trim().split(/\s+/).map(Number)
          if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
            behind = parts[0]
            ahead = parts[1]
          }
        }
      }

      return { branch, dirty, ahead, behind, detached }
    },
  }
}

export function registerGitStatusTool(projectRoot: string): void {
  registerTool(makeGitStatusTool(projectRoot))
}
