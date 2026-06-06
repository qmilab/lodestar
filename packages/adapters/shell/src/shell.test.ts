import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@qmilab/lodestar-action-kernel"
import { bunTest } from "./presets.js"
import { type ShellCommandSpec, defineShellTool } from "./shell.js"

const ctx: ToolContext = {
  session_id: "test-session",
  project_id: "test-project",
  actor_id: "test-actor",
  capabilities: new Map(),
}

const workspace = mkdtempSync(join(tmpdir(), "lodestar-shell-test-ws-"))
const PATH = process.env.PATH ?? ""

const passthrough: Omit<ShellCommandSpec, "name" | "bin"> = {
  argsMatcher: (a) => a,
  trust: 3,
  reversibility: "reversible",
}

describe("scoped env isolation", () => {
  test("a host process.env var does NOT reach the subprocess", async () => {
    process.env.LODESTAR_SHELL_TEST_SECRET = "host-secret-should-not-leak"
    const tool = defineShellTool(
      { name: "shell.envcheck", bin: "printenv", ...passthrough },
      { workspaceRoot: workspace, env: { PATH } },
    )
    const out = await tool.execute({ args: ["LODESTAR_SHELL_TEST_SECRET"] }, ctx)
    expect(out.stdout).not.toContain("host-secret-should-not-leak")
    // printenv exits non-zero when the variable is unset.
    expect(out.exit_code).not.toBe(0)
  })

  test("a var declared in the scoped env IS visible (positive control)", async () => {
    const tool = defineShellTool(
      { name: "shell.envcheck2", bin: "printenv", ...passthrough },
      { workspaceRoot: workspace, env: { PATH, LODESTAR_SCOPED_OK: "scoped-yes" } },
    )
    const out = await tool.execute({ args: ["LODESTAR_SCOPED_OK"] }, ctx)
    expect(out.exit_code).toBe(0)
    expect(out.stdout.trim()).toBe("scoped-yes")
  })
})

describe("wall-clock timeout", () => {
  test("a long command is killed at the deadline and reports timed_out", async () => {
    const tool = defineShellTool(
      { name: "shell.sleeper", bin: "sleep", ...passthrough, timeoutMs: 200 },
      { workspaceRoot: workspace, env: { PATH } },
    )
    const out = await tool.execute({ args: ["5"] }, ctx)
    expect(out.timed_out).toBe(true)
    expect(out.duration_ms).toBeLessThan(4000)
  })
})

describe("bounded output capture", () => {
  test("output beyond maxOutputBytes is truncated and flagged", async () => {
    const tool = defineShellTool(
      { name: "shell.flood", bin: "bun", ...passthrough },
      { workspaceRoot: workspace, env: { PATH }, maxOutputBytes: 1000 },
    )
    const out = await tool.execute({ args: ["-e", "process.stdout.write('x'.repeat(5000))"] }, ctx)
    expect(out.stdout_truncated).toBe(true)
    expect(out.stdout.length).toBeLessThanOrEqual(1000)
  })
})

describe("argsMatcher allowlist", () => {
  test("the bunTest preset rejects args outside `test [-t <pattern>]`", async () => {
    const tool = defineShellTool(bunTest(), { workspaceRoot: workspace, env: { PATH } })
    // Rejection happens inside execute (the matcher throws) before any spawn.
    await expect(tool.execute({ args: ["--evil"] }, ctx)).rejects.toThrow(/only `bun test`/)
  })

  test("the bunTest preset accepts the empty and -t shapes", () => {
    const spec = bunTest()
    expect(spec.argsMatcher([])).toEqual(["test"])
    expect(spec.argsMatcher(["-t", "publish"])).toEqual(["test", "-t", "publish"])
  })
})
