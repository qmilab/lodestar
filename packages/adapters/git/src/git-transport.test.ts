import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCredential } from "./credentials.js"
import { applyRedactions, baseGitEnv, redactUrl } from "./run.js"
import { makeGitCloneTool, makeGitCommitTool, makeGitPushTool } from "./transport.js"

// A ToolContext stand-in (the transport tools ignore it).
const CTX = { session_id: "s", project_id: "p", actor_id: "a", capabilities: new Map() }

// process.env requires `delete`: assigning `undefined` coerces to the literal
// string "undefined" (which git would then read as a real value).
function unsetEnv(key: string): void {
  delete process.env[key]
}

// git for test setup only: host config disabled, identity + hooks pinned so it
// works regardless of the host environment.
function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test Setup",
      "-c",
      "user.email=setup@test.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  )
}

interface Repos {
  workRepo: string
  bareRemote: string
  cloneRoot: string
}

const created: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}

/** A work repo on branch `main` with one commit, plus an empty bare "remote". */
function makeRepos(): Repos {
  const workRepo = tmp("lodestar-git-work-")
  const bareRemote = tmp("lodestar-git-remote-")
  const cloneRoot = tmp("lodestar-git-cloneroot-")
  git(bareRemote, ["init", "--bare", "-q"])
  // Pin the bare remote's default branch to `main` so a later clone checks it out
  // regardless of the host git's init.defaultBranch (CI defaults to `master`).
  git(bareRemote, ["symbolic-ref", "HEAD", "refs/heads/main"])
  git(workRepo, ["init", "-q"])
  writeFileSync(join(workRepo, "README.md"), "# fixture\n")
  git(workRepo, ["add", "-A"])
  git(workRepo, ["commit", "-q", "-m", "initial"])
  git(workRepo, ["branch", "-M", "main"])
  return { workRepo, bareRemote, cloneRoot }
}

afterEach(() => {
  for (const d of created.splice(0)) {
    try {
      execFileSync("rm", ["-rf", d])
    } catch {
      /* best effort */
    }
  }
})

describe("redaction helpers", () => {
  test("applyRedactions replaces every occurrence; passes through when none", () => {
    expect(applyRedactions("a TKN b TKN c", ["TKN"])).toBe("a *** b *** c")
    expect(applyRedactions("unchanged", undefined)).toBe("unchanged")
    expect(applyRedactions("unchanged", [])).toBe("unchanged")
  })

  test("redactUrl strips embedded credentials only", () => {
    expect(redactUrl("https://user:pat@github.com/o/r.git")).toBe("https://***@github.com/o/r.git")
    expect(redactUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git")
  })
})

describe("baseGitEnv", () => {
  test("excludes host vars and neutralises git config", () => {
    process.env.LODESTAR_GIT_TEST_SECRET = "must-not-leak"
    try {
      const env = baseGitEnv()
      expect(env.LODESTAR_GIT_TEST_SECRET).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
      expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null")
      expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    } finally {
      unsetEnv("LODESTAR_GIT_TEST_SECRET")
    }
  })
})

describe("credential model", () => {
  test("https-token: token flows via askpass env, never argv; redacted; resolver works", async () => {
    const dir = tmp("lodestar-git-cred-")
    const prepared = prepareCredential(
      { kind: "https-token", token: "SUPER-SECRET-TOKEN", username: "octo" },
      dir,
    )
    expect(prepared.baseEnv.GIT_ASKPASS).toBeDefined()
    const askpass = prepared.baseEnv.GIT_ASKPASS as string
    expect(existsSync(askpass)).toBe(true)

    const resolved = await prepared.resolve()
    expect(resolved.env.LODESTAR_GIT_USERNAME).toBe("octo")
    expect(resolved.env.LODESTAR_GIT_PASSWORD).toBe("SUPER-SECRET-TOKEN")
    expect(resolved.redactions).toContain("SUPER-SECRET-TOKEN")

    // The askpass helper echoes the credential from the env — proving the token
    // reaches git through the environment, not the command line.
    const env = { PATH: process.env.PATH ?? "", ...resolved.env }
    const pass = execFileSync("sh", [askpass, "Password for 'https://x':"], {
      env,
      encoding: "utf8",
    })
    expect(pass).toBe("SUPER-SECRET-TOKEN")
    const user = execFileSync("sh", [askpass, "Username for 'https://x':"], {
      env,
      encoding: "utf8",
    })
    expect(user).toBe("octo")
  })

  test("https-token: a function token is resolved per call (fetch at use time)", async () => {
    const dir = tmp("lodestar-git-cred-")
    let calls = 0
    const prepared = prepareCredential(
      {
        kind: "https-token",
        token: () => {
          calls++
          return "DYNAMIC"
        },
      },
      dir,
    )
    const r1 = await prepared.resolve()
    expect(r1.env.LODESTAR_GIT_PASSWORD).toBe("DYNAMIC")
    expect(r1.env.LODESTAR_GIT_USERNAME).toBe("x-access-token")
    await prepared.resolve()
    expect(calls).toBe(2)
  })
})

describe("git.commit", () => {
  test("commits staged changes with a pinned identity and reports the sha", async () => {
    const { workRepo } = makeRepos()
    writeFileSync(join(workRepo, "feature.ts"), "export const x = 1\n")
    const tool = makeGitCommitTool({ workspaceRoot: workRepo })
    const out = await tool.execute({ message: "add feature" }, CTX)
    expect(out.committed).toBe(true)
    expect(out.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(out.branch).toBe("main")
    expect(out.files_changed).toBe(1)
    const author = git(workRepo, ["log", "-1", "--format=%an"]).trim()
    expect(author).toBe("Lodestar Agent")
  })

  test("nothing to commit reports committed:false without throwing", async () => {
    const { workRepo } = makeRepos()
    const tool = makeGitCommitTool({ workspaceRoot: workRepo })
    const out = await tool.execute({ message: "noop" }, CTX)
    expect(out.committed).toBe(false)
    expect(out.sha).toBe("")
  })

  test("host author env does NOT leak through the scoped env", async () => {
    const { workRepo } = makeRepos()
    process.env.GIT_AUTHOR_NAME = "HOST_LEAK"
    process.env.GIT_COMMITTER_NAME = "HOST_LEAK"
    try {
      writeFileSync(join(workRepo, "iso.ts"), "export const y = 2\n")
      const out = await makeGitCommitTool({ workspaceRoot: workRepo }).execute(
        { message: "isolation" },
        CTX,
      )
      expect(out.committed).toBe(true)
      // GIT_AUTHOR_NAME (env) overrides -c user.name in git — so if the host env
      // leaked into the subprocess, the author would be HOST_LEAK. It must not.
      const author = git(workRepo, ["log", "-1", "--format=%an"]).trim()
      expect(author).toBe("Lodestar Agent")
    } finally {
      unsetEnv("GIT_AUTHOR_NAME")
      unsetEnv("GIT_COMMITTER_NAME")
    }
  })
})

describe("git.push", () => {
  test("pushes to the operator-pinned URL, bypassing a poisoned .git/config", async () => {
    const { workRepo, bareRemote } = makeRepos()
    // Poison the workspace's own remote config to an unreachable decoy.
    git(workRepo, ["remote", "add", "origin", "https://decoy.invalid/should-never-be-used.git"])

    const tool = makeGitPushTool({
      workspaceRoot: workRepo,
      remotes: { origin: bareRemote }, // pinned to the real (local) remote
      credential: { kind: "none" },
    })
    const out = await tool.execute({}, CTX)
    expect(out.pushed).toBe(true)
    expect(out.branch).toBe("main")
    expect(out.updated_refs.some((r) => r.includes("refs/heads/main"))).toBe(true)

    // The ref landed in the PINNED remote — proving the decoy origin was bypassed
    // (the push succeeded entirely offline against the local bare repo).
    const remoteSha = git(bareRemote, ["rev-parse", "refs/heads/main"]).trim()
    const localSha = git(workRepo, ["rev-parse", "HEAD"]).trim()
    expect(remoteSha).toBe(localSha)
  })

  test("rejects a remote name the operator did not pin", async () => {
    const { workRepo, bareRemote } = makeRepos()
    const tool = makeGitPushTool({
      workspaceRoot: workRepo,
      remotes: { origin: bareRemote },
      credential: { kind: "none" },
    })
    await expect(tool.execute({ remote: "upstream" }, CTX)).rejects.toThrow(
      /not in the operator-pinned remotes/,
    )
  })

  test("the credential token never appears in the tool output", async () => {
    const { workRepo, bareRemote } = makeRepos()
    const TOKEN = "ghp_PROBE_TOKEN_should_never_surface"
    const tool = makeGitPushTool({
      workspaceRoot: workRepo,
      remotes: { origin: bareRemote },
      credential: { kind: "https-token", token: TOKEN },
    })
    const out = await tool.execute({}, CTX)
    expect(JSON.stringify(out)).not.toContain(TOKEN)
  })
})

describe("git.clone", () => {
  test("clones an allowlisted source into a confined destination", async () => {
    const { bareRemote, cloneRoot, workRepo } = makeRepos()
    // Seed the bare remote with a branch so there is something to clone.
    git(workRepo, ["remote", "add", "r", bareRemote])
    git(workRepo, ["push", "-q", "r", "main"])

    const tool = makeGitCloneTool({
      cloneRoot,
      allowSource: (url) => url === bareRemote,
    })
    const out = await tool.execute({ url: bareRemote, destination: "copy" }, CTX)
    expect(out.cloned).toBe(true)
    expect(out.destination).toBe("copy")
    expect(out.head_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(cloneRoot, "copy", "README.md"))).toBe(true)
  })

  test("rejects a source not on the allowlist", async () => {
    const { cloneRoot, bareRemote } = makeRepos()
    const tool = makeGitCloneTool({
      cloneRoot,
      allowSource: (url) => url === bareRemote,
    })
    await expect(
      tool.execute({ url: "https://evil.invalid/x.git", destination: "evil" }, CTX),
    ).rejects.toThrow(/not permitted by the operator source allowlist/)
    expect(readdirSync(cloneRoot).length).toBe(0)
  })

  test("rejects a destination that escapes the clone root", async () => {
    const { cloneRoot, bareRemote } = makeRepos()
    const tool = makeGitCloneTool({ cloneRoot, allowSource: () => true })
    await expect(tool.execute({ url: bareRemote, destination: "../escape" }, CTX)).rejects.toThrow(
      /escapes the clone root/,
    )
    await expect(tool.execute({ url: bareRemote, destination: "/tmp/abs" }, CTX)).rejects.toThrow(
      /must be relative/,
    )
    expect(readdirSync(cloneRoot).length).toBe(0)
  })
})
